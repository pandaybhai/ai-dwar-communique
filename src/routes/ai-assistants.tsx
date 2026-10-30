import { createFileRoute } from "@tanstack/react-router";
import {
  AiAssistantsPublic,
  PUBLIC_DESCRIPTION,
  PUBLIC_TITLE,
} from "@/components/site-v2/ai-assistants-public";

/**
 * Batch 53: the public page about AiDwar MCP for merchants. New look for
 * everyone (signed in or not), whatever the new_site switch says.
 */
export const Route = createFileRoute("/ai-assistants")({
  head: () => ({
    meta: [
      { title: PUBLIC_TITLE },
      { name: "description", content: PUBLIC_DESCRIPTION },
      { property: "og:title", content: PUBLIC_TITLE },
      { property: "og:description", content: PUBLIC_DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://aidwar.in/ai-assistants" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://aidwar.in/ai-assistants" }],
  }),
  component: AiAssistantsPublic,
});
