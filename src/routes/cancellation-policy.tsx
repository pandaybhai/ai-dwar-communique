import { createFileRoute, redirect } from "@tanstack/react-router";

/** Old or guessed address for the refunds policy: a permanent redirect to /refunds. */
export const Route = createFileRoute("/cancellation-policy")({
  beforeLoad: () => {
    throw redirect({ to: "/refunds", statusCode: 301 });
  },
});
