import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/internal/tmp-reread")({
  server: { handlers: { POST: async ({ request }) => {
    if (request.headers.get("x-cron-secret") !== process.env["CRON_SECRET"]) return new Response("no", { status: 401 });
    const { id } = (await request.json()) as { id: string };
    const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
    const { syncSource } = await import("@/lib/knowledge.server");
    const sb = getServiceClient();
    const { data } = await sb.from("knowledge_sources").select("config").eq("id", id).single();
    const cfg = { ...((data?.config ?? {}) as Record<string, unknown>) };
    delete cfg["refresh"]; delete cfg["resume"];
    await sb.from("knowledge_sources").update({ config: cfg }).eq("id", id);
    return Response.json(await syncSource(sb, id));
  } } },
});
