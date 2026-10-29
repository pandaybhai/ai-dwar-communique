import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, FileText, MessageSquareText, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { CreateTemplateDialog } from "@/components/templates/create-template-dialog";
import { componentsToPreview } from "@/components/templates/template-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePermissions } from "@/hooks/use-permissions";
import { usePageShortcut } from "@/hooks/use-page-shortcut";
import { useWhatsAppNumbers } from "@/hooks/use-whatsapp-numbers";
import { useOrg } from "@/lib/org-context";
import { callApi } from "@/lib/whatsapp-client";
import { templateBodyText, type TemplateRow } from "@/lib/templates";
import { numberLabel } from "@/lib/whatsapp-numbers";
import { cn } from "@/lib/utils";
import { TemplateMessage } from "./template-phone";
import { reviewStateOf, TEMPLATE_STATUS_FILTERS, type ReviewState } from "./templates-data";

/**
 * Batch 47: Templates in the new design, the Campaigns section's second tab.
 * A gallery of phones, each with its review state and Meta's reason when it
 * was rejected; starters (blank, invoice with a PDF) open the Batch 41 editor
 * (create-template-dialog) preloaded, and that editor submits through its own
 * /api/whatsapp/templates "create" request. The library read and the sync are
 * the Batch 41 page's (templates-view), which a workspace with the flag off
 * still sees, unchanged.
 */

const SYNC_KEY = "aidwar.templates.last_sync";
const TEN_MINUTES = 10 * 60 * 1000;

