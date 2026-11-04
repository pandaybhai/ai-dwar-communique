import { createFileRoute, Navigate, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { aidwar } from "@/integrations/aidwar/client";
import { OrgProvider, useOrg } from "@/lib/org-context";
import { AppShell } from "@/components/app-shell";
import { OnboardingJourney } from "@/components/onboarding/onboarding-journey";
import { ErrorState, PageSkeleton } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppSurface } from "@/lib/theme";
import { useDesignSettled, useDesignSurface, useNewDesign } from "@/lib/new-design";
import { NewAppShell } from "@/components/shell/new-shell";

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
  // Batch 58: /app is client-only, so the server used to send an empty body
  // and nothing painted until the session check and every route chunk (Home's
  // too) had loaded. The loading skeleton AppGate shows is now rendered by the
  // server as well, at once and for as long as needed — the same markup, just
  // earlier.
  pendingComponent: AppPending,
  pendingMs: 0,
  pendingMinMs: 0,
  component: () => (
    <OrgProvider>
      <AppGate />
    </OrgProvider>
  ),
});

function AppGate() {
  useAppSurface();
  const { loading, error, active, reload } = useOrg();
  // Batch 44: the new design, per workspace (flag `new_design`, off = classic).
  const newDesign = useNewDesign() && Boolean(active);
  useDesignSurface(newDesign, useDesignSettled());
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (loading) return <AppPending />;

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

  if (newDesign) {
    return (
      <NewAppShell>
        <Outlet />
      </NewAppShell>
    );
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/**
 * The app while it loads: AppGate's loading skeleton exactly as before
 * (Classic sees the same page, only sooner). Under Aiden Workspace's surface
 * (html[data-design="new"], set before paint from this browser's cache) a top
 * bar placeholder shows above it, where the new shell's bar will be.
 */
export function AppPending() {
  return (
    <div className="min-h-screen bg-muted/30 px-5 py-12 sm:px-8 nd:bg-background nd:p-0">
      <div
        aria-hidden="true"
        className="hidden nd:flex h-16 items-center gap-6 border-b border-line bg-surface px-6"
      >
        <Skeleton className="h-8 w-28 rounded-lg" />
        <div className="flex gap-2">
          <Skeleton className="h-7 w-16 rounded-full" />
          <Skeleton className="h-7 w-20 rounded-full" />
          <Skeleton className="h-7 w-20 rounded-full" />
          <Skeleton className="h-7 w-16 rounded-full" />
        </div>
        <Skeleton className="ml-auto h-9 w-9 rounded-full" />
      </div>
      <div className="mx-auto max-w-5xl nd:max-w-[1180px] nd:px-6 nd:py-10">
        <PageSkeleton />
      </div>
    </div>
  );
}
