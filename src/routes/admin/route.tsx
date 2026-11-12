import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { aidwar } from "@/integrations/aidwar/client";
import { AdminShell } from "@/components/admin-shell";
import { OrgProvider } from "@/lib/org-context";

export const Route = createFileRoute("/admin")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await aidwar.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/login" });

    // Server-side enforced: this row is only readable/true for super admins.
    const { data: allowed } = await aidwar.rpc("is_super_admin");
    if (allowed === true) return { user: data.user, adminRole: "super_admin" as const };

    // Batch 76: the sales team sees Leads & Demos only. The server checks
    // every /api/admin/* call on its own; this only keeps the screens tidy.
    const { callApi } = await import("@/lib/whatsapp-client");
    const { data: access } = await callApi<{ role?: string }>("/api/admin/access", {
      method: "GET",
    });
    if (access?.role === "sales") {
      if (location.pathname !== "/admin/leads") throw redirect({ to: "/admin/leads" });
      return { user: data.user, adminRole: "sales" as const };
    }
    throw redirect({ to: "/app" });
  },
  component: AdminLayout,
});

function AdminLayout() {
  const { adminRole } = Route.useRouteContext();
  return (
    <OrgProvider>
      <AdminShell role={adminRole}>
        <Outlet />
      </AdminShell>
    </OrgProvider>
  );
}
