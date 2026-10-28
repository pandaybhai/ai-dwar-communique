/**
 * Batch 38 item 5: which plan each Public API endpoint and webhook event is
 * part of — the one table the server enforces (endpointPlanGate in
 * public-api-plans.server.ts answers 403 endpoint_not_in_plan with the plan
 * needed) and /developers/api renders as "Availability by plan". Pure data
 * and pure functions: no server code, safe in the browser.
 *
 * Plans are matched by key (plans.key, lower case). A workspace whose plan
 * isn't one of API_PLANS — a trial, or another plan with public_api switched
 * on by a Super Admin override — passed the public_api flag already and may
 * use every endpoint: the override is the explicit grant. Only a workspace
 * on one of API_PLANS can be told "not in your plan".
 *
 * Today every row lists both plans that include the API, exactly as Batch 34
 * sold it (public_api is part of Scale and Enterprise): this table changes
 * nothing for anyone until a row is narrowed here.
 */

/** The plans that include the Public API, cheapest first. */
export const API_PLANS = ["scale", "enterprise"] as const;
export type ApiPlan = (typeof API_PLANS)[number];

export const PLAN_LABELS: Record<ApiPlan, string> = {
  scale: "Scale",
  enterprise: "Enterprise",
};

const ALL: ApiPlan[] = [...API_PLANS];

export type ApiVersion = "v1.0" | "v1.1" | "v1.2";

export type EndpointAvailability = {
  kind: "endpoint";
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** As the docs write it: {name} is one path segment. */
  path: string;
  group: string;
  summary: string;
  since: ApiVersion;
  plans: ApiPlan[];
};

export type EventAvailability = {
  kind: "event";
  name: string;
  group: string;
  summary: string;
  since: ApiVersion;
  plans: ApiPlan[];
};

export type Availability = EndpointAvailability | EventAvailability;

const endpoint = (
  method: EndpointAvailability["method"],
  path: string,
  group: string,
  summary: string,
  since: ApiVersion,
  plans: ApiPlan[] = ALL,
): EndpointAvailability => ({ kind: "endpoint", method, path, group, summary, since, plans });

const event = (
  name: string,
  group: string,
  summary: string,
  since: ApiVersion,
  plans: ApiPlan[] = ALL,
): EventAvailability => ({ kind: "event", name, group, summary, since, plans });

