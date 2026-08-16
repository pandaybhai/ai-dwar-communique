import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { AnalyticsAutomations } from "@/components/analytics/analytics-automations";
import { AnalyticsCampaigns } from "@/components/analytics/analytics-campaigns";
import { AnalyticsContacts } from "@/components/analytics/analytics-contacts";
import { AnalyticsInbox } from "@/components/analytics/analytics-inbox";
import { AnalyticsOverview } from "@/components/analytics/analytics-overview";
import { AnalyticsQuality } from "@/components/analytics/analytics-quality";
import { ErrorState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  fetchAutomationPerformance,
  fetchCampaignPerformance,
  fetchContactsSummary,
  fetchOverview,
  fetchQualityHistory,
  fetchResponseTimes,
  fetchSourceBreakdown,
  fetchTeamPerformance,
  fetchTimeseries,
  periodForDays,
  type AutomationRow,
  type CampaignPerformance,
  type ContactsSummary,
  type Overview,
  type Period,
  type QualityPoint,
  type ResponseTimes,
  type SeriesPoint,
  type SourceRow,
  type TeamRow,
} from "@/lib/analytics";

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];

export function AnalyticsView({
  organizationId,
  timezone,
}: {
  organizationId: string;
  timezone: string;
}) {
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignPerformance[]>([]);
  const [summary, setSummary] = useState<ContactsSummary | null>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [response, setResponse] = useState<ResponseTimes | null>(null);
  const [team, setTeam] = useState<TeamRow[]>([]);
  const [automations, setAutomations] = useState<AutomationRow[]>([]);
  const [quality, setQuality] = useState<QualityPoint[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const label = RANGES.find((r) => r.days === days)?.label ?? `Last ${days} days`;
    const period: Period = periodForDays(timezone, days, label);

    const [
      overviewRes,
      seriesRes,
      campaignRes,
      summaryRes,
      sourceRes,
      responseRes,
      teamRes,
      automationRes,
      qualityRes,
    ] = await Promise.all([
      fetchOverview(organizationId, period),
      fetchTimeseries(organizationId, period),
      fetchCampaignPerformance(organizationId, period),
      fetchContactsSummary(organizationId),
      fetchSourceBreakdown(organizationId),
      fetchResponseTimes(organizationId, period),
      fetchTeamPerformance(organizationId, period),
      fetchAutomationPerformance(organizationId, period),
      fetchQualityHistory(organizationId, period),
    ]);

    const firstError =
      overviewRes.error ??
      seriesRes.error ??
      campaignRes.error ??
      summaryRes.error ??
      responseRes.error;
    if (firstError) {
      setError(firstError);
      setLoading(false);
      return;
    }

    setOverview(overviewRes.data);
    setSeries(seriesRes.data ?? []);
    setCampaigns(campaignRes.data ?? []);
    setSummary(summaryRes.data);
    setSources(sourceRes.data ?? []);
    setResponse(responseRes.data);
    setTeam(teamRes.data ?? []);
    setAutomations(automationRes.data ?? []);
    setQuality(qualityRes.data ?? []);
    setLoading(false);
  }, [organizationId, timezone, days]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-border/70 bg-card p-1 shadow-sm">
          {RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              onClick={() => setDays(range.days)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors duration-150 ${
                days === range.days
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {range.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Dates shown in {overview?.timezone ?? timezone}
          </span>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList className="flex w-full flex-wrap justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="inbox">Inbox &amp; team</TabsTrigger>
          <TabsTrigger value="automations">Automations</TabsTrigger>
          <TabsTrigger value="quality">Number quality</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <AnalyticsOverview overview={overview} series={series} loading={loading} />
        </TabsContent>
        <TabsContent value="campaigns">
          <AnalyticsCampaigns
            organizationId={organizationId}
            timezone={timezone}
            rows={campaigns}
            loading={loading}
          />
        </TabsContent>
        <TabsContent value="contacts">
          <AnalyticsContacts
            series={series}
            summary={summary}
            sources={sources}
            loading={loading}
          />
        </TabsContent>
        <TabsContent value="inbox">
          <AnalyticsInbox response={response} team={team} series={series} loading={loading} />
        </TabsContent>
        <TabsContent value="automations">
          <AnalyticsAutomations rows={automations} loading={loading} />
        </TabsContent>
        <TabsContent value="quality">
          <AnalyticsQuality points={quality} timezone={timezone} loading={loading} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
