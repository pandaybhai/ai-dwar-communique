import { createFileRoute, notFound } from "@tanstack/react-router";
import { guidePath, pageByPath } from "@/lib/developer-portal";
import { docHead } from "@/components/developers/doc-head";
import { DocPage } from "@/components/developers/doc-page";

/** /developers/guides/{slug} (Batch 38 item 9). */
export const Route = createFileRoute("/developers/guides/$slug")({
  loader: ({ params }) => {
    const page = pageByPath(guidePath(params.slug));
    if (!page) throw notFound();
    return page.id;
  },
  head: ({ params }) => {
    const page = pageByPath(guidePath(params.slug));
    return page ? docHead(page) : {};
  },
  component: Guide,
});

function Guide() {
  const { slug } = Route.useParams();
  return <DocPage page={pageByPath(guidePath(slug))!} />;
}
