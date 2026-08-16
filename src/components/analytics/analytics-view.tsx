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
  makeFilters,
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
import { analyticsSections } from "@/lib/feature-registry";
import { useWhatsAppNumbers } from "@/hooks/use-whatsapp-numbers";
import { numberLabel } from "@/lib/whatsapp-numbers";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** One tab per feature that declares an analytics dashboard section. */
const SECTIONS = analyticsSections();


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
  const [accountId, setAccountId] = useState<string>("all");
  const { numbers, multiple } = useWhatsAppNumbers({ activeOnly: false });
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
    // One filter object for every panel — unfiltered means all numbers combined.
    const filters = makeFilters(period, accountId === "all" ? null : accountId);

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
      fetchOverview(organizationId, filters),
      fetchTimeseries(organizationId, filters),
      fetchCampaignPerformance(organizationId, filters),
      fetchContactsSummary(organizationId, filters),
      fetchSourceBreakdown(organizationId, filters),
      fetchResponseTimes(organizationId, filters),
      fetchTeamPerformance(organizationId, filters),
      fetchAutomationPerformance(organizationId, filters),
      fetchQualityHistory(organizationId, filters),
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
  }, [organizationId, timezone, days, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  function renderSection(id: string) {
    switch (id) {
      case "overview":
        return <AnalyticsOverview overview={overview} series={series} loading={loading} />;
      case "campaigns":
        return (
          <AnalyticsCampaigns
            organizationId={organizationId}
            timezone={timezone}
            rows={campaigns}
            loading={loading}
          />
        );
      case "contacts":
        return (
          <AnalyticsContacts
            series={series}
            summary={summary}
            sources={sources}
            loading={loading}
          />
        );
      case "inbox":
        return <AnalyticsInbox response={response} team={team} series={series} loading={loading} />;
      case "automations":
        return <AnalyticsAutomations rows={automations} loading={loading} />;
      case "quality":
        return <AnalyticsQuality points={quality} timezone={timezone} loading={loading} />;
      default:
        return null;
    }
  }

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
        <div className="flex flex-wrap items-center gap-3">
          {multiple ? (
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger className="h-9 w-[220px] rounded-xl text-xs">
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

          <span className="text-xs text-muted-foreground">
            Dates shown in {overview?.timezone ?? timezone}
          </span>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <Tabs defaultValue={SECTIONS[0]?.analytics.section_id ?? "overview"} className="space-y-6">
        <TabsList className="flex w-full flex-wrap justify-start">
          {SECTIONS.map((f) => (
            <TabsTrigger key={f.key} value={f.analytics.section_id as string}>
              {f.analytics.section_label}
            </TabsTrigger>
          ))}
        </TabsList>

        {SECTIONS.map((f) => (
          <TabsContent key={f.key} value={f.analytics.section_id as string}>
            {renderSection(f.analytics.section_id as string)}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
