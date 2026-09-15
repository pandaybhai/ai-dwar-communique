import { createFileRoute } from "@tanstack/react-router";

/**
 * Internal only: builds the isolated demo fixture, captures real AI runs
 * against it, and publishes a sanitized capture to the public /demo page.
 *
 * Platform-authenticated with CRON_SECRET. There is deliberately NO public
 * anonymous path that generates an AI answer.
 */
export const Route = createFileRoute("/api/internal/demo-proof")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["CRON_SECRET"];
        const provided = request.headers.get("x-cron-secret");
        if (!secret || provided !== secret) {
          return Response.json({ error: "Not authorised." }, { status: 401 });
        }

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const action = String(body["action"] ?? "");

        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const proof = await import("@/lib/demo-proof.server");
        const supabase = getServiceClient();

        try {
          if (action === "build") {
            return Response.json({ ok: true, fixture: await proof.ensureFixture(supabase) });
          }
          if (action === "capture") {
            const scenario = String(body["scenario"] ?? "");
            if (scenario !== "grounded" && scenario !== "handoff") {
              return Response.json({ error: "Unknown scenario." }, { status: 400 });
            }
            return Response.json({ ok: true, run: await proof.captureScenario(supabase, scenario) });
          }
          if (action === "brief") {
            const ids = await proof.ensureFixture(supabase);
            const { assembleBrief } = await import("@/lib/ai-brief.server");
            const brief = await assembleBrief(supabase, ids.organizationId, ids.agentId, {});
            const q = String(body["question"] ?? "").toLowerCase();
            const hits = brief.text
              .toLowerCase()
              .split(/[\n,]/)
              .map((r) => r.trim())
              .filter((r) => r.length > 2 && q.includes(r));
            return Response.json({ hits, text: brief.text });
          }
          if (action === "publish") {
            const id = String(body["id"] ?? "");
            if (!id) return Response.json({ error: "Missing id." }, { status: 400 });
            const { error } = await supabase
              .from("demo_proof_runs")
              .update({ is_published: true })
              .eq("id", id);
            if (error) return Response.json({ error: error.message }, { status: 400 });
            return Response.json({ ok: true });
          }
          return Response.json({ error: "Unknown action." }, { status: 400 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed.";
          console.error("[demo-proof]", action, message);
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
