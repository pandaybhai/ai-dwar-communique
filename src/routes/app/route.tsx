import { createFileRoute, Navigate, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { aidwar } from "@/integrations/aidwar/client";
import { OrgProvider, useOrg } from "@/lib/org-context";
import { AppShell } from "@/components/app-shell";
import { OnboardingJourney } from "@/components/onboarding/onboarding-journey";
import { ErrorState, PageSkeleton } from "@/components/empty-state";

/** /login's ?redirect= for a page under /app; Home needs none. */
export function loginSearch(href: string): { redirect?: string } {
  return href.startsWith("/app/") || href.startsWith("/app?") ? { redirect: href } : {};
}

export const Route = createFileRoute("/app")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    // getSession() reads the locally stored session; getUser() costs a full
    // network round trip before anything can render, which is painful on 4G.
    const { data, error } = await aidwar.auth.getSession();
    if (error || !data.session?.user) {
      // Batch 40: keep where they were going. A link from WhatsApp (connect,
      // a nudge's step) used to land on Home after the login.
      throw redirect({ to: "/login", search: loginSearch(location.href) });
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
    // Batch 40: a new sign-up starts the first-run journey; step 1 creates
    // the workspace (create_organization, as before).
    return <OnboardingJourney organizationId={null} requested={null} onWorkspaceCreated={reload} />;
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

  // The journey is full screen: no sidebar, nothing else to look at.
  if (pathname === "/app/start" || pathname.startsWith("/app/start/")) return <Outlet />;

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
