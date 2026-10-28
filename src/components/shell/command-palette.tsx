import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CornerDownLeft,
  Keyboard,
  Loader2,
  Megaphone,
  MessageSquareText,
  Monitor,
  Moon,
  Palette,
  PanelLeft,
  Sun,
  UserRound,
} from "lucide-react";
import { Command as CommandPrimitive } from "cmdk";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { aidwar } from "@/integrations/aidwar/client";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";
import { runAppCommand } from "@/lib/app-commands";
import { useThemeChoice } from "@/lib/theme";
import { initials } from "@/components/inbox/inbox-utils";
import { groupNav, type NavItem } from "./use-nav";

type ContactHit = { conversationId: string; name: string | null; phone: string };

/** Characters that would break a PostgREST or() filter are dropped from the search. */
function cleanQuery(q: string): string {
  return q.replace(/[,()*%\\:"']/g, " ").trim();
}

/**
 * Chats whose contact's name or phone matches — the contact's newest
 * conversation. Read-only; nothing is shown when the read fails.
 */
function useConversationSearch(organizationId: string | null, query: string, enabled: boolean) {
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const q = cleanQuery(query);
    if (!enabled || !organizationId || q.length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void Promise.resolve(
        aidwar
          .from("contacts")
          .select("id, name, phone, conversations(id, last_message_at)")
          .eq("organization_id", organizationId)
          .or(`name.ilike.*${q.replace(/\s+/g, "*")}*,phone.ilike.*${q.replace(/\s+/g, "")}*`)
          .limit(8),
      )
        .then(({ data, error }) => {
          if (!live) return;
          setLoading(false);
          if (error) return setHits([]);
          const rows = (data ?? []) as Array<{
            name: string | null;
            phone: string;
            conversations: Array<{ id: string; last_message_at: string | null }> | null;
          }>;
          setHits(
            rows.flatMap((r) => {
              const newest = [...(r.conversations ?? [])].sort((a, b) =>
                String(b.last_message_at ?? "").localeCompare(String(a.last_message_at ?? "")),
              )[0];
              return newest ? [{ conversationId: newest.id, name: r.name, phone: r.phone }] : [];
            }),
          );
        })
        .catch(() => {
          if (live) {
            setLoading(false);
            setHits([]);
          }
        });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [organizationId, query, enabled]);
  return { hits, loading };
}

function Item({
  value,
  onSelect,
  icon,
  children,
  hint,
}: {
  value: string;
  onSelect: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <CommandPrimitive.Item
      value={value}
      onSelect={onSelect}
      className="group flex cursor-pointer select-none items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground outline-none data-[selected=true]:bg-accent"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground group-data-[selected=true]:text-foreground [&_svg]:h-4 [&_svg]:w-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="shrink-0 text-xs text-faint">{hint}</span> : null}
      <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-faint opacity-0 group-data-[selected=true]:opacity-100" aria-hidden="true" />
    </CommandPrimitive.Item>
  );
}

const GROUP_HEADING =
  "px-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[0.6875rem] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-faint";

/**
 * Batch 39: ⌘K / Ctrl+K. Go to any page this person can see, jump to a chat
 * by name or phone, and the common actions — each the same as its button.
 */
export function CommandPalette({
  open,
  onOpenChange,
  items,
  restricted,
  onToggleSidebar,
  onShowShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: NavItem[];
  restricted: boolean;
  onToggleSidebar: () => void;
  onShowShortcuts: () => void;
}) {
  const navigate = useNavigate();
  const { active, isFeatureEnabled } = useOrg();
  const { can } = usePermissions();
  const [, setTheme] = useThemeChoice();
  const [query, setQuery] = useState("");
  const orgId = active?.organization.id ?? null;
  const canInbox = items.some((i) => i.to === "/app/inbox");
  const { hits, loading } = useConversationSearch(orgId, query, open && canInbox);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const go = (to: string) => {
    onOpenChange(false);
    void navigate({ to: to as never });
  };
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  const groups = groupNav(items, restricted);
  const showCampaign = !restricted && items.some((i) => i.to === "/app/campaigns") && can("campaigns.create");
  const showTemplate = !restricted && items.some((i) => i.to === "/app/templates") && can("templates.manage") && isFeatureEnabled("templates");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12vh] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 shadow-2xl data-[state=open]:slide-in-from-top-2 [&>button:last-child]:hidden">
        <DialogTitle className="sr-only">Command menu</DialogTitle>
        <DialogDescription className="sr-only">
          Go to a page, find a conversation by name or phone, or run an action.
        </DialogDescription>
        <CommandPrimitive loop className="flex flex-col">
          <div className="flex items-center gap-3 border-b border-border px-4">
            <CommandPrimitive.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search pages, conversations and actions…"
              className="h-13 w-full bg-transparent text-[0.9375rem] text-foreground outline-none placeholder:text-faint"
            />
            {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-faint" aria-hidden="true" /> : null}
            <Kbd>Esc</Kbd>
          </div>
          <CommandPrimitive.List className="max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain pb-2">
            <CommandPrimitive.Empty className="px-4 py-10 text-center text-sm text-muted-foreground">
              {loading ? "Searching…" : "Nothing matches that."}
            </CommandPrimitive.Empty>

            {hits.length ? (
              <CommandPrimitive.Group heading="Conversations" className={GROUP_HEADING}>
                {hits.map((h) => (
                  <Item
                    key={h.conversationId}
                    value={`conversation ${h.name ?? ""} ${h.phone} ${query}`}
                    icon={<span className="text-[0.625rem] font-semibold">{initials(h.name?.trim() || h.phone)}</span>}
                    hint={h.name ? h.phone : undefined}
                    onSelect={() =>
                      run(() => {
                        runAppCommand({ kind: "open-conversation", id: h.conversationId });
                        void navigate({ to: "/app/inbox", search: { c: h.conversationId } as never });
                      })
                    }
                  >
                    {h.name?.trim() || h.phone}
                  </Item>
                ))}
              </CommandPrimitive.Group>
            ) : null}

            {showCampaign || showTemplate ? (
              <CommandPrimitive.Group heading="Create" className={GROUP_HEADING}>
                {showCampaign ? (
                  <Item
                    value="new campaign create broadcast"
                    icon={<Megaphone />}
                    onSelect={() =>
                      run(() => {
                        runAppCommand({ kind: "new-campaign" });
                        void navigate({ to: "/app/campaigns" as never });
                      })
                    }
                  >
                    New campaign
                  </Item>
                ) : null}
                {showTemplate ? (
                  <Item
                    value="new template create message template"
                    icon={<MessageSquareText />}
                    onSelect={() =>
                      run(() => {
                        runAppCommand({ kind: "new-template" });
                        void navigate({ to: "/app/templates" as never });
                      })
                    }
                  >
                    New template
                  </Item>
                ) : null}
              </CommandPrimitive.Group>
            ) : null}

            <CommandPrimitive.Group heading="Go to" className={GROUP_HEADING}>
              {groups.flatMap((g) =>
                g.items.map((item) => (
                  <Item
                    key={item.to}
                    value={`go ${item.label} ${g.label ?? ""}`}
                    icon={<item.icon />}
                    hint={g.label ?? undefined}
                    onSelect={() => go(item.to)}
                  >
                    {item.label}
                  </Item>
                )),
              )}
            </CommandPrimitive.Group>

            <CommandPrimitive.Group heading="Preferences" className={GROUP_HEADING}>
              <Item value="theme light mode" icon={<Sun />} onSelect={() => run(() => setTheme("light"))}>
                Light theme
              </Item>
              <Item value="theme dark mode night" icon={<Moon />} onSelect={() => run(() => setTheme("dark"))}>
                Dark theme
              </Item>
              <Item value="theme system auto" icon={<Monitor />} onSelect={() => run(() => setTheme("system"))}>
                Match system theme
              </Item>
              <Item value="toggle collapse sidebar" icon={<PanelLeft />} hint="[" onSelect={() => run(onToggleSidebar)}>
                Collapse or expand sidebar
              </Item>
              <Item value="keyboard shortcuts help" icon={<Keyboard />} hint="?" onSelect={() => run(onShowShortcuts)}>
                Keyboard shortcuts
              </Item>
              {!restricted ? (
                <Item value="account profile settings" icon={<UserRound />} onSelect={() => go("/app/settings")}>
                  Account settings
                </Item>
              ) : null}
              <Item value="design system tokens components" icon={<Palette />} onSelect={() => go("/app/design")}>
                Design system
              </Item>
            </CommandPrimitive.Group>
          </CommandPrimitive.List>
          <div className="flex items-center gap-4 border-t border-border bg-subtle px-4 py-2 text-[0.6875rem] text-faint">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> open
            </span>
            <span className="ml-auto">Type a name or phone to find a chat</span>
          </div>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}
