import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { RESPONSES_PAGE_SIZE, responsesCsv } from "@/lib/flow-responses";

const Filters = z
  .object({
    from: z.string().datetime().nullish(),
    to: z.string().datetime().nullish(),
    status: z.enum(["all", "finished", "waiting", "stopped", "failed"]).default("all"),
    search: z.string().max(100).nullish(),
  })
  .default({});

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    organization_id: z.string().uuid(),
    flow_id: z.string().uuid(),
    filters: Filters,
    page: z.number().int().min(0).max(10000).default(0),
    summary: z.boolean().default(true),
  }),
  z.object({ action: z.literal("export"), organization_id: z.string().uuid(), flow_id: z.string().uuid(), filters: Filters }),
]);

/**
 * Flows v2 Responses tab: what each customer answered in one chat flow.
 * list → one page (50) of runs + summary; export → the filtered rows as CSV.
 * Viewing needs contacts.view; the CSV also needs contacts.export.
 */
export const Route = createFileRoute("/api/flows/responses")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError, requirePermission, logServerActivity } = await import(
          "@/lib/whatsapp-api.server"
        );
        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch {
          return jsonError("Invalid request.");
        }
        const auth = await requireOrgMember(request, body.organization_id);
        if (isResponse(auth)) return auth;
        const denied =
          (await requirePermission(auth, "contacts.view", "view flow responses")) ??
          (body.action === "export" ? await requirePermission(auth, "contacts.export", "download flow responses") : null);
        if (denied) return denied;
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const db = getServiceClient();
        const org = auth.organizationId;
        const { flowsV2Enabled } = await import("@/lib/flow-engine.server");
        if (!(await flowsV2Enabled(db, org))) return jsonError("Flows v2 isn't switched on for this workspace.", 403);
        const { loadResponsesContext, listResponses, responsesSummary, exportResponses } = await import(
          "@/lib/flow-responses.server"
        );
        const ctx = await loadResponsesContext(db, org, body.flow_id);
        if (!ctx) return jsonError("Flow not found.", 404);
        const columns = ctx.columns.map(({ key, label, kind }) => ({ key, label, kind }));

        if (body.action === "list") {
          const [page, summary] = await Promise.all([
            listResponses(db, ctx, body.filters, body.page, RESPONSES_PAGE_SIZE),
            body.summary ? responsesSummary(db, ctx, body.filters) : Promise.resolve(null),
          ]);
          if (page.error) return jsonError("Couldn't load the responses. Please try again.", 500);
          return Response.json({
            ok: true,
            columns,
            rows: page.rows,
            total: page.total,
            page: body.page,
            page_size: RESPONSES_PAGE_SIZE,
            summary,
          });
        }

        const out = await exportResponses(db, ctx, body.filters);
        if (out.error) return jsonError("Couldn't prepare the download. Please try again.", 500);
        const { data: orgRow } = await db.from("organizations").select("timezone").eq("id", org).maybeSingle();
        const timezone = (orgRow as { timezone?: string | null } | null)?.timezone || "Asia/Kolkata";
        await logServerActivity(db, org, auth.userId, "flow_responses_exported", {
          flow_id: body.flow_id,
          rows: out.rows.length,
          truncated: out.truncated,
        });
        const slug = ctx.flowName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "flow";
        return new Response(responsesCsv(ctx.columns, out.rows, timezone), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${slug}-responses-${new Date().toISOString().slice(0, 10)}.csv"`,
            "cache-control": "no-store",
            "x-rows": String(out.rows.length),
            "x-truncated": out.truncated ? "1" : "0",
          },
        });
      },
    },
  },
});
