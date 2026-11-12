import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 75: the reminder's "Finish sign-up" link (aidwar.in/start/continue?t=…)
 * resumes exactly one /start lead: it answers that lead's name, number and
 * any answers already given, and signs the same lead into this browser's
 * cookie so the questions can be saved. A lead that already has an account
 * is sent to log in instead. Never lists or reveals any other lead.
 */
export const Route = createFileRoute("/api/public/start-continue")({
  server: {
    handlers: {
      GET: async () => Response.json({ error: "Not allowed." }, { status: 405 }),
      POST: async ({ request }) => {
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { readContinueToken, startLeadSetCookie } =
          await import("@/lib/start-lead-cookie.server");
        let token = "";
        try {
          const body = JSON.parse((await request.text()).slice(0, 2000)) as Record<string, unknown>;
          token = typeof body["t"] === "string" ? body["t"] : "";
        } catch {
          token = "";
        }
        const leadId = await readContinueToken(token);
        if (!leadId) {
          return Response.json({ error: "This link has expired." }, { status: 410 });
        }
        const supabase = getServiceClient();
        const { data } = await supabase
          .from("demo_leads")
          .select("id, name, phone, source, qualification, linked_user_id, organization_id")
          .eq("id", leadId)
          .maybeSingle();
        const lead = data as {
          id: string;
          name: string | null;
          phone: string;
          source: string;
          qualification: { sells?: string; customers?: string } | null;
          linked_user_id: string | null;
          organization_id: string | null;
        } | null;
        if (!lead || lead.source !== "landing_start") {
          return Response.json({ error: "This link has expired." }, { status: 410 });
        }
        if (lead.linked_user_id || lead.organization_id) {
          return Response.json({ ok: true, signed_up: true });
        }
        const headers = new Headers();
        headers.append("set-cookie", await startLeadSetCookie(lead.id));
        return Response.json(
          {
            ok: true,
            signed_up: false,
            name: lead.name ?? "",
            phone: lead.phone,
            sells: lead.qualification?.sells ?? null,
            customers: lead.qualification?.customers ?? null,
          },
          { headers },
        );
      },
    },
  },
});
