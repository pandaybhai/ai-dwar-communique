import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { PageSkeleton } from "@/components/empty-state";

export const Route = createFileRoute("/app/")({
  head: () => ({
    meta: [
      { title: "Workspace — AiDwar" },
      { name: "description", content: "Your AiDwar workspace." },
      { property: "og:title", content: "Workspace — AiDwar" },
      { property: "og:description", content: "Your AiDwar workspace." },
    ],
  }),
  component: AppHome,
});

function AppHome() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate({ to: "/app/inbox", replace: true });
  }, [navigate]);
  return <PageSkeleton />;
}
