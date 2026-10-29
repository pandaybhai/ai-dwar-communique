import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Lock, Megaphone, Plus } from "lucide-react";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
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
}: {
  organizationId: string;
  timezone: string;
  /** From /app/campaigns/$id; none on /app/campaigns. */
  selectedId?: string | undefined;
}) {
  const { can } = usePermissions();
  const canCreate = can("campaigns.create");
  const navigate = useNavigate();
  const [rows, setRows] = useState<CampaignRow[] | null>(
    () => listCache.get(organizationId) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
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
      <Plus className="h-4 w-4" aria-hidden="true" /> New campaign
      <Kbd className="ml-1 hidden border-ink-foreground/25 bg-ink-foreground/15 text-ink-foreground shadow-none wide:inline-flex">
        N
      </Kbd>
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="One message to many customers, and how far it got: sent, delivered, read and replied."
        actions={newButton}
      />
      <QualityBanner organizationId={organizationId} className="mb-5" />

      {error && !rows ? (
        <ErrorState message={error} />
      ) : !rows ? (
        <CampaignsSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No campaigns yet"
          description="Pick who gets it, choose an approved template, and reach every opted-in customer in one go."
          action={
            canCreate ? (
              <Button onClick={() => setWizardOpen(true)}>
                <Plus className="h-4 w-4" aria-hidden="true" /> Create your first campaign
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-7 min-[1001px]:grid-cols-[minmax(0,300px)_minmax(0,1fr)_minmax(0,260px)]">
          <nav
            aria-label="Campaigns"
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
                className="-mb-3 inline-flex w-fit items-center gap-1.5 rounded-lg py-1 text-sm font-semibold text-muted-foreground transition-colors duration-200 hover:text-foreground min-[1001px]:hidden"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All campaigns
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
        </div>
      )}

      <CampaignWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
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
  return (
    <Link
      to="/app/campaigns/$id"
      params={{ id: c.id }}
      aria-current={opened ? "page" : undefined}
      style={{ ["--i" as string]: Math.min(index, 8) }}
      className={cn(
        "nd-slide-in flex items-center gap-3 rounded-[14px] border p-3 text-left text-foreground transition-[background-color,border-color] duration-200",
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
          aria-label={`${bars.delivered}% delivered, ${bars.read}% read, ${bars.replied}% replied`}
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
      aria-label="Loading campaigns"
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

/** Campaigns switched off for the workspace: the same words as Batch 41's page. */
export function CampaignsOff() {
  return (
    <>
      <PageHeader title="Campaigns" description="Reach every opted-in customer with one message." />
      <EmptyState
        icon={Lock}
        title="Campaigns are turned off"
        description="This feature isn't enabled for your workspace yet. Reach out to your administrator to switch it on."
      />
    </>
  );
}
