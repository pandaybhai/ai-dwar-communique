import { aidwar } from "@/integrations/aidwar/client";

/**
 * Browser-side capture. Fire-and-forget: a failed emission must never surface
 * to the person who triggered the action, and never delays it.
 */
async function post(body: Record<string, unknown>): Promise<void> {
  try {
    const { data } = await aidwar.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    // capture must never break the operation it describes
  }
}

export function emitClientEvent(
  eventType: string,
  organizationId: string,
  input: {
    entityType: string;
    entityId?: string | null;
    whatsappAccountId?: string | null;
    properties?: Record<string, unknown>;
  },
): void {
  void post({
    organization_id: organizationId,
    event_type: eventType,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    whatsapp_account_id: input.whatsappAccountId ?? null,
    properties: input.properties ?? {},
  });
}

export function recordClientUsage(
  meterKey: string,
  organizationId: string,
  quantity = 1,
  metadata: Record<string, unknown> = {},
): void {
  void post({
    organization_id: organizationId,
    meter_key: meterKey,
    quantity,
    metadata,
  });
}
