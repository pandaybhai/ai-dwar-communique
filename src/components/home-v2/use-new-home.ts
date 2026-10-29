import { useCallback, useEffect, useRef, useState } from "react";
import { callApi } from "@/lib/whatsapp-client";
import { fetchAttributionSummary, makeFilters, periodForDays } from "@/lib/analytics";
import type { BillingSummary } from "@/lib/billing";
import type { CampaignRow } from "@/lib/campaigns";
import type { HomeSummary } from "@/lib/home.server";
import { subscribeInboxChanges } from "@/lib/inbox-realtime";
import { homeModeFor, type HomeMode } from "@/lib/new-home";
import {
  loadActiveChats,
  loadAidenFeed,
  loadAidenMode,
  loadDraftsWrittenToday,
  loadFlowsToday,
  loadLatestCampaign,
  loadNeedsYou,
  loadOpenChats,
  loadReadyDrafts,
  loadTeammates,
  type DraftItem,
  type FeedItem,
  type NeedsYouItem,
  type OpenChat,
  type Teammate,
} from "@/lib/new-home-data";
import type { FlowToday } from "@/lib/new-home";

/** What each part of the new Home may read (flags and permissions, decided by the page). */
export type HomeAccess = {
  aiPlan: boolean;
  campaigns: boolean;
  flows: boolean;
  revenue: boolean;
  billing: boolean;
  teammates: boolean;
};

export type Sales = { label: string; value: number; currency: string };

export type NewHomeData = {
  /** Null until the mode is known. */
  mode: HomeMode | null;
  aiEnabled: boolean | null;
  summary: HomeSummary | null;
  sales: Sales | null;
  /** Each block: null = not read (or failed) and left out. */
  active: number | null;
  feed: FeedItem[] | null;
  needsYou: { items: NeedsYouItem[]; total: number } | null;
  drafts: DraftItem[] | null;
  draftsToday: number | null;
  openChats: OpenChat[] | null;
  flows: { flows: FlowToday[]; total: number } | null;
  campaign: CampaignRow | null;
  teammates: Teammate[];
};

const EMPTY: NewHomeData = {
  mode: null,
  aiEnabled: null,
  summary: null,
  sales: null,
  active: null,
  feed: null,
  needsYou: null,
  drafts: null,
  draftsToday: null,
  openChats: null,
  flows: null,
  campaign: null,
  teammates: [],
};

/**
 * Sales from chats (Receipts' own attribution read) when the workspace uses
 * receipts — any order in the last 30 days — else the wallet's credits (the
 * Billing summary), else nothing.
 */
async function loadSales(
  organizationId: string,
  timezone: string,
  access: HomeAccess,
): Promise<Sales | null> {
  if (access.revenue) {
    const [today, month] = await Promise.all([
      fetchAttributionSummary(organizationId, makeFilters(periodForDays(timezone, 1, "Today"))),
      fetchAttributionSummary(
        organizationId,
        makeFilters(periodForDays(timezone, 30, "Last 30 days")),
      ),
    ]);
    if (today.data && month.data && Number(month.data.orders_total) > 0) {
      return {
        label: "Sales from chats",
        value: Number(today.data.revenue_attributed ?? 0),
        currency: today.data.currency || month.data.currency || "INR",
      };
    }
  }
  if (access.billing) {
    const res = await callApi<BillingSummary>(
      `/api/billing/summary?organization_id=${organizationId}`,
      {
        method: "GET",
      },
    );
    if (res.data && !res.error && res.data.wallet)
      return {
        label: "Credits",
        value: Number(res.data.wallet.available),
        currency: res.data.wallet.currency || "INR",
      };
  }
  return null;
}

/** After a customer writes, Aiden's draft or reply lands a few seconds later: read again then. */
export const SETTLE_MS = 8_000;

/**
 * Batch 45: everything the new Home shows, for the mode Aiden really runs in
 * (homeModeFor over the default agent's mode, the workspace AI switch and the
 * plan's AI). Only the blocks of that mode are read.
 */
