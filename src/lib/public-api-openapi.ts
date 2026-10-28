/**
 * Batch 38 item 8: an OpenAPI 3.1 description of the Public API, generated
 * from the one description (public-api-spec.ts) and the plan table
 * (public-api-plans.ts) — the same source as the docs and the Postman
 * collection, so none of them can drift. Served at /developers/openapi.json.
 * Pure: no server code.
 */
import { API_ERRORS, API_ORIGIN } from "@/lib/public-api";
import {
  API_ENDPOINTS,
  WEBHOOK_EVENTS,
  type ApiEndpoint,
  type FieldDoc,
} from "@/lib/public-api-spec";
import { PLAN_LABELS, endpointFor, eventFor } from "@/lib/public-api-plans";

export const OPENAPI_PATH = "/developers/openapi.json";
export const API_VERSION = "1.2.0";

type Schema = Record<string, unknown>;

/** A field's type, as JSON Schema. Unions and composite names get no type, only a description. */
export function schemaFor(type: string): Schema {
  const t = type.trim();
  if (t === "string") return { type: "string" };
  if (t === "integer") return { type: "integer" };
  if (t === "boolean") return { type: "boolean" };
  if (t === "object") return { type: "object" };
  if (t === "string[]") return { type: "array", items: { type: "string" } };
  if (t === "object[]") return { type: "array", items: { type: "object" } };
  if (t === "string | null") return { type: ["string", "null"] };
  return {};
}

/** A body field that is one JSON key (not "a · b" groups of alternatives). */
const isKey = (name: string) => /^[a-z_][a-z0-9_]*$/.test(name);

function operationId(e: ApiEndpoint): string {
  return e.id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function parameters(e: ApiEndpoint): Schema[] {
  const fields = e.fields ?? [];
  const out: Schema[] = [];
  const seen = new Set<string>();
  for (const name of Array.from(e.path.matchAll(/\{(\w+)\}/g)).map((m) => m[1]!)) {
    const doc = fields.find((x) => x.in === "path" && x.name === name);
    out.push({
      name,
      in: "path",
      required: true,
      description: doc?.description ?? name,
      schema: { type: "string" },
      ...(e.params?.[name] ? { example: e.params[name] } : {}),
    });
    seen.add(`path:${name}`);
  }
  const query: FieldDoc[] = [
    ...fields.filter((x) => x.in === "query"),
    ...(e.query ?? [])
      .filter((q) => !fields.some((x) => x.in === "query" && x.name === q.name))
      .map((q) => ({
        name: q.name,
        in: "query" as const,
        type: "string",
        required: false,
        description: q.description,
        ...(q.example !== undefined ? { example: q.example } : {}),
      })),
  ];
  for (const q of query) {
    if (seen.has(`query:${q.name}`)) continue;
    seen.add(`query:${q.name}`);
    out.push({
      name: q.name,
      in: "query",
      required: q.required,
      description: q.description,
      schema: { type: q.type === "integer" ? "integer" : "string" },
      ...(q.example !== undefined ? { example: q.example } : {}),
    });
  }
  return out;
}

function requestBody(e: ApiEndpoint): Schema | null {
  if (!e.body) return null;
  const fields = (e.fields ?? []).filter((x) => x.in === "body" && isKey(x.name));
  const examples: Record<string, Schema> = { default: { summary: e.title, value: e.body } };
  (e.more ?? []).forEach((m, i) => {
    examples[`example_${i + 1}`] = { summary: m.label, value: m.body };
  });
  return {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: Object.fromEntries(
            fields.map((x) => [x.name, { ...schemaFor(x.type), description: x.description }]),
          ),
          required: fields.filter((x) => x.required).map((x) => x.name),
        },
        examples,
      },
    },
  };
}

function responses(e: ApiEndpoint): Schema {
  const out: Record<string, Schema> = {};
  const json = (body: unknown) =>
    typeof body === "string"
      ? { "application/octet-stream": { schema: { type: "string", format: "binary" } } }
      : { "application/json": { example: body } };
  out[String(e.response.status)] = { description: "Success", content: json(e.response.body) };
  for (const r of e.responses ?? [])
    out[String(r.status)] = { description: r.label, content: json(r.body) };
  // Every error the endpoint can answer with, by status, with the table's meaning.
  const byStatus = new Map<string, string[]>();
  for (const code of [...e.errors, "unauthorized", "rate_limited", "endpoint_not_in_plan"]) {
    const row = API_ERRORS.find((x) => x.codes.includes(code));
    if (!row) continue;
    const status = row.status === "5xx" ? "500" : row.status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  for (const [status, codes] of byStatus) {
    if (out[status]) continue;
    const meaning = API_ERRORS.find((x) => x.codes.includes(codes[0]!))?.meaning ?? "";
    out[status] = {
      description: `${meaning} Codes: ${Array.from(new Set(codes)).join(", ")}.`,
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    };
  }
  return out;
}

/** The whole description. */
export function openApiDocument(origin = API_ORIGIN): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of API_ENDPOINTS) {
    const plans = (endpointFor(e.method, e.path.replace(/\{(\w+)\}/g, "x1"))?.plans ?? []).map(
      (p) => PLAN_LABELS[p],
    );
    const body = requestBody(e);
    paths[e.path] = {
      ...(paths[e.path] ?? {}),
      [e.method.toLowerCase()]: {
        operationId: operationId(e),
        summary: e.title,
        description: e.summary,
        tags: [e.group],
        parameters: parameters(e),
        ...(body ? { requestBody: body } : {}),
        responses: responses(e),
        "x-since": e.since ?? "v1.0",
        "x-plans": plans,
      },
    };
  }
  const webhooks: Record<string, unknown> = {};
  for (const ev of WEBHOOK_EVENTS) {
    webhooks[ev.name] = {
      post: {
        summary: ev.name,
        description: `${ev.when} Signed with X-AiDwar-Signature (see Webhooks in the docs).`,
        "x-since": eventFor(ev.name)?.since ?? "v1.0",
        "x-plans": (eventFor(ev.name)?.plans ?? []).map((p) => PLAN_LABELS[p]),
        requestBody: { content: { "application/json": { example: ev.example } } },
        responses: {
          "200": { description: "Any 2xx answer within 10 seconds counts as delivered." },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "AiDwar Public API",
      version: API_VERSION,
      summary:
        "Send WhatsApp messages, run campaigns and manage your inbox from your own software.",
      description: `Authenticate with an API key from Settings → API & webhooks: Authorization: Bearer adw_live_…. Docs: ${origin}/developers`,
    },
    servers: [{ url: origin }],
    security: [{ bearerAuth: [] }],
    tags: Array.from(new Set(API_ENDPOINTS.map((e) => e.group))).map((name) => ({ name })),
    paths,
    webhooks,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "adw_live_…" },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error", "code"],
          properties: {
            error: { type: "string", description: "What went wrong, in a sentence for people." },
            code: { type: "string", description: "A stable code for programs." },
          },
        },
      },
    },
  };
}
