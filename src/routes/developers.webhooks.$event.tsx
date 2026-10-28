import { createFileRoute, notFound } from "@tanstack/react-router";
import { eventPath, pageByPath } from "@/lib/developer-portal";
import { docHead } from "@/components/developers/doc-head";
import { DocPage } from "@/components/developers/doc-page";

/** /developers/webhooks/{event}: one page per event (Batch 38 item 9). */
export const Route = createFileRoute("/developers/webhooks/$event")({
  loader: ({ params }) => {
    if (!pageByPath(eventPath(params.event))) throw notFound();
    return params.event;
  },
  head: ({ params }) => {
    const page = pageByPath(eventPath(params.event));
    return page ? docHead(page) : {};
  },
  component: Event,
});

function Event() {
  const { event } = Route.useParams();
  return <DocPage page={pageByPath(eventPath(event))!} />;
}