export const PLAN_AVAILABILITY: Availability[] = [
  // ---- messages
  endpoint("POST", "/api/v1/messages/template", "Messages", "Send an approved template", "v1.0"),
  endpoint("GET", "/api/v1/messages/{message_id}", "Messages", "A sent message's status", "v1.0"),
  endpoint(
    "POST",
    "/api/v1/messages/session",
    "Messages",
    "Send inside the 24-hour window",
    "v1.1",
  ),
  endpoint("GET", "/api/v1/media/{message_id}", "Messages", "A message's file", "v1.1"),
  endpoint(
    "GET",
    "/api/v1/media/{message_id}/download",
    "Messages",
    "Download a message's file",
    "v1.1",
  ),
  // ---- contacts, templates, account
  endpoint("GET", "/api/v1/contacts", "Contacts", "List contacts", "v1.1"),
  endpoint("POST", "/api/v1/contacts", "Contacts", "Add or update a contact", "v1.1"),
  endpoint("POST", "/api/v1/contacts/bulk", "Contacts", "Add or update many contacts", "v1.1"),
  endpoint("GET", "/api/v1/contacts/{phone}", "Contacts", "One contact", "v1.1"),
  endpoint("POST", "/api/v1/contacts/{phone}/tags", "Contacts", "Tag a contact", "v1.1"),
  endpoint("DELETE", "/api/v1/contacts/{phone}/tags/{tag}", "Contacts", "Untag a contact", "v1.1"),
  endpoint("GET", "/api/v1/templates", "Templates", "List templates", "v1.1"),
  endpoint("GET", "/api/v1/templates/{name}", "Templates", "One template", "v1.1"),
  endpoint("GET", "/api/v1/account/balance", "Account", "Wallet balance", "v1.1"),
  // ---- campaigns (v1.2)
  endpoint("POST", "/api/v1/campaigns", "Campaigns", "Create and launch a campaign", "v1.2"),
  endpoint("GET", "/api/v1/campaigns", "Campaigns", "List campaigns", "v1.2"),
  endpoint(
    "POST",
    "/api/v1/campaigns/estimate",
    "Campaigns",
    "Recipients and cost, before launching",
    "v1.2",
  ),
  endpoint(
    "GET",
    "/api/v1/campaigns/{campaign_id}",
    "Campaigns",
    "One campaign with its counts",
    "v1.2",
  ),
  endpoint(
    "POST",
    "/api/v1/campaigns/{campaign_id}/cancel",
    "Campaigns",
    "Cancel before it finishes",
    "v1.2",
  ),
  // ---- inbox (v1.2)
  endpoint("GET", "/api/v1/conversations", "Inbox", "List conversations", "v1.2"),
  endpoint(
    "POST",
    "/api/v1/conversations/{phone}/assign",
    "Inbox",
    "Assign to a team member",
    "v1.2",
  ),
  endpoint("POST", "/api/v1/conversations/{phone}/close", "Inbox", "Close a conversation", "v1.2"),
  endpoint(
    "POST",
    "/api/v1/conversations/{phone}/reopen",
    "Inbox",
    "Reopen a conversation",
    "v1.2",
  ),
  endpoint(
    "POST",
    "/api/v1/conversations/{phone}/tags",
    "Inbox",
    "Add or remove the customer's tags",
    "v1.2",
  ),
  // ---- webhook events
  event("message.sent", "Messages", "WhatsApp accepted a message the API sent", "v1.0"),
  event("message.delivered", "Messages", "It reached the customer's phone", "v1.0"),
  event("message.read", "Messages", "The customer read it", "v1.0"),
  event("message.failed", "Messages", "It couldn't be delivered", "v1.0"),
  event("message.received", "Messages", "A customer wrote to you", "v1.1"),
  event("contact.created", "Contacts", "A new contact", "v1.1"),
  event("contact.opted_out", "Contacts", "A contact opted out", "v1.1"),
  event("contact.opted_in", "Contacts", "A contact opted in", "v1.1"),
  event(
    "template.status_changed",
    "Templates",
    "Meta approved, paused or rejected a template",
    "v1.1",
  ),
  event("template.category_changed", "Templates", "Meta changed a template's category", "v1.1"),
  event("campaign.completed", "Campaigns", "A campaign finished sending", "v1.2"),
];

/** "/api/v1/campaigns/{campaign_id}" -> a regular expression for one request path. */
function pathPattern(path: string): RegExp {
  const escaped = path
    .split(/\{[^}]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${escaped}/?$`);
}

/**
 * The row for one request. A static segment wins over a {name} one
 * (/api/v1/campaigns/estimate is never /api/v1/campaigns/{campaign_id}),
 * as the router decides. Null when the API has no such endpoint.
 */
export function endpointFor(
  method: string,
  pathname: string,
  table: Availability[] = PLAN_AVAILABILITY,
): EndpointAvailability | null {
  const m = method.toUpperCase();
  const matches = table.filter(
    (row): row is EndpointAvailability =>
      row.kind === "endpoint" && row.method === m && pathPattern(row.path).test(pathname),
  );
  matches.sort((a, b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0));
  return matches[0] ?? null;
}

export function eventFor(
  name: string,
  table: Availability[] = PLAN_AVAILABILITY,
): EventAvailability | null {
  return (
    table.find((row): row is EventAvailability => row.kind === "event" && row.name === name) ?? null
  );
}

export function isApiPlan(planKey: string | null | undefined): planKey is ApiPlan {
  return (API_PLANS as readonly string[]).includes(String(planKey ?? "").toLowerCase());
}

/** Whether a workspace on `planKey` may use this row (see the module note on other plans). */
export function planAllows(row: Availability, planKey: string | null | undefined): boolean {
  if (!isApiPlan(planKey)) return true;
  return row.plans.includes(planKey.toLowerCase() as ApiPlan);
}

/** Every API plan has this row: the server need not read the workspace's plan at all. */
export function onEveryPlan(row: Availability): boolean {
  return API_PLANS.every((p) => row.plans.includes(p));
}

/** The cheapest plan that has this row, for the 403's message. */
export function planNeeded(row: Availability): ApiPlan {
  return API_PLANS.find((p) => row.plans.includes(p)) ?? "enterprise";
}
