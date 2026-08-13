import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { aidwar } from "@/integrations/aidwar/client";
import { AdminShell } from "@/components/admin-shell";

export const Route = createFileRoute("/admin")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await aidwar.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/login" });

    // Server-side enforced: this row is only readable/true for super admins.
    const { data: allowed } = await aidwar.rpc("is_super_admin");
    if (allowed !== true) throw redirect({ to: "/app" });

    return { user: data.user };
  },
  component: () => (
    <AdminShell>
      <Outlet />
    </AdminShell>
  ),
});
