import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { PageSkeleton } from "@/components/empty-state";

export const Route = createFileRoute("/admin/")({
  component: AdminHome,
});

function AdminHome() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate({ to: "/admin/organizations", replace: true });
  }, [navigate]);
  return <PageSkeleton />;
}
