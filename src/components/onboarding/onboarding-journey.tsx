import { useCallback, useEffect, useState } from "react";
import { TalkToAidenBanner } from "@/components/onboarding/talk-to-aiden";
import { useNavigate } from "@tanstack/react-router";
import { JourneyShell } from "@/components/onboarding/journey-shell";
import { StepBusiness } from "@/components/onboarding/step-business";
import { StepConnect } from "@/components/onboarding/step-connect";
import { StepAiden } from "@/components/onboarding/step-aiden";
import { StepLive } from "@/components/onboarding/step-live";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { callApi } from "@/lib/whatsapp-client";
import {
  EXITED_KEY,
  TOUR_KEY,
  journeyApi,
  takeAttribution,
  writeStorage,
  type JourneyStateReply,
  type SiteBrand,
} from "@/lib/onboarding-client";
import { landingStep, resumeStep, type JourneyStep } from "@/lib/onboarding-journey";
import { trackStartTrial } from "@/lib/meta-pixel";
import { beginBusiness } from "@/lib/onboarding-begin";

/**
 * Batch 40: the whole first run, full screen — Your business → Connect
 * WhatsApp → Meet Aiden → Go live. Where a workspace is comes from the
 * server (facts, not a stored step), and the URL always carries the step on
 * screen, so a reload or a nudge's link lands exactly there.
 *
 * Without a workspace yet (a brand-new sign-up), step 1 creates it the way
 * it always was created (create_organization) and then carries on here.
 */
export function OnboardingJourney({
  organizationId,
  requested,
  onWorkspaceCreated,
}: {
  organizationId: string | null;
  requested: JourneyStep | null;
  onWorkspaceCreated?: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [reply, setReply] = useState<JourneyStateReply | null>(null);
  const [step, setStep] = useState<JourneyStep | null>(organizationId ? null : "business");
  const [brandColor, setBrandColor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!organizationId) return null;
    const res = await journeyApi<JourneyStateReply>({
      action: "state",
      organization_id: organizationId,
    });
    if (res.data) {
      setReply(res.data);
      setLoadError(null);
    } else setLoadError(res.error ?? "We couldn't load your setup.");
    return res.data;
  }, [organizationId]);

  // First visit: land on the asked-for step if it's open, else where they stopped.
  useEffect(() => {
    if (!organizationId) return;
    void refresh().then((data) => {
      if (data) setStep(landingStep(data.state.facts, requested));
    });
    // `requested` is read once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, refresh]);

  const goTo = useCallback(
    (next: JourneyStep) => {
      setStep(next);
      if (organizationId)
        void navigate({ to: "/app/start", search: { step: next }, replace: true });
      if (typeof window !== "undefined") window.scrollTo({ top: 0 });
    },
    [navigate, organizationId],
  );

  const state = reply?.state ?? null;
  const business = state?.business.name || "your business";
  const reached = state ? resumeStep(state.facts) : "business";
  const color = brandColor ?? state?.business.color ?? null;

  async function submitBusiness(input: {
    name: string;
    url: string | null;
    about: string | null;
    brand: SiteBrand | null;
    noWebsite?: boolean;
  }): Promise<string | null> {
    // Batch 78: one create path for both choices (website / no website):
    // create_organization from the name, the journey's begin, then the
    // WhatsApp setup session — so a nudge can reach the owner and "chat from
    // your phone" works on Meet Aiden.
    const begun = await beginBusiness(organizationId, input, {
      createOrganization: async (name) => {
        const { data, error } = await aidwar.rpc("create_organization", { org_name: name });
        return { id: (data as string | null) ?? null, error };
      },
      onCreated: async (orgId, name) => {
        await logActivity("organization.created", orgId, { name });
        // Batch 70: trial started — the server sends its copy and says what
        // the pixel fires. Never awaited by setup.
        trackStartTrial(orgId);
      },
      journey: async (payload) => journeyApi<{ source_id?: string }>(payload),
      startSession: (body) =>
        callApi("/api/onboarding/start", { body: { ...body, attribution: takeAttribution() } }),
    });
    if (!begun.ok) return begun.error;

    if (!organizationId) {
      await navigate({ to: "/app/start", search: { step: "connect" }, replace: true });
      await onWorkspaceCreated?.();
      return null;
    }
    await refresh();
    goTo("connect");
    return null;
  }

  const exit = organizationId ? (
    <button
      type="button"
      onClick={() => {
        writeStorage("session", EXITED_KEY(organizationId), "1");
        void navigate({ to: "/app" });
      }}
      className="rounded-full px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      Save &amp; exit
    </button>
  ) : null;

  const current: JourneyStep = step ?? requested ?? "business";

  return (
    <JourneyShell step={current} reached={reached} brandColor={color} onStep={goTo} exit={exit}>
      {/* Batch 75: Talk to Aiden on WhatsApp first, on every step but Aiden's own. */}
      {organizationId && current !== "aiden" ? (
        <TalkToAidenBanner organizationId={organizationId} />
      ) : null}
      {organizationId && (!state || !step) ? (
        loadError ? (
          <p
            role="alert"
            className="rounded-2xl bg-danger-soft p-4 text-sm text-danger-soft-foreground"
          >
            {loadError}
          </p>
        ) : (
          <div className="space-y-4" aria-busy="true" aria-label="Loading your setup">
            <div className="h-6 w-40 animate-pulse rounded-full bg-muted" />
            <div className="h-14 w-full max-w-2xl animate-pulse rounded-2xl bg-muted" />
            <div className="h-14 w-full max-w-xl animate-pulse rounded-2xl bg-muted" />
          </div>
        )
      ) : current === "business" ? (
        <StepBusiness
          existingName={state?.business.name || null}
          existingUrl={state?.website?.url ?? null}
          onBrand={setBrandColor}
          onSubmit={submitBusiness}
        />
      ) : current === "connect" && organizationId ? (
        <StepConnect
          organizationId={organizationId}
          business={business}
          connected={state?.number ?? null}
          ownerPhone={reply?.owner_phone ?? null}
          onConnected={async () => {
            await refresh();
          }}
          onContinue={() => goTo("aiden")}
          onSkip={async () => {
            await journeyApi({
              action: "mark",
              organization_id: organizationId,
              step: "connect_skipped",
            });
            await refresh();
            goTo("aiden");
          }}
        />
      ) : current === "aiden" && organizationId ? (
        <StepAiden
          organizationId={organizationId}
          business={business}
          logoUrl={state?.business.logoUrl ?? null}
          host={state?.website?.host ?? null}
          onContinue={() => {
            void refresh();
            goTo("live");
          }}
        />
      ) : current === "live" && organizationId ? (
        <StepLive
          organizationId={organizationId}
          business={business}
          connected={Boolean(state?.number)}
          currentMode={state?.mode ?? "off"}
          onNeedsTest={() => goTo("aiden")}
          onConnect={() => goTo("connect")}
          onLive={(mode) => {
            writeStorage("local", TOUR_KEY(organizationId), `pending:${mode}`);
            void navigate({ to: "/app/inbox" });
          }}
        />
      ) : null}
    </JourneyShell>
  );
}
