import { createFileRoute } from "@tanstack/react-router";
import { pageByPath, referencePath } from "@/lib/developer-portal";
import { docHeadFor } from "@/components/developers/doc-route";
import { DocPage } from "@/components/developers/doc-page";

/** /developers/reference/{endpoint}: one page per endpoint (Batch 38 item 9). */
export const Route = createFileRoute("/developers/reference/$endpoint")({
  // A plain path here: the loader stays in the app's main bundle (see docHeadFor).
  loader: ({ params }) => docHeadFor(`/developers/reference/${params.endpoint}`),
  head: ({ loaderData }) => loaderData ?? {},
  component: Reference,
});

function Reference() {
  const { endpoint } = Route.useParams();
  return <DocPage page={pageByPath(referencePath(endpoint))!} />;
}
