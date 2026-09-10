import { createFileRoute, Navigate, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { aidwar } from "@/integrations/aidwar/client";
import { OrgProvider, useOrg } from "@/lib/org-context";
import { AppShell } from "@/components/app-shell";
import { OrgOnboarding } from "@/components/org-onboarding";
import { ErrorState, PageSkeleton } from "@/components/empty-state";

export const Route = createFileRoute("/app")({
  ssr: false,
  beforeLoad: async () => {
    // getSession() reads the locally stored session; getUser() costs a full
    // network round trip before anything can render, which is painful on 4G.
    const { data, error } = await aidwar.auth.getSession();
    if (error || !data.session?.user) {
      throw redirect({ to: "/login" });
    }
    return { user: data.session.user };
  },
  component: () => (
    <OrgProvider>
      <AppGate />
    </OrgProvider>
  ),
});

function AppGate() {
  const { loading, error, active, reload } = useOrg();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (loading) {
    return (
      <div className="min-h-screen bg-muted/30 px-5 py-12 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <PageSkeleton />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-muted/30 px-5 py-12 sm:px-8">
        <div className="mx-auto max-w-3xl">
          <ErrorState message={error} />
        </div>
      </div>
    );
  }

  if (!active) {
    return (
      <div className="min-h-screen bg-muted/30 px-5 py-10 sm:px-8">
        <OrgOnboarding onCreated={reload} />
      </div>
    );
  }

  // A locked or paused workspace keeps two pages: the inbox (read-only, so no
  // customer is left hanging) and billing, where it reactivates.
  const status = active.organization.plan_status;
  if (
    (status === "locked" || status === "paused") &&
    !pathname.startsWith("/app/billing") &&
    !pathname.startsWith("/app/inbox")
  ) {
    return <Navigate to="/app/billing" replace />;
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
