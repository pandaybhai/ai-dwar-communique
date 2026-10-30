import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Lock, Megaphone, Plus } from "lucide-react";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { StickyAction } from "@/components/design-v2";
import { QualityBanner } from "@/components/whatsapp-quality-banner";
import { CampaignWizard } from "@/components/campaigns/campaign-wizard";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermissions } from "@/hooks/use-permissions";
import { usePageShortcut } from "@/hooks/use-page-shortcut";
import { useAppCommand } from "@/lib/app-commands";
import type { CampaignRow } from "@/lib/campaigns";
import { cn } from "@/lib/utils";
import { CampaignResults } from "./campaign-results";
import { campaignsCopy as cc } from "./copy";
import { campaignSubtitle, campaignTag, loadCampaignList, miniBars } from "./data";

/**
 * Batch 47: Campaigns in the new design (docs/design/preview.html #campaigns,
 * new_design on). The list on the left, the chosen campaign's results in the
 * middle, the message it sent on a phone on the right. Under 1001px the list
 * comes first and a campaign opens full width with its phone below. The
 * Batch 41 list and results page (campaigns-view, campaign-detail) are what
 * a workspace with the flag off sees, unchanged.
 */

/** The last list per workspace, so moving between campaigns never flashes a skeleton. */
const listCache = new Map<string, CampaignRow[]>();

