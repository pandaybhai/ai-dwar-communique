import { createFileRoute } from "@tanstack/react-router";
import { pageById } from "@/lib/developer-portal";
import { docHeadFor } from "@/components/developers/doc-route";
import { DocPage } from "@/components/developers/doc-page";

/** /developers/changelog (Batch 38 item 9), from the portal's content (src/lib/developer-portal.ts). */
export const Route = createFileRoute("/developers/changelog")({
  loader: () => docHeadFor("/developers/changelog"),
  head: ({ loaderData }) => loaderData ?? {},
  component: () => <DocPage page={pageById("changelog")} />,
});
