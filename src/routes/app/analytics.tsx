import { createFileRoute } from "@tanstack/react-router";
import { BarChart3 } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/empty-state";

export const Route = createFileRoute("/app/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics — AiDwar" },
      { name: "description", content: "Track delivery, reads, replies and revenue from every campaign." },
      { property: "og:title", content: "Analytics — AiDwar" },
      { property: "og:description", content: "Track delivery, reads, replies and revenue from every campaign." },
    ],
  }),
  component: AnalyticsPage,
});

function AnalyticsPage() {
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Delivery, read and reply rates, best-performing templates, and the revenue each campaign brings in."
      />
      <EmptyState
        icon={BarChart3}
        title="No data yet"
        description="Once your first campaign goes out, performance charts and conversion insights will appear here."
      />
    </>
  );
}
