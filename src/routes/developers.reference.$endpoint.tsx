import { createFileRoute, notFound } from "@tanstack/react-router";
import { pageByPath, referencePath } from "@/lib/developer-portal";
import { docHead } from "@/components/developers/doc-head";
import { DocPage } from "@/components/developers/doc-page";

/** /developers/reference/{endpoint}: one page per endpoint (Batch 38 item 9). */
export const Route = createFileRoute("/developers/reference/$endpoint")({
  loader: ({ params }) => {
    if (!pageByPath(referencePath(params.endpoint))) throw notFound();
    return params.endpoint;
  },
  head: ({ params }) => {
    const page = pageByPath(referencePath(params.endpoint));
    return page ? docHead(page) : {};
  },
  component: Reference,
});

function Reference() {
  const { endpoint } = Route.useParams();
  return <DocPage page={pageByPath(referencePath(endpoint))!} />;
}
