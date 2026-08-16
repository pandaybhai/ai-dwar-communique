import { Inbox, Timer, Users } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard, MetricCard } from "@/components/analytics/chart-card";
import { duration, shortDay, type ResponseTimes, type SeriesPoint, type TeamRow } from "@/lib/analytics";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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

export function AnalyticsInbox({
  response,
  team,
  series,
  loading,
}: {
  response: ResponseTimes | null;
  team: TeamRow[];
  series: SeriesPoint[];
  loading: boolean;
}) {
  const answered = Number(response?.answered ?? 0);
  const bursts = Number(response?.inbound_bursts ?? 0);
  const thin = answered > 0 && answered < 10;
  const hasConversationFlow = series.some(
    (p) => p.conversations_opened + p.conversations_closed > 0,
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard
          loading={loading}
          label="Median first response"
          value={0}
          rateText={duration(response?.median_seconds ?? null)}
          rateLabel="typical wait before a human replies"
        />
        <MetricCard
          loading={loading}
          label="90th percentile"
          value={0}
          rateText={duration(response?.p90_seconds ?? null)}
          rateLabel="the slow tail your customers feel"
        />
        <MetricCard
          loading={loading}
          label="Conversations answered"
          value={answered}
          rateText={`${answered} of ${bursts}`}
          rateLabel="inbound conversations got a human reply"
          thin
        />
      </div>

      {thin ? (
        <p className="text-xs text-muted-foreground">
          Based on {answered} answered conversation{answered === 1 ? "" : "s"} — treat these times
          as indicative until the inbox sees more traffic. Automation replies and opt-out
          confirmations are excluded.
        </p>
      ) : null}

      <ChartCard
        title="Conversations handled per team member"
        description="Human replies only — automation sends never count towards a person."
        loading={loading}
        isEmpty={team.length === 0}
        emptyIcon={Users}
        emptyTitle="No inbox activity in this period"
        emptyDescription="When your team replies from the shared inbox, their workload shows up here."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Team member</TableHead>
              <TableHead className="text-right">Conversations</TableHead>
              <TableHead className="text-right">Replies sent</TableHead>
              <TableHead className="text-right">Closed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {team.map((member) => (
              <TableRow key={member.user_id}>
                <TableCell>
                  <span className="font-medium text-foreground">
                    {member.full_name ?? member.email ?? "Unknown member"}
                  </span>
                  {member.full_name && member.email ? (
                    <span className="ml-2 text-xs text-muted-foreground">{member.email}</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">{Number(member.conversations_handled)}</TableCell>
                <TableCell className="text-right">{Number(member.replies_sent)}</TableCell>
                <TableCell className="text-right">{Number(member.conversations_closed)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ChartCard>

      <ChartCard
        title="Conversations opened vs closed"
        description="A gap that keeps widening means threads are piling up unanswered."
        loading={loading}
        isEmpty={!hasConversationFlow}
        emptyIcon={Inbox}
        emptyTitle="No conversations in this period"
        emptyDescription="New threads and closures will be charted here day by day."
      >
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={series} margin={{ left: -20, right: 8, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="day" tickFormatter={shortDay} {...axis} />
            <YAxis allowDecimals={false} {...axis} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--muted)" }} />
            <Bar dataKey="conversations_opened" name="Opened" fill="var(--primary)" radius={[8, 8, 0, 0]} />
            <Bar dataKey="conversations_closed" name="Closed" fill="#0ea5e9" radius={[8, 8, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {!loading && bursts === 0 ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Timer className="h-3.5 w-3.5" /> No inbound conversations started in this period, so
          response times have nothing to measure yet.
        </p>
      ) : null}
    </div>
  );
}
