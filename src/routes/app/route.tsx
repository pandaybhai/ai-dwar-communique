import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { aidwar } from "@/integrations/aidwar/client";
import { OrgProvider, useOrg } from "@/lib/org-context";
import { AppShell } from "@/components/app-shell";
import { OrgOnboarding } from "@/components/org-onboarding";
import { ErrorState, PageSkeleton } from "@/components/empty-state";

export const Route = createFileRoute("/app")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await aidwar.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/login" });
    }
    return { user: data.user };
  },
  component: () => (
    <OrgProvider>
      <AppGate />
    </OrgProvider>
  ),
});

function AppGate() {
  const { loading, error, active, reload } = useOrg();

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

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
