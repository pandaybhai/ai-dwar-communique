import { createFileRoute } from "@tanstack/react-router";
import { OnboardingJourney } from "@/components/onboarding/onboarding-journey";
import { useOrg } from "@/lib/org-context";
import { parseStep, type JourneyStep } from "@/lib/onboarding-journey";

const TITLE = "Set up Aiden — AiDwar";
const DESCRIPTION = "Four steps to an AI employee answering on your own WhatsApp.";

/**
 * Batch 40: the first-run journey. ?step= is the step on screen — a reload,
 * the chat's Connect link and the resume nudge all land on it (when it's open).
 */
export const Route = createFileRoute("/app/start")({
  validateSearch: (search: Record<string, unknown>): { step?: JourneyStep } => {
    const step = parseStep(search["step"]);
    return step ? { step } : {};
  },
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
    ],
  }),
  component: StartPage,
});

function StartPage() {
  const { active } = useOrg();
  const { step } = Route.useSearch();
  const orgId = active?.organization.id ?? null;
  if (!orgId) return null;
  return <OnboardingJourney key={orgId} organizationId={orgId} requested={step ?? null} />;
}
