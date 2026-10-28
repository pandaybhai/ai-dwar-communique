import { createFileRoute } from "@tanstack/react-router";
import { pageById } from "@/lib/developer-portal";
import { docHead } from "@/components/developers/doc-head";
import { DocPage } from "@/components/developers/doc-page";

/** /developers/reference — every endpoint, by resource (Batch 38 item 9). */
export const Route = createFileRoute("/developers/reference/")({
  head: () => docHead(pageById("reference")),
  component: () => <DocPage page={pageById("reference")} />,
});
