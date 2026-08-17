import { createFileRoute } from "@tanstack/react-router";

/**
 * Capture endpoint for browser-side surfaces (inbox assignment, team changes)
 * where the write happens in the client. The organization comes from the
 * authenticated membership, and only event types and meters declared in the
 * feature registry are accepted — the same vocabulary the build check enforces.
 */
export const Route = createFileRoute("/api/events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError } = await import(
          "@/lib/whatsapp-api.server"
        );
        const { declaredEventTypes, declaredMeterKeys } = await import("@/lib/events");
        const { emitEvent, recordUsage } = await import("@/lib/events.server");

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;

        const eventType = String(payload["event_type"] ?? "");
        const meterKey = String(payload["meter_key"] ?? "");

        if (eventType) {
          if (!declaredEventTypes().includes(eventType)) return jsonError("Unknown event type.");
          await emitEvent(auth.supabase, eventType, {
            organizationId: auth.organizationId,
            actorUserId: auth.userId,
            whatsappAccountId: (payload["whatsapp_account_id"] as string | null) ?? null,
            entityType: String(payload["entity_type"] ?? "unknown"),
            entityId: (payload["entity_id"] as string | null) ?? null,
            properties: (payload["properties"] ?? {}) as Record<string, unknown>,
          });
        }

        if (meterKey) {
          if (!declaredMeterKeys().includes(meterKey)) return jsonError("Unknown usage meter.");
          await recordUsage(auth.supabase, meterKey, {
            organizationId: auth.organizationId,
            quantity: typeof payload["quantity"] === "number" ? (payload["quantity"] as number) : 1,
            metadata: (payload["metadata"] ?? {}) as Record<string, unknown>,
          });
        }

        return Response.json({ ok: true });
      },
    },
  },
});
