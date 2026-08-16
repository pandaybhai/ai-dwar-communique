import { Activity, MessageSquare } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard, MetricCard } from "@/components/analytics/chart-card";
import {
  delta,
  rate,
  shortDay,
  type Overview,
  type SeriesPoint,
} from "@/lib/analytics";

const axis = {
  stroke: "var(--muted-foreground)",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
};

const tooltipStyle = {
  borderRadius: 12,
  border: "1px solid var(--border)",
  background: "var(--card)",
  fontSize: 12,
  color: "var(--foreground)",
} as const;

export function AnalyticsOverview({
  overview,
  series,
  loading,
}: {
  overview: Overview | null;
  series: SeriesPoint[];
  loading: boolean;
}) {
  const cur = overview?.current;
  const prev = overview?.previous;
  const attempted = (cur?.sent ?? 0) + (cur?.failed ?? 0);

  const deliveredRate = rate(cur?.delivered ?? 0, cur?.sent ?? 0);
  const readRate = rate(cur?.read ?? 0, cur?.delivered ?? 0);
  const failedRate = rate(cur?.failed ?? 0, attempted);
  const replyRate = rate(cur?.replies ?? 0, cur?.sent ?? 0);

  const hasMessages = series.some((p) => p.sent + p.failed + p.replies > 0);
  const hasContactActivity = series.some((p) => p.new_contacts + p.opt_outs > 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          loading={loading}
          label="Messages sent"
          value={cur?.sent ?? 0}
          deltaText={prev ? delta(cur?.sent ?? 0, prev.sent).text : undefined}
          direction={prev ? delta(cur?.sent ?? 0, prev.sent).direction : undefined}
        />
        <MetricCard
          loading={loading}
          label="Delivered"
          value={cur?.delivered ?? 0}
          rateText={deliveredRate.text}
          rateLabel={deliveredRate.thin ? "sent messages delivered" : "of sent"}
          thin={deliveredRate.thin}
          deltaText={prev ? delta(cur?.delivered ?? 0, prev.delivered).text : undefined}
          direction={prev ? delta(cur?.delivered ?? 0, prev.delivered).direction : undefined}
        />
        <MetricCard
          loading={loading}
          label="Read"
          value={cur?.read ?? 0}
          rateText={readRate.text}
          rateLabel={readRate.thin ? "delivered messages read" : "of delivered"}
          thin={readRate.thin}
          deltaText={prev ? delta(cur?.read ?? 0, prev.read).text : undefined}
          direction={prev ? delta(cur?.read ?? 0, prev.read).direction : undefined}
        />
        <MetricCard
          loading={loading}
          label="Failed"
          value={cur?.failed ?? 0}
          rateText={failedRate.text}
          rateLabel={failedRate.thin ? "attempts failed" : "of attempts"}
          thin={failedRate.thin}
          deltaText={prev ? delta(cur?.failed ?? 0, prev.failed).text : undefined}
          direction={prev ? (delta(cur?.failed ?? 0, prev.failed).direction === 1 ? -1 : 1) : undefined}
        />
        <MetricCard
          loading={loading}
          label="Replies received"
          value={cur?.replies ?? 0}
          rateText={replyRate.text}
          rateLabel={replyRate.thin ? "replies per sent message" : "of sent"}
          thin={replyRate.thin}
          deltaText={prev ? delta(cur?.replies ?? 0, prev.replies).text : undefined}
          direction={prev ? delta(cur?.replies ?? 0, prev.replies).direction : undefined}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard
          loading={loading}
          label="New contacts"
          value={cur?.new_contacts ?? 0}
          deltaText={prev ? delta(cur?.new_contacts ?? 0, prev.new_contacts).text : undefined}
          direction={prev ? delta(cur?.new_contacts ?? 0, prev.new_contacts).direction : undefined}
        />
        <MetricCard
          loading={loading}
          label="Opt-outs"
          value={cur?.opt_outs ?? 0}
          deltaText={prev ? delta(cur?.opt_outs ?? 0, prev.opt_outs).text : undefined}
          direction={
            prev ? (delta(cur?.opt_outs ?? 0, prev.opt_outs).direction === 1 ? -1 : 1) : undefined
          }
        />
        <MetricCard
          loading={loading}
          label="Open conversations"
          value={overview?.open_conversations ?? 0}
        />
      </div>

      <ChartCard
        title="Message volume"
        description="Sent, delivered, read and failed per day, plus replies received."
        loading={loading}
        isEmpty={!hasMessages}
        emptyIcon={MessageSquare}
        emptyTitle="No messages in this period"
        emptyDescription="Send a campaign or reply from the inbox and daily volume will appear here."
      >
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={series} margin={{ left: -20, right: 8, top: 8 }}>
            <defs>
              <linearGradient id="sentFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="day" tickFormatter={shortDay} {...axis} />
            <YAxis allowDecimals={false} {...axis} />
            <Tooltip contentStyle={tooltipStyle} />
            <Area
              type="monotone"
              dataKey="sent"
              name="Sent"
              stroke="var(--primary)"
              fill="url(#sentFill)"
              strokeWidth={2}
            />
            <Line type="monotone" dataKey="read" name="Read" stroke="#0ea5e9" strokeWidth={2} dot={false} />
            <Line
              type="monotone"
              dataKey="replies"
              name="Replies"
              stroke="#8b5cf6"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="failed"
              name="Failed"
              stroke="var(--destructive)"
              strokeWidth={2}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Audience movement"
        description="New contacts against opt-outs — a rising opt-out line is the first sign of over-messaging."
        loading={loading}
        isEmpty={!hasContactActivity}
        emptyIcon={Activity}
        emptyTitle="No audience changes yet"
        emptyDescription="Import contacts or receive a first message and this chart fills in."
      >
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={series} margin={{ left: -20, right: 8, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="day" tickFormatter={shortDay} {...axis} />
            <YAxis allowDecimals={false} {...axis} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line
              type="monotone"
              dataKey="new_contacts"
              name="New contacts"
              stroke="var(--primary)"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="opt_outs"
              name="Opt-outs"
              stroke="var(--destructive)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
