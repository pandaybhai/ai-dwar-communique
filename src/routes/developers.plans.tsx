import { createFileRoute } from "@tanstack/react-router";
import { pageById } from "@/lib/developer-portal";
import { docHeadFor } from "@/components/developers/doc-route";
import { DocPage } from "@/components/developers/doc-page";

/** /developers/plans (Batch 38 item 9), from the portal's content (src/lib/developer-portal.ts). */
export const Route = createFileRoute("/developers/plans")({
  loader: () => docHeadFor("/developers/plans"),
  head: ({ loaderData }) => loaderData ?? {},
  component: () => <DocPage page={pageById("plans")} />,
});
