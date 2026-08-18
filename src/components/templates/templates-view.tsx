import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, MessageSquareText, Phone, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { useOrg } from "@/lib/org-context";
import { callApi } from "@/lib/whatsapp-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { EmptyState, ErrorState } from "@/components/empty-state";
import {
  statusBadgeClass,
  templateBodyText,
  type TemplateRow,
} from "@/lib/templates";
import { componentsToPreview, TemplatePreview } from "@/components/templates/template-preview";
import { CreateTemplateDialog } from "./create-template-dialog";
import { usePermissions } from "@/hooks/use-permissions";
import { useWhatsAppNumbers } from "@/hooks/use-whatsapp-numbers";
import { numberLabel, type WhatsAppNumber } from "@/lib/whatsapp-numbers";

const SYNC_KEY = "aidwar.templates.last_sync";
const TEN_MINUTES = 10 * 60 * 1000;

function TemplateSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-3 h-20 w-full rounded-xl" />
          <Skeleton className="mt-3 h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

function TemplateCard({ template, owner }: { template: TemplateRow; owner: string }) {
  const preview = componentsToPreview(template.components);
  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 flex flex-col rounded-2xl border border-border/70 bg-card p-5 shadow-sm transition-shadow duration-200 hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{template.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {(template.category ?? "—").toLowerCase()} · {template.language}
          </p>
        </div>
        {template.status === "REJECTED" && template.rejection_reason ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className={`shrink-0 rounded-full ${statusBadgeClass(template.status)}`}
                >
                  {template.status.toLowerCase()}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs break-words">
                {template.rejection_reason}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <Badge
            variant="outline"
            className={`shrink-0 rounded-full ${statusBadgeClass(template.status)}`}
          >
            {template.status.toLowerCase()}
          </Badge>
        )}
      </div>

      <div className="mt-4 rounded-2xl bg-muted/40 p-3">
        <TemplatePreview model={preview} className="max-w-none" />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Phone className="h-3 w-3 shrink-0" />
          <span className="truncate">{owner}</span>
        </span>
        <span className="shrink-0">
          Created {new Date(template.created_at).toLocaleDateString()}
        </span>
      </div>
    </div>
  );
}

export function TemplatesView() {
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
  const [numberFilter, setNumberFilter] = useState<string>("all");
  const autoSynced = useRef<string | null>(null);

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

  /**
   * Sync is per business account. Passing one number syncs only that number's
   * library — one number can never overwrite or remove another's templates.
   */
  const sync = useCallback(
    async (accountId: string | null, silent = false) => {
      if (!orgId) return;
      setSyncing(accountId ?? "all");
      const { error: err } = await callApi("/api/whatsapp/templates", {
        body: { action: "sync", organization_id: orgId, whatsapp_account_id: accountId },
      });
      setSyncing(null);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(`${SYNC_KEY}.${orgId}`, String(Date.now()));
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

  // Auto-sync when the last sync is older than 10 minutes.
  useEffect(() => {
    if (!orgId || !canManage || autoSynced.current === orgId) return;
    autoSynced.current = orgId;
    const last = Number(
      (typeof window !== "undefined" && window.localStorage.getItem(`${SYNC_KEY}.${orgId}`)) || 0,
    );
    if (Date.now() - last > TEN_MINUTES) void sync(null, true);
  }, [orgId, canManage, sync]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((t) => {
      if (
        q &&
        !t.name.toLowerCase().includes(q) &&
        !templateBodyText(t.components).toLowerCase().includes(q)
      ) {
        return false;
      }
      if (numberFilter !== "all") {
        const picked = numbers.find((n) => n.id === numberFilter);
        if (!picked || t.waba_id !== picked.waba_id) return false;
      }
      return true;
    });
  }, [templates, query, numberFilter, numbers]);

  /** One group per business account, since each holds its own library. */
  const groups = useMemo(() => {
    const byWaba = new Map<string, WhatsAppNumber[]>();
    for (const n of numbers) {
      if (!n.waba_id) continue;
      byWaba.set(n.waba_id, [...(byWaba.get(n.waba_id) ?? []), n]);
    }
    const buckets = new Map<string, TemplateRow[]>();
    for (const t of filtered) {
      const key = t.waba_id ?? "unlinked";
      buckets.set(key, [...(buckets.get(key) ?? []), t]);
    }
    return Array.from(buckets.entries()).map(([wabaId, rows]) => {
      const owners = byWaba.get(wabaId) ?? [];
      return {
        wabaId,
        rows,
        accountId: owners[0]?.id ?? null,
        label: owners.length
          ? owners.map((n) => numberLabel(n)).join(", ")
          : "Not linked to a connected number",
      };
    });
  }, [filtered, numbers]);

  const createAccountId =
    numberFilter !== "all"
      ? numberFilter
      : (numbers.find((n) => n.is_default) ?? numbers[0])?.id ?? null;

  if (loading) return <TemplateSkeleton />;
  if (error) return <ErrorState message={error} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex w-full flex-col gap-2 sm:max-w-md sm:flex-row">
          <div className="relative w-full">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates"
              className="rounded-full pl-9"
            />
          </div>
          {multiple ? (
            <Select value={numberFilter} onValueChange={setNumberFilter}>
              <SelectTrigger className="rounded-full sm:w-56">
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
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="rounded-full"
            onClick={() => void sync(numberFilter === "all" ? null : numberFilter)}
            disabled={Boolean(syncing) || !canManage}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            {numberFilter === "all" ? "Sync all numbers" : "Sync this number"}
          </Button>
          {canManage && orgId ? (
            <CreateTemplateDialog
              organizationId={orgId}
              whatsappAccountId={createAccountId}
              onCreated={() => void load()}
            />
          ) : null}
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-xs text-foreground">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          Templates belong to the business account behind each number, so every number keeps its own
          library. Meta reviews every template — usually within minutes, occasionally a few hours.
          Marketing templates may only be sent to contacts who have opted in.
        </p>
      </div>

      {templates.length === 0 ? (
        <EmptyState
          icon={MessageSquareText}
          title="No templates yet"
          description="Create your first template and submit it for review, or sync the ones already approved on your business account."
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matching templates"
          description="Try a different name, wording, or number."
        />
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.wabaId} className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Phone className="h-4 w-4 text-primary" />
                    <span className="truncate">{group.label}</span>
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {group.rows.length} template{group.rows.length === 1 ? "" : "s"} in this
                    library
                  </p>
                </div>
                {canManage && group.accountId ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-full"
                    onClick={() => void sync(group.accountId)}
                    disabled={Boolean(syncing)}
                  >
                    <RefreshCw
                      className={`mr-2 h-3.5 w-3.5 ${syncing === group.accountId ? "animate-spin" : ""}`}
                    />
                    Sync
                  </Button>
                ) : null}
              </div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {group.rows.map((t) => (
                  <TemplateCard key={t.id} template={t} owner={group.label} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
