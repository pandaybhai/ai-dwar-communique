import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, MessageSquareText, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { useOrg } from "@/lib/org-context";
import { callApi } from "@/lib/whatsapp-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
  templateFooterText,
  type TemplateRow,
} from "@/lib/templates";
import { CreateTemplateDialog } from "./create-template-dialog";

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

export function TemplatesView() {
  const { active, canManage } = useOrg();
  const orgId = active?.organization.id ?? null;
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState("");
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

  const sync = useCallback(
    async (silent = false) => {
      if (!orgId) return;
      setSyncing(true);
      const { error: err } = await callApi("/api/whatsapp/templates", {
        body: { action: "sync", organization_id: orgId },
      });
      setSyncing(false);
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
    if (Date.now() - last > TEN_MINUTES) void sync(true);
  }, [orgId, canManage, sync]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        templateBodyText(t.components).toLowerCase().includes(q),
    );
  }, [templates, query]);

  if (loading) return <TemplateSkeleton />;
  if (error) return <ErrorState message={error} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates"
            className="rounded-full pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="rounded-full"
            onClick={() => void sync()}
            disabled={syncing || !canManage}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            Sync from Meta
          </Button>
          {canManage && orgId ? (
            <CreateTemplateDialog organizationId={orgId} onCreated={() => void load()} />
          ) : null}
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-xs text-foreground">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          Meta reviews every template — usually within minutes, occasionally a few hours. Marketing
          templates may only be sent to contacts who have opted in to hear from your business.
        </p>
      </div>

      {templates.length === 0 ? (
        <EmptyState
          icon={MessageSquareText}
          title="No templates yet"
          description="Create your first template and submit it for review, or sync the ones already approved on your business account."
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matching templates"
          description="Try a different name or wording."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((t) => {
            const body = templateBodyText(t.components);
            const footer = templateFooterText(t.components);
            return (
              <div
                key={t.id}
                className="animate-in fade-in slide-in-from-bottom-1 flex flex-col rounded-2xl border border-border/70 bg-card p-5 shadow-sm transition-shadow duration-200 hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{t.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {(t.category ?? "—").toLowerCase()} · {t.language}
                    </p>
                  </div>
                  {t.status === "REJECTED" && t.rejection_reason ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className={`shrink-0 rounded-full ${statusBadgeClass(t.status)}`}
                          >
                            {t.status.toLowerCase()}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs break-words">
                          {t.rejection_reason}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <Badge
                      variant="outline"
                      className={`shrink-0 rounded-full ${statusBadgeClass(t.status)}`}
                    >
                      {t.status.toLowerCase()}
                    </Badge>
                  )}
                </div>

                <div className="mt-4 rounded-2xl bg-muted/40 p-3">
                  <div className="rounded-2xl rounded-bl-md border border-border/70 bg-card px-3.5 py-2.5 text-sm shadow-sm">
                    <p className="whitespace-pre-wrap break-words leading-relaxed">
                      {body || "—"}
                    </p>
                    {footer ? (
                      <p className="mt-2 text-[11px] text-muted-foreground">{footer}</p>
                    ) : null}
                  </div>
                </div>

                <p className="mt-4 text-[11px] text-muted-foreground">
                  Created {new Date(t.created_at).toLocaleDateString()}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
