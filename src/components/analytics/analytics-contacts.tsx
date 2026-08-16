import { PieChart as PieIcon, TrendingUp, UserMinus } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard } from "@/components/analytics/chart-card";
import {
  shortDay,
  type ContactsSummary,
  type SeriesPoint,
  type SourceRow,
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

const SOURCE_COLORS = ["var(--primary)", "#0ea5e9", "#8b5cf6", "#f59e0b", "#14b8a6", "#ef4444"];

export function AnalyticsContacts({
  series,
  summary,
  sources,
  loading,
}: {
  series: SeriesPoint[];
  summary: ContactsSummary | null;
  sources: SourceRow[];
  loading: boolean;
}) {
  let running = 0;
  const growth = series.map((p) => {
    running += Number(p.new_contacts);
    return { day: p.day, added: Number(p.new_contacts), cumulative: running };
  });

  const optSplit = summary
    ? [
        { name: "Opted in", value: summary.opted_in, color: "var(--primary)" },
        { name: "Opted out", value: summary.opted_out, color: "var(--destructive)" },
        { name: "Unknown", value: summary.unknown, color: "var(--muted-foreground)" },
      ].filter((s) => s.value > 0)
    : [];

  const sourceData = sources.map((s, i) => ({
    source: s.source,
    contacts: Number(s.contacts),
    color: SOURCE_COLORS[i % SOURCE_COLORS.length] as string,
  }));

  const hasOptOuts = series.some((p) => Number(p.opt_outs) > 0);

  return (
    <div className="space-y-6">
      <ChartCard
        title="Contact growth"
        description="Contacts added per day and the running total across the period."
        loading={loading}
        isEmpty={growth.every((g) => g.added === 0)}
        emptyIcon={TrendingUp}
        emptyTitle="No contacts added in this period"
        emptyDescription="Import a list or receive a first inbound message and growth will show up here."
      >
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={growth} margin={{ left: -20, right: 8, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="day" tickFormatter={shortDay} {...axis} />
            <YAxis allowDecimals={false} {...axis} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line
              type="monotone"
              dataKey="cumulative"
              name="Total contacts"
              stroke="var(--primary)"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="added"
              name="Added"
              stroke="#0ea5e9"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Where contacts come from"
          description="First-touch source for every contact in the workspace."
          loading={loading}
          isEmpty={sourceData.length === 0}
          emptyIcon={PieIcon}
          emptyTitle="No sources recorded yet"
          emptyDescription="Sources are captured the moment a contact first reaches you."
        >
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={sourceData} layout="vertical" margin={{ left: 20, right: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
              <XAxis type="number" allowDecimals={false} {...axis} />
              <YAxis type="category" dataKey="source" width={110} {...axis} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--muted)" }} />
              <Bar dataKey="contacts" name="Contacts" radius={[0, 8, 8, 0]}>
                {sourceData.map((entry) => (
                  <Cell key={entry.source} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Opt-in health"
          description="How much of your audience you are still allowed to message."
          loading={loading}
          isEmpty={optSplit.length === 0}
          emptyIcon={PieIcon}
          emptyTitle="No contacts yet"
          emptyDescription="Once contacts exist, their opt-in split appears here."
        >
          <div className="flex flex-col items-center gap-6 sm:flex-row">
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={optSplit}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={2}
                >
                  {optSplit.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
            <ul className="w-full shrink-0 space-y-2 sm:w-40">
              {optSplit.map((entry) => (
                <li key={entry.name} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: entry.color }}
                    />
                    {entry.name}
                  </span>
                  <span className="font-semibold text-foreground">{entry.value}</span>
                </li>
              ))}
            </ul>
          </div>
        </ChartCard>
      </div>

      <ChartCard
        title="Opt-outs over time"
        description="A rising line is the earliest signal you are messaging too often."
        loading={loading}
        isEmpty={!hasOptOuts}
        emptyIcon={UserMinus}
        emptyTitle="No opt-outs in this period"
        emptyDescription="Nobody unsubscribed — keep the sending cadence you have."
      >
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={series} margin={{ left: -20, right: 8, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="day" tickFormatter={shortDay} {...axis} />
            <YAxis allowDecimals={false} {...axis} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--muted)" }} />
            <Bar dataKey="opt_outs" name="Opt-outs" fill="var(--destructive)" radius={[8, 8, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
