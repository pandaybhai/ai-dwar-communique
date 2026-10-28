import { createFileRoute } from "@tanstack/react-router";
import { guidePath, pageByPath } from "@/lib/developer-portal";
import { docHeadFor } from "@/components/developers/doc-route";
import { DocPage } from "@/components/developers/doc-page";

/** /developers/guides/{slug} (Batch 38 item 9). */
export const Route = createFileRoute("/developers/guides/$slug")({
  // A plain path here: the loader stays in the app's main bundle (see docHeadFor).
  loader: ({ params }) => docHeadFor(`/developers/guides/${params.slug}`),
  head: ({ loaderData }) => loaderData ?? {},
  component: Guide,
});

function Guide() {
  const { slug } = Route.useParams();
  return <DocPage page={pageByPath(guidePath(slug))!} />;
}