export function NewCampaigns({
  organizationId,
  timezone,
  selectedId,
  initialSegmentId,
}: {
  organizationId: string;
  timezone: string;
  /** From /app/campaigns/$id; none on /app/campaigns. */
  selectedId?: string | undefined;
  /** Batch 51: /app/campaigns?segment= — the wizard opens with this segment chosen. */
  initialSegmentId?: string | undefined;
}) {
  const { can } = usePermissions();
  const canCreate = can("campaigns.create");
  const navigate = useNavigate();
  const [rows, setRows] = useState<CampaignRow[] | null>(
    () => listCache.get(organizationId) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardSegment, setWizardSegment] = useState<string | undefined>(undefined);
  // Opened once per ?segment=, then the address is cleaned so a reload doesn't reopen it.
  useEffect(() => {
    if (!initialSegmentId || !canCreate) return;
    setWizardSegment(initialSegmentId);
    setWizardOpen(true);
    void navigate({ to: "/app/campaigns", search: {}, replace: true });
  }, [initialSegmentId, canCreate, navigate]);
  // The command palette's "New campaign" and N open the same wizard (as on Batch 41's list).
  useAppCommand("new-campaign", () => {
    if (canCreate) setWizardOpen(true);
  });
  usePageShortcut("n", () => setWizardOpen(true), canCreate && !wizardOpen);

  const load = useCallback(async () => {
    const out = await loadCampaignList(organizationId);
    if (out.error) setError(out.error);
    else {
      setError(null);
      listCache.set(organizationId, out.rows);
      setRows(out.rows);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const opened = Boolean(selectedId);
  const currentId = selectedId ?? rows?.[0]?.id ?? null;

  const newButton = canCreate ? (
    <Button onClick={() => setWizardOpen(true)} aria-keyshortcuts="N">
      <Plus className="h-4 w-4" aria-hidden="true" /> {cc.newCampaign}
      <Kbd className="ml-1 hidden border-ink-foreground/25 bg-ink-foreground/15 text-ink-foreground shadow-none wide:inline-flex">
        N
      </Kbd>
    </Button>
  ) : null;

  // Batch 57: on a phone "New campaign" sits by the thumb, above the bottom bar,
  // once there is a list to scroll (an empty page shows it in the empty state).
  const hasList = Boolean(rows && rows.length > 0);

  return (
    <>
      <PageHeader
        title={cc.page.title}
        description={cc.page.description}
        actions={newButton && hasList ? <StickyAction>{newButton}</StickyAction> : newButton}
      />
      <QualityBanner organizationId={organizationId} className="mb-5" />

      {error && !rows ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !rows ? (
        <CampaignsSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title={cc.empty.title}
          description={cc.empty.description}
          action={
            canCreate ? (
              <Button onClick={() => setWizardOpen(true)} className="phone:h-11">
                <Plus className="h-4 w-4" aria-hidden="true" /> {cc.empty.action}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-7 min-[1001px]:grid-cols-[minmax(0,300px)_minmax(0,1fr)_minmax(0,260px)]">
          <nav
            aria-label={cc.listLabel}
            className={cn("flex-col gap-1.5", opened ? "hidden min-[1001px]:flex" : "flex")}
          >
            {rows.map((c, i) => (
              <CampaignRowLink
                key={c.id}
                campaign={c}
                on={c.id === currentId}
                opened={c.id === selectedId}
                timezone={timezone}
                index={i}
              />
            ))}
          </nav>

          {currentId ? (
            <div
              className={cn(
                "min-w-0 flex-col gap-7 min-[1001px]:col-span-2",
                opened ? "flex" : "hidden min-[1001px]:flex",
              )}
            >
              <Link
                to="/app/campaigns"
                className="-mb-3 inline-flex w-fit items-center gap-1.5 rounded-lg py-1 text-sm font-semibold text-muted-foreground transition-colors duration-200 hover:text-foreground phone:min-h-11 min-[1001px]:hidden"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {cc.allCampaigns}
              </Link>
              <CampaignResults
                key={currentId}
                organizationId={organizationId}
                campaignId={currentId}
                timezone={timezone}
                listRow={rows.find((r) => r.id === currentId) ?? null}
                onChanged={() => void load()}
              />
            </div>
          ) : null}
          {/* Room under the list for the phone's sticky "New campaign". */}
          {canCreate ? <div aria-hidden="true" className="hidden h-14 phone:block" /> : null}
        </div>
      )}

      <CampaignWizard
        open={wizardOpen}
        onOpenChange={(open) => {
          setWizardOpen(open);
          if (!open) setWizardSegment(undefined);
        }}
        initialSegmentId={wizardSegment}
        organizationId={organizationId}
        timezone={timezone}
        onLaunched={(id) => {
          void load();
          void navigate({ to: "/app/campaigns/$id", params: { id } });
        }}
      />
    </>
  );
}

function CampaignRowLink({
  campaign: c,
  on,
  opened,
  timezone,
  index,
}: {
  campaign: CampaignRow;
  /** Shown in the results beside the list (wide screens). */
  on: boolean;
  /** The campaign in the address (/app/campaigns/$id). */
  opened: boolean;
  timezone: string;
  index: number;
}) {
  const bars = miniBars(c);
  const tag = campaignTag(c);
  // Batch 57: the wrapper rises in (staggered), the row itself lifts on hover
  // and press; the two never share an element, so neither overrides the other.
  return (
    <div className="nd-rise" style={{ ["--d" as string]: Math.min(index, 8) }}>
      <Link
        to="/app/campaigns/$id"
        params={{ id: c.id }}
        aria-current={opened ? "page" : undefined}
        className={cn(
          "nd-lift flex items-center gap-3 rounded-[14px] border p-3 text-left text-foreground",
          on && opened
            ? "border-line bg-surface shadow-md"
            : on
              ? "border-transparent hover:border-line hover:bg-surface min-[1001px]:border-line min-[1001px]:bg-surface min-[1001px]:shadow-md"
              : "border-transparent hover:border-line hover:bg-surface",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <b className="truncate font-bold">{c.name}</b>
          <span className="truncate text-sm text-muted-foreground">
            {campaignSubtitle(c, timezone)}
          </span>
        </span>
        {tag ? <StatusTag status={c.status} label={tag} /> : null}
        {bars ? (
          <span
            role="img"
            aria-label={cc.bars(bars.delivered, bars.read, bars.replied)}
            className="flex h-7 shrink-0 items-end gap-[3px]"
          >
            {[bars.delivered, bars.read, bars.replied].map((v, i) => (
              <i
                key={i}
                className={cn(
                  "block w-1.5 rounded-[3px]",
                  i === 0 ? "bg-aiden" : i === 1 ? "bg-aiden-deep" : "bg-gold",
                )}
                style={{ height: v > 0 ? `${Math.max(v, 8)}%` : "2px" }}
              />
            ))}
          </span>
        ) : null}
      </Link>
    </div>
  );
}

/** The preview's .tag: a quiet pill; what needs the owner is gold, a failure is red. */
export function StatusTag({ status, label }: { status: CampaignRow["status"]; label: string }) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full border px-[9px] py-0.5 text-[0.78rem] font-semibold",
        status === "awaiting_approval" || status === "paused"
          ? "border-gold-line bg-gold-bg text-gold-ink"
          : status === "failed"
            ? "border-danger-border bg-danger-soft text-danger-soft-foreground"
            : status === "sending"
              ? "border-transparent bg-aiden-soft text-aiden-deep"
              : "border-line text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function CampaignsSkeleton() {
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)] items-start gap-7 min-[1001px]:grid-cols-[minmax(0,300px)_minmax(0,1fr)_minmax(0,260px)]"
      aria-busy="true"
      aria-label={cc.loadingList}
    >
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 rounded-[14px]" />
        ))}
      </div>
      <div className="hidden flex-col gap-4 min-[1001px]:flex">
        <Skeleton className="h-7 w-1/2 rounded-lg" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 rounded-xl" />
        ))}
      </div>
      <Skeleton className="hidden h-[450px] rounded-[36px] min-[1001px]:block" />
    </div>
  );
}

/** Campaigns switched off for the workspace (Batch 57: in plain words). */
export function CampaignsOff() {
  return (
    <>
      <PageHeader title={cc.page.title} description={cc.off.description} />
      <EmptyState icon={Lock} title={cc.off.title} description={cc.off.body} />
    </>
  );
}
