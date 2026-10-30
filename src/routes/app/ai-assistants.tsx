import { createFileRoute } from "@tanstack/react-router";
import { AiAssistantsPage, PAGE_DESCRIPTION } from "@/components/ai-assistants/ai-assistants-page";

export const Route = createFileRoute("/app/ai-assistants")({
  head: () => ({
    meta: [
      { title: "AI assistants — AiDwar" },
      { name: "description", content: PAGE_DESCRIPTION },
      { property: "og:title", content: "AI assistants — AiDwar" },
      { property: "og:description", content: PAGE_DESCRIPTION },
    ],
  }),
  component: AiAssistantsPage,
});
