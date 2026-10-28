import { createFileRoute } from "@tanstack/react-router";
import { pageById } from "@/lib/developer-portal";
import { docHeadFor } from "@/components/developers/doc-route";
import { DocPage } from "@/components/developers/doc-page";

/** /developers/webhooks (Batch 38 item 9). */
export const Route = createFileRoute("/developers/webhooks/")({
  loader: () => docHeadFor("/developers/webhooks"),
  head: ({ loaderData }) => loaderData ?? {},
  component: () => <DocPage page={pageById("webhooks")} />,
});
