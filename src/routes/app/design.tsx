import { createFileRoute } from "@tanstack/react-router";
import { DesignSystemPage } from "@/components/design/design-system-page";
import { NewDesignSystemPage } from "@/components/design-v2/design-page";
import { useNewDesign } from "@/lib/new-design";

/**
 * Batch 39: the design system's reference — every token and component, in
 * both themes. Not in the navigation; reviewers and later batches open it by
 * address (/app/design) or from the command palette.
 */
export const Route = createFileRoute("/app/design")({
  head: () => ({
    meta: [{ title: "Design system — AiDwar" }, { name: "robots", content: "noindex" }],
  }),
  component: DesignRoute,
});

/** Batch 44: the new design's reference when the workspace has it on, the classic one otherwise. */
function DesignRoute() {
  return useNewDesign() ? <NewDesignSystemPage /> : <DesignSystemPage />;
}
