import { createFileRoute } from "@tanstack/react-router";
import { eventPath, pageByPath } from "@/lib/developer-portal";
import { docHeadFor } from "@/components/developers/doc-route";
import { DocPage } from "@/components/developers/doc-page";

/** /developers/webhooks/{event}: one page per event (Batch 38 item 9). */
export const Route = createFileRoute("/developers/webhooks/$event")({
  // A plain path here: the loader stays in the app's main bundle (see docHeadFor).
  loader: ({ params }) => docHeadFor(`/developers/webhooks/${params.event}`),
  head: ({ loaderData }) => loaderData ?? {},
  component: Event,
});

function Event() {
  const { event } = Route.useParams();
  return <DocPage page={pageByPath(eventPath(event))!} />;
}
