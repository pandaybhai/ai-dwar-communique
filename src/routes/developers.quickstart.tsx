import { createFileRoute } from "@tanstack/react-router";
import { pageById } from "@/lib/developer-portal";
import { docHead } from "@/components/developers/doc-head";
import { DocPage } from "@/components/developers/doc-page";

/** /developers/quickstart (Batch 38 item 9), from the portal's content (src/lib/developer-portal.ts). */
export const Route = createFileRoute("/developers/quickstart")({
  head: () => docHead(pageById("quickstart")),
  component: () => <DocPage page={pageById("quickstart")} />,
});
