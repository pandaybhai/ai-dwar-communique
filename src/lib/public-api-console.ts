import { API_ENDPOINTS } from "@/lib/public-api-spec";

/**
 * Batch 38 item 7: what the "Try it" console (Settings → API & webhooks) can
 * call, shared by the console, its server route and the docs' "Try it"
 * buttons. Each entry is one /api/v1 endpoint, named by its id in the spec
 * module (public-api-spec.ts): the fields and filters the console passes on
 * are that endpoint's own, read from the spec, so the console can't take what
 * the API doesn't.
 */

export const CONSOLE_ENDPOINTS = {
  send_template: {
    method: "POST",
    path: "/api/v1/messages/template",
    spec: "send-template",
    label: "Send a template",
  },
  send_session: {
    method: "POST",
    path: "/api/v1/messages/session",
    spec: "send-session",
    label: "Send a free-form message",
  },
  message_status: {
    method: "GET",
    path: "/api/v1/messages/{message_id}",
    spec: "message-status",
    label: "A message's status",
  },
  contact_upsert: {
    method: "POST",
    path: "/api/v1/contacts",
    spec: "contact-upsert",
    label: "Create or update a contact",
  },
  contacts_list: {
    method: "GET",
    path: "/api/v1/contacts",
    spec: "contacts-list",
    label: "List contacts",
  },
  templates_list: {
    method: "GET",
    path: "/api/v1/templates",
    spec: "templates-list",
    label: "List templates",
  },
  account_balance: {
    method: "GET",
    path: "/api/v1/account/balance",
    spec: "account-balance",
    label: "Wallet balance and prices",
  },
} as const;
export type ConsoleEndpoint = keyof typeof CONSOLE_ENDPOINTS;
export const CONSOLE_ENDPOINT_IDS = Object.keys(CONSOLE_ENDPOINTS) as ConsoleEndpoint[];

export function isConsoleEndpoint(value: unknown): value is ConsoleEndpoint {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(CONSOLE_ENDPOINTS, value)
  );
}

/** The console endpoint for a docs page's endpoint (its spec id), when the console has it. */
export function consoleEndpointFor(specId: string): ConsoleEndpoint | null {
  return CONSOLE_ENDPOINT_IDS.find((k) => CONSOLE_ENDPOINTS[k].spec === specId) ?? null;
}

/** The console, open on one endpoint (the docs' "Try it" link). */
export function tryItHref(specId: string): string {
  return `/app/settings?tab=api&try=${encodeURIComponent(specId)}#try-it`;
}

/**
 * The names an endpoint takes in its body or its query, from the spec (a
 * field written "image · video" is each of them). Never idempotency_key: a
 * console call is one click, and an idempotency record belongs to a real key.
 */
export function consoleFieldNames(endpoint: ConsoleEndpoint, where: "body" | "query"): string[] {
  const e = API_ENDPOINTS.find((x) => x.id === CONSOLE_ENDPOINTS[endpoint].spec);
  return (e?.fields ?? [])
    .filter((f) => f.in === where)
    .flatMap((f) => f.name.split("·").map((n) => n.trim()))
    .filter((n) => n && n !== "idempotency_key");
}
