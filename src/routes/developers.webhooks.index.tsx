import { createFileRoute } from "@tanstack/react-router";
import { pageById } from "@/lib/developer-portal";
import { docHead } from "@/components/developers/doc-head";
import { DocPage } from "@/components/developers/doc-page";

/** /developers/webhooks (Batch 38 item 9). */
export const Route = createFileRoute("/developers/webhooks/")({
  head: () => docHead(pageById("webhooks")),
  component: () => <DocPage page={pageById("webhooks")} />,
});
