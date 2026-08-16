import { ShieldCheck } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard } from "@/components/analytics/chart-card";
import { QUALITY_SCORE, type QualityPoint } from "@/lib/analytics";

const LABELS: Record<number, string> = { 0: "Unknown", 1: "Red", 2: "Yellow", 3: "Green" };

export function AnalyticsQuality({
  points,
  timezone,
  loading,
}: {
  points: QualityPoint[];
  timezone: string;
  loading: boolean;
}) {
  const data = points.map((p) => ({
    at: new Intl.DateTimeFormat("en-IN", {
      timeZone: timezone || "UTC",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(p.recorded_at)),
    score: QUALITY_SCORE[p.quality_rating] ?? 0,
    rating: p.quality_rating,
  }));

  return (
    <ChartCard
      title="Number quality over time"
      description="Every quality rating reported by the platform, plus each manual refresh."
      loading={loading}
      isEmpty={data.length === 0}
      emptyIcon={ShieldCheck}
      emptyTitle="Quality history starts now"
      emptyDescription="Only the current rating was stored before today. From this point on, every quality change and manual refresh is recorded, and the timeline will fill in."
    >
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ left: -10, right: 8, top: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="at"
            stroke="var(--muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={[0, 3]}
            ticks={[0, 1, 2, 3]}
            tickFormatter={(v: number) => LABELS[v] ?? ""}
            stroke="var(--muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={70}
          />
          <Tooltip
            contentStyle={{
              borderRadius: 12,
              border: "1px solid var(--border)",
              background: "var(--card)",
              fontSize: 12,
            }}
            formatter={(value: number) => LABELS[value] ?? "Unknown"}
          />
          <Line
            type="stepAfter"
            dataKey="score"
            name="Quality"
            stroke="var(--primary)"
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
