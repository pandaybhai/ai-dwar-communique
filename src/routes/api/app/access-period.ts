import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 82: a member's own workspace access period, for the in-app banner
 * ("Your AiDwar access ends on <date> — our team will call you, or choose a
 * plan"). POST { organization_id } with the member's session. Answers
 * { ends_at, paid_trial, talk_link } — talk_link opens WhatsApp with AiDwar's
 * team (wa.me), or null. Reads only; nothing is charged or changed.
 */
export const Route = createFileRoute("/api/app/access-period")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError } =
          await import("@/lib/whatsapp-api.server");
        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }
        const auth = await requireOrgMember(
          request,
          (payload["organization_id"] as string) ?? null,
        );
        if (isResponse(auth)) return auth;
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const service = getServiceClient();
        const { accessPeriodOf } = await import("@/lib/renewals.server");
        const period = await accessPeriodOf(service, auth.organizationId);
        let talkLink: string | null = null;
        if (period.paid_trial) {
          try {
            const { aidwarWaId } = await import("@/lib/lead-verify.server");
            const { waMeLink } = await import("@/lib/lead-verify");
            const waId = await aidwarWaId(service);
            talkLink = waId
              ? waMeLink(waId, "Hi! My AiDwar access is ending soon — please call me.")
              : null;
          } catch {
            talkLink = null;
          }
        }
        return Response.json({ ...period, talk_link: talkLink });
      },
    },
  },
});
