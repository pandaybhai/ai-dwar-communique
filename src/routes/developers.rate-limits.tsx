import { createFileRoute } from "@tanstack/react-router";
import { pageById } from "@/lib/developer-portal";
import { docHead } from "@/components/developers/doc-head";
import { DocPage } from "@/components/developers/doc-page";

/** /developers/rate-limits (Batch 38 item 9), from the portal's content (src/lib/developer-portal.ts). */
export const Route = createFileRoute("/developers/rate-limits")({
  head: () => docHead(pageById("rate-limits")),
  component: () => <DocPage page={pageById("rate-limits")} />,
});
