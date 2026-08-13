import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { PageSkeleton } from "@/components/empty-state";

export const Route = createFileRoute("/admin/")({
  head: () => ({
    meta: [
      { title: "Super Admin — AiDwar" },
      { name: "description", content: "Platform control centre for AiDwar." },
      { property: "og:title", content: "Super Admin — AiDwar" },
      { property: "og:description", content: "Platform control centre for AiDwar." },
    ],
  }),
  component: AdminHome,
});

function AdminHome() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate({ to: "/admin/organizations", replace: true });
  }, [navigate]);
  return <PageSkeleton />;
}
