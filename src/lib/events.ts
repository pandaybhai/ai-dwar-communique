/**
 * Event spine and usage meters — shared vocabulary.
 *
 * Every event type and meter key a feature emits must be declared in its
 * manifest (src/lib/feature-registry.ts). The build check reads both this file
 * and the manifests, so an undeclared emission fails the build instead of
 * quietly landing in the database.
 *
 * Pure data: safe to import from client, server and the build check.
 */
import { FEATURES } from "./feature-registry";

/** Dimensions that belong in `properties`, never in their own column. */
export type EventProperties = {
  message_id?: string | null;
  conversation_id?: string | null;
  contact_id?: string | null;
  campaign_id?: string | null;
  template_name?: string | null;
  /** Meta's billing bucket: marketing | utility | authentication | service. */
  billing_category?: string | null;
  waba_id?: string | null;
  whatsapp_account_id?: string | null;
  segment_id?: string | null;
  automation_id?: string | null;
  contact_source?: string | null;
  message_type?: string | null;
  error_code?: string | null;
  skip_reason?: string | null;
  [key: string]: unknown;
};

export type AnalyticsEventInput = {
  organizationId: string;
  eventType: string;
  entityType: string;
  entityId?: string | null;
  /** Null means the platform did it, not a person. */
  actorUserId?: string | null;
  whatsappAccountId?: string | null;
  properties?: EventProperties;
  occurredAt?: string;
};

export type UsageRecordInput = {
  organizationId: string;
  meterKey: string;
  quantity?: number;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
};

/** Every event type any feature declares. */
export function declaredEventTypes(): string[] {
  return Array.from(new Set(FEATURES.flatMap((f) => f.analytics.event_types)));
}

/** Every usage meter key any feature declares. */
export function declaredMeterKeys(): string[] {
  return Array.from(new Set(FEATURES.flatMap((f) => (f.usage_meters ?? []).map((m) => m.key))));
}

/** Meta bills on template category, so meters mirror those categories exactly. */
export const MESSAGE_CATEGORY_METERS: Record<string, string> = {
  marketing: "messages_marketing",
  utility: "messages_utility",
  authentication: "messages_authentication",
  service: "messages_service",
};

export function meterForMessageCategory(category: string | null | undefined): string {
  const key = String(category ?? "").toLowerCase();
  return MESSAGE_CATEGORY_METERS[key] ?? MESSAGE_CATEGORY_METERS["service"]!;
}