export function NewTemplates() {
  const { active } = useOrg();
  const { can } = usePermissions();
  const canManage = can("templates.manage");
  const orgId = active?.organization.id ?? null;
  const { numbers, multiple } = useWhatsAppNumbers({ activeOnly: false });
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [numberFilter, setNumberFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<ReviewState | "all">("all");
  const [start, setStart] = useState<{ kind: "blank" | "invoice"; at: number } | null>(null);
  const autoSynced = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  usePageShortcut("/", () => searchRef.current?.focus());

  const load = useCallback(async () => {
    if (!orgId) return;
    setError(null);
    const { data, error: err } = await aidwar
      .from("message_templates")
      .select("*")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false });
    if (err) setError("We couldn't load your templates. Please refresh.");
    else setTemplates((data ?? []) as TemplateRow[]);
    setLoading(false);
  }, [orgId]);

  /** Per business account, as on the Batch 41 page: one number never overwrites another's library. */
  const sync = useCallback(
    async (accountId: string | null, silent = false) => {
      if (!orgId) return;
      setSyncing(accountId ?? "all");
      const { error: err } = await callApi("/api/whatsapp/templates", {
        body: { action: "sync", organization_id: orgId, whatsapp_account_id: accountId },
      });
      setSyncing(null);
      try {
        window.localStorage.setItem(`${SYNC_KEY}.${orgId}`, String(Date.now()));
      } catch {
        // Private mode: the next visit syncs again.
      }
      if (err) {
        if (!silent) toast.error(err);
        return;
      }
      if (!silent) toast.success("Templates synced from Meta.");
      await load();
    },
    [orgId, load],
  );

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // The same auto-sync as Batch 41: when the last one is older than 10 minutes.
  useEffect(() => {
    if (!orgId || !canManage || autoSynced.current === orgId) return;
    autoSynced.current = orgId;
    let last = 0;
    try {
      last = Number(window.localStorage.getItem(`${SYNC_KEY}.${orgId}`) || 0);
    } catch {
      last = 0;
    }
    if (Date.now() - last > TEN_MINUTES) void sync(null, true);
  }, [orgId, canManage, sync]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const picked = numbers.find((n) => n.id === numberFilter);
    return templates.filter((t) => {
      if (
        q &&
        !t.name.toLowerCase().includes(q) &&
        !templateBodyText(t.components).toLowerCase().includes(q)
      )
        return false;
      if (numberFilter !== "all" && (!picked || t.waba_id !== picked.waba_id)) return false;
      return statusFilter === "all" || reviewStateOf(t) === statusFilter;
    });
  }, [templates, query, numberFilter, numbers, statusFilter]);

  const ownerOf = useCallback(
    (wabaId: string | null) => {
      const owners = numbers.filter((n) => n.waba_id && n.waba_id === wabaId);
      return owners.length ? owners.map((n) => numberLabel(n)).join(", ") : "No connected number";
    },
    [numbers],
  );

  const createAccountId =
    numberFilter !== "all"
      ? numberFilter
      : ((numbers.find((n) => n.is_default) ?? numbers[0])?.id ?? null);

  const actions = (
    <>
      <Button
        variant="outline"
        onClick={() => void sync(numberFilter === "all" ? null : numberFilter)}
        disabled={Boolean(syncing) || !canManage}
      >
        <RefreshCw
          className={cn("h-4 w-4", syncing && "motion-safe:animate-spin")}
          aria-hidden="true"
        />
        {numberFilter === "all" ? "Sync with Meta" : "Sync this number"}
      </Button>
      {canManage && orgId ? (
        <CreateTemplateDialog
          organizationId={orgId}
          whatsappAccountId={createAccountId}
          onCreated={() => void load()}
          start={start}
        />
      ) : null}
    </>
  );

  return (
    <>
      <PageHeader
        title="Templates"
        description="Messages Meta has approved, which you can send any time, even after the 24-hour window. Meta usually reviews a new one within minutes."
        actions={actions}
      />

      {loading ? (
        <GallerySkeleton />
      ) : error ? (
        <ErrorState message={error} />
      ) : (
        <div className="flex flex-col gap-7">
          {canManage ? (
            <section aria-labelledby="tpl-starters" className="flex flex-col gap-3">
              <h2 id="tpl-starters" className="m-0 font-display text-lg font-semibold">
                Start from
              </h2>
              <div className="grid gap-3 wide:grid-cols-2 min-[1001px]:grid-cols-3">
                <Starter
                  icon={FilePlus2}
                  title="A blank template"
                  detail="Your own words, buttons and picture."
                  onClick={() => setStart({ kind: "blank", at: Date.now() })}
                />
                <Starter
                  icon={FileText}
                  title="Invoice or receipt with a PDF"
                  detail="A utility message with the file at the top."
                  onClick={() => setStart({ kind: "invoice", at: Date.now() })}
                />
              </div>
            </section>
          ) : null}

          {templates.length === 0 ? (
            <EmptyState
              icon={MessageSquareText}
              title="No templates yet"
              description="Start one above and submit it for review, or sync the ones already approved on your business account."
            />
          ) : (
            <section aria-labelledby="tpl-library" className="flex flex-col gap-4">
              <h2 id="tpl-library" className="sr-only">
                Your templates
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-full wide:w-72">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search templates"
                    aria-label="Search templates"
                    aria-keyshortcuts="/"
                    className="pl-9"
                  />
                </div>
                {multiple ? (
                  <Select value={numberFilter} onValueChange={setNumberFilter}>
                    <SelectTrigger className="w-full wide:w-56" aria-label="Number">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All numbers</SelectItem>
                      {numbers.map((n) => (
                        <SelectItem key={n.id} value={n.id}>
                          {numberLabel(n)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                <div role="group" aria-label="Show templates" className="flex flex-wrap gap-1.5">
                  {TEMPLATE_STATUS_FILTERS.map((f) => {
                    const n =
                      f.key === "all"
                        ? templates.length
                        : templates.filter((t) => reviewStateOf(t) === f.key).length;
                    const on = statusFilter === f.key;
                    return (
                      <button
                        key={f.key}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setStatusFilter(f.key)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors duration-200",
                          on
                            ? "border-transparent bg-aiden-soft text-aiden-deep"
                            : "border-line bg-surface text-foreground hover:bg-bubble-in",
                        )}
                      >
                        {f.label}
                        <span className="tabular-nums text-muted-foreground">{n}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {filtered.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title="No matching templates"
                  description="Try a different name, wording, number or review state."
                />
              ) : (
                <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(250px,1fr))] items-start gap-5 p-0">
                  {filtered.map((t, i) => (
                    <TemplateTile
                      key={t.id}
                      template={t}
                      owner={multiple ? ownerOf(t.waba_id) : null}
                      index={i}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </>
  );
}

const STATE_CHIP: Record<ReviewState, { label: string; className: string }> = {
  APPROVED: { label: "Approved", className: "bg-aiden-soft text-aiden-deep" },
  PENDING: { label: "In review", className: "bg-gold-bg text-gold-ink" },
  REJECTED: { label: "Rejected", className: "bg-danger-soft text-danger-soft-foreground" },
  OTHER: { label: "Paused", className: "border border-line text-muted-foreground" },
};

/** One template: its name and state above a small phone with the message. */
function TemplateTile({
  template: t,
  owner,
  index,
}: {
  template: TemplateRow;
  owner: string | null;
  index: number;
}) {
  const state = reviewStateOf(t);
  const chip = STATE_CHIP[state];
  const label =
    state === "OTHER" ? t.status.charAt(0) + t.status.slice(1).toLowerCase() : chip.label;
  return (
    <li
      className="nd-slide-in flex flex-col gap-3 phone:mx-auto phone:w-full phone:max-w-[320px]"
      style={{ ["--i" as string]: Math.min(index, 6) }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="m-0 truncate text-base font-bold text-foreground">{t.name}</h3>
          <p className="m-0 text-sm text-muted-foreground">
            <span className="capitalize">{(t.category ?? "template").toLowerCase()}</span>,{" "}
            {t.language}
            {owner ? `, ${owner}` : null}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-0.5 text-[0.8125rem] font-semibold",
            chip.className,
          )}
        >
          {label}
        </span>
      </div>
      {state === "REJECTED" && t.rejection_reason ? (
        <p className="m-0 rounded-[14px] border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground">
          <b>Meta&apos;s reason:</b> {t.rejection_reason}
        </p>
      ) : null}
      {/* A smaller PhoneFrame for the gallery: the same ink frame and dotted wall. */}
      <figure
        aria-label={`${t.name}: the message`}
        className="m-0 rounded-[30px] bg-ink p-2 shadow-xl"
      >
        <div className="nd-wall flex min-h-[260px] flex-col rounded-[23px] px-2.5 pb-4 pt-7">
          <TemplateMessage model={componentsToPreview(t.components)} />
        </div>
      </figure>
    </li>
  );
}

function Starter({
  icon: Icon,
  title,
  detail,
  onClick,
}: {
  icon: typeof FileText;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-3 rounded-[18px] border border-line bg-surface p-4 text-left shadow-sm transition-shadow duration-200 hover:shadow-md"
    >
      <span
        aria-hidden="true"
        className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-aiden-soft text-aiden-deep"
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <b className="block text-foreground">{title}</b>
        <span className="block text-sm text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

function GallerySkeleton() {
  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-5"
      aria-busy="true"
      aria-label="Loading templates"
    >
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-[340px] rounded-[30px]" />
      ))}
    </div>
  );
}
