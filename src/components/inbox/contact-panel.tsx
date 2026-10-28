import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, Copy, Hourglass, Tag, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { aidwar } from "@/integrations/aidwar/client";
import { OPT_IN_LABELS, type OptInStatus } from "@/lib/contacts";
import { languageLabel } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { ContactAvatar } from "./contact-avatar";
import {
  DAY_MS,
  contactLabel,
  relativeTime,
  withinWindow,
  type ConversationRow,
  type MemberRow,
  type MessageRow,
} from "./inbox-utils";

/**
 * The contact's labels, read for this panel only; a failed read (or a
 * workspace without tags) shows none. Reloads when the composer adds some.
 */
function useContactTags(organizationId: string | null, contactId: string | null) {
  const [tags, setTags] = useState<string[] | null>(null);
  const load = useCallback(async () => {
    if (!organizationId || !contactId) return setTags([]);
    try {
      const { data, error } = await aidwar
        .from("contact_tags")
        .select("tag_id, tags(id, name)")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId);
      if (error) return setTags([]);
      const names = (
        (data ?? []) as Array<{ tags: { name: string } | Array<{ name: string }> | null }>
      )
        .map((r) => (Array.isArray(r.tags) ? r.tags[0]?.name : r.tags?.name))
        .filter((n): n is string => Boolean(n));
      setTags(names);
    } catch {
      setTags([]);
    }
  }, [organizationId, contactId]);
  useEffect(() => {
    setTags(null);
    void load();
    const again = () => void load();
    window.addEventListener("aidwar:contact-tags-changed", again);
    return () => window.removeEventListener("aidwar:contact-tags-changed", again);
  }, [load]);
  return tags;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.75rem_1fr] items-start gap-2 py-1.5 text-[0.8125rem]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border px-5 py-4">
      <h3 className="type-label mb-2 text-faint">{title}</h3>
      {children}
    </section>
  );
}

/** "5m ago" / "Just now" / "12 Oct" from relativeTime's short form. */
function ago(iso: string): string {
  const r = relativeTime(iso);
  if (r === "now") return "Just now";
  return /^\d+[mhd]$/.test(r) ? `${r} ago` : r;
}

/** "Open · closes in 5 h" / "Closed" — the 24-hour customer-service window. */
function windowText(lastCustomerMessageAt: string | null): { open: boolean; text: string } {
  if (!withinWindow(lastCustomerMessageAt) || !lastCustomerMessageAt)
    return { open: false, text: "Closed — templates only" };
  const left = new Date(lastCustomerMessageAt).getTime() + DAY_MS - Date.now();
  const hours = Math.floor(left / 3_600_000);
  const minutes = Math.max(1, Math.floor((left % 3_600_000) / 60_000));
  return { open: true, text: `Open · closes in ${hours > 0 ? `${hours} h` : `${minutes} min`}` };
}

/**
 * Batch 39: the right-hand panel beside a chat — who the customer is and where
 * the conversation stands. Display only; every change is made where it was
 * before (assign and close in the chat header, labels from the composer).
 */
export function ContactPanel({
  conversation,
  members,
  messages,
  organizationId,
  numberLabel,
  onClose,
}: {
  conversation: ConversationRow;
  members: MemberRow[];
  messages: MessageRow[];
  organizationId: string | null;
  numberLabel: string | null;
  onClose?: () => void;
}) {
  const label = contactLabel(conversation.contact);
  const tags = useContactTags(organizationId, conversation.contact?.id ?? null);
  const [copied, setCopied] = useState(false);
  const assignee = members.find((m) => m.user_id === conversation.assigned_to) ?? null;
  const optIn = (conversation.contact?.opt_in_status ?? "unknown") as OptInStatus;
  const optInText = OPT_IN_LABELS[optIn] ?? OPT_IN_LABELS.unknown;
  const win = windowText(conversation.last_customer_message_at);
  let language: string | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.direction === "inbound" && m.detected_language) {
      language =
        m.detected_language === "hi-Latn" ? "Hinglish" : languageLabel(m.detected_language);
      break;
    }
  }

  const copyPhone = async () => {
    const phone = conversation.contact?.phone;
    if (!phone) return;
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: nothing to do.
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-[60px] shrink-0 items-center justify-between border-b border-border px-5">
        <h2 className="text-sm font-semibold text-foreground">Contact</h2>
        {onClose ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Hide contact details"
            className="text-muted-foreground"
          >
            <X />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col items-center px-5 pb-5 pt-6 text-center">
          <ContactAvatar
            seed={conversation.contact?.id ?? conversation.id}
            label={label}
            className="h-16 w-16 text-lg"
          />
          <p className="mt-3 max-w-full truncate text-base font-semibold text-foreground">
            {label}
          </p>
          {conversation.contact?.phone ? (
            <button
              type="button"
              onClick={() => void copyPhone()}
              className="group mt-0.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={`Copy ${conversation.contact.phone}`}
            >
              <span className="tabular">{conversation.contact.phone}</span>
              {copied ? (
                <Check className="h-3.5 w-3.5 text-primary" />
              ) : (
                <Copy className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
              )}
            </button>
          ) : null}
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            <Badge
              variant={
                optIn === "opted_in" ? "success" : optIn === "opted_out" ? "danger" : "muted"
              }
              className="rounded-full"
            >
              {optInText}
            </Badge>
            {conversation.needs_human ? (
              <Badge variant="warning" className="rounded-full">
                Waiting for you
              </Badge>
            ) : null}
          </div>
        </div>

        <Section title="Conversation">
          <dl>
            <Row label="Status">
              <span className="capitalize">{conversation.status}</span>
            </Row>
            <Row label="Assigned to">
              {assignee ? (
                assignee.full_name || assignee.email || "Team member"
              ) : (
                <span className="text-muted-foreground">Unassigned</span>
              )}
            </Row>
            <Row label="24-hour window">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5",
                  win.open ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    win.open ? "bg-success" : "bg-border-strong",
                  )}
                  aria-hidden="true"
                />
                {win.text}
              </span>
            </Row>
            {conversation.last_customer_message_at ? (
              <Row label="Last message">{ago(conversation.last_customer_message_at)}</Row>
            ) : null}
            {conversation.needs_human && conversation.needs_human_at ? (
              <Row label="Waiting since">
                <span className="inline-flex items-center gap-1.5">
                  <Hourglass
                    className="h-3.5 w-3.5 text-warning-soft-foreground"
                    aria-hidden="true"
                  />
                  {ago(conversation.needs_human_at)}
                </span>
              </Row>
            ) : null}
            {language ? <Row label="Writes in">{language}</Row> : null}
            {numberLabel ? <Row label="Number">{numberLabel}</Row> : null}
          </dl>
        </Section>

        <Section title="Labels">
          {tags === null ? (
            <div className="flex gap-1.5">
              <Skeleton className="h-5 w-14 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          ) : tags.length ? (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <Badge key={t} variant="secondary" className="rounded-full">
                  <Tag aria-hidden="true" />
                  {t}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No labels yet.</p>
          )}
        </Section>
      </div>
    </div>
  );
}
