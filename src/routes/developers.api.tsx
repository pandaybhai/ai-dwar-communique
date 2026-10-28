import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The old one-page docs moved to the developer portal (Batch 38 item 9).
 * /developers/api redirects to /developers; the browser keeps any #anchor,
 * and the overview sends it on to the new page for that anchor
 * (LEGACY_ANCHORS in src/lib/developer-portal.ts).
 */
export const Route = createFileRoute("/developers/api")({
  beforeLoad: ({ location }) => {
    throw redirect({
      to: "/developers",
      ...(location.hash ? { hash: location.hash } : {}),
      statusCode: 301,
    });
  },
});