export async function loadNewHome(
  organizationId: string,
  timezone: string,
  access: HomeAccess,
  now: number = Date.now(),
): Promise<NewHomeData> {
  const [modeRow, summaryRes, sales] = await Promise.all([
    access.aiPlan ? loadAidenMode(organizationId) : Promise.resolve(null),
    callApi<HomeSummary>(`/api/home/summary?organization_id=${organizationId}`, { method: "GET" }),
    loadSales(organizationId, timezone, access),
  ]);
  const mode = homeModeFor({
    aiPlan: access.aiPlan && modeRow !== null,
    aiEnabled: modeRow?.aiEnabled ?? null,
    agentMode: modeRow?.agentMode ?? null,
  });
  const summary = summaryRes.error ? null : summaryRes.data;
  const held = summary?.waiting ?? [];
  const campaign =
    access.campaigns && mode !== "off" ? loadLatestCampaign(organizationId) : Promise.resolve(null);

  const next: NewHomeData = {
    ...EMPTY,
    mode,
    aiEnabled: modeRow?.aiEnabled ?? null,
    summary,
    sales,
  };
  if (mode === "replying") {
    const [active, feed, needsYou, latest] = await Promise.all([
      loadActiveChats(organizationId, now),
      loadAidenFeed(organizationId, now),
      loadNeedsYou(organizationId, held),
      campaign,
    ]);
    Object.assign(next, { active, feed, needsYou, campaign: latest ?? null });
  } else if (mode === "draft") {
    const [drafts, needsYou, draftsToday, latest] = await Promise.all([
      loadReadyDrafts(organizationId, now),
      loadNeedsYou(organizationId, held),
      loadDraftsWrittenToday(organizationId, timezone),
      campaign,
    ]);
    Object.assign(next, { drafts, needsYou, draftsToday, campaign: latest ?? null });
  } else {
    const [openChats, flows, teammates] = await Promise.all([
      loadOpenChats(organizationId, now),
      access.flows ? loadFlowsToday(organizationId, timezone) : Promise.resolve(null),
      access.teammates ? loadTeammates(organizationId) : Promise.resolve([]),
    ]);
    Object.assign(next, { openChats, flows, teammates });
  }
  return next;
}

/**
 * Home's live updates: the Inbox's own subscription (subscribeInboxChanges)
 * on this workspace's messages and chats. A burst of changes reads once; a
 * customer's message reads again SETTLE_MS later, when Aiden's reply or draft
 * has landed. Returns the unsubscribe.
 */
export function liveHomeReload(organizationId: string, reload: () => void): () => void {
  let soon: ReturnType<typeof setTimeout> | null = null;
  let settle: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const changed = (afterCustomer: boolean) => {
    if (stopped) return;
    if (soon) clearTimeout(soon);
    soon = setTimeout(reload, 400);
    if (afterCustomer) {
      if (settle) clearTimeout(settle);
      settle = setTimeout(reload, SETTLE_MS);
    }
  };
  const stop = subscribeInboxChanges(`home:${organizationId}`, organizationId, {
    onMessage: (payload) =>
      changed((payload.new as { direction?: string } | null)?.direction === "inbound"),
    onConversation: () => changed(false),
  });
  return () => {
    stopped = true;
    stop();
    if (soon) clearTimeout(soon);
    if (settle) clearTimeout(settle);
  };
}

/** The new Home's data, read again live (liveHomeReload) so nothing needs a reload. */
export function useNewHome(
  organizationId: string | null,
  timezone: string,
  access: HomeAccess | null,
) {
  const [data, setData] = useState<NewHomeData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const accessKey = access ? JSON.stringify(access) : null;

  const load = useCallback(async () => {
    if (!organizationId || !access) return;
    const mine = ++seq.current;
    const next = await loadNewHome(organizationId, timezone, access);
    if (mine !== seq.current) return;
    setData(next);
    setLoading(false);
    // `access` is compared by value through accessKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, timezone, accessKey]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    if (!organizationId || !accessKey) return;
    return liveHomeReload(organizationId, () => void load());
  }, [organizationId, accessKey, load]);

  return { data, loading, reload: load };
}
