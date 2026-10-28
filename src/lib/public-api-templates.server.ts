import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiCaller, ApiReply } from "@/lib/public-api.server";
import type { TemplateComponent } from "@/lib/templates";

/**
 * Batch 37 item 5: GET /api/v1/templates and GET /api/v1/templates/{name} —
 * the workspace's WhatsApp templates on the number the API sends from (its
 * default number's business account, as POST /api/v1/messages/template
 * uses): name, language, category, status, components, Meta's rejection
 * reason, and `send`: what POST /api/v1/messages/template needs to fill for
 * it — read from the same stored components and by the same check
 * (planTemplateSend), so "sendable" here means the send will take it.
 * Only the key's own workspace; never another's (a 404, as for a name that
 * doesn't exist).
 */

const fail = (status: number, code: string, error: string): ApiReply => ({
  status,
  body: { error, code },
});

type Row = {
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: unknown;
  rejection_reason: string | null;
  meta_template_id: string | null;
  updated_at: string | null;
};

const BUTTON_TAKES: Record<string, string> = {
  url: "url_param",
  copy_code: "code",
  quick_reply: "payload",
};

/** What the send endpoint needs to fill for this template. */
export async function sendSpec(row: Row): Promise<Record<string, unknown>> {
  const templates = await import("@/lib/templates");
  const components = (row.components ?? []) as TemplateComponent[];
  const spec = templates.templateVariableSpec(components);
  const header = spec.headerMedia
    ? {
        type: spec.headerMedia.format.toLowerCase(),
        // An image or video built in AiDwar may be left out: its own file goes.
        required:
          spec.headerMedia.format === "DOCUMENT" ||
          spec.headerMedia.format === "LOCATION" ||
          !spec.headerMedia.url,
      }
    : spec.header.length
      ? { type: "text", params: spec.header.length, required: true }
      : null;
  const buttons = templates.templateButtons(components).map((b, index) => {
    const t = String(b["type"] ?? "").toUpperCase();
    const kind =
      (t === "URL" && templates.extractVariables(String(b["url"] ?? "")).length) || t === "OTP"
        ? "url"
        : t === "COPY_CODE"
          ? "copy_code"
          : t === "QUICK_REPLY"
            ? "quick_reply"
            : null;
    return {
      index,
      type: t.toLowerCase(),
      text: typeof b["text"] === "string" ? b["text"] : null,
      takes: kind ? BUTTON_TAKES[kind] : null,
      required: kind === "url" || kind === "copy_code",
    };
  });
  // The send's own check, with every value filled: what it refuses here, it refuses there.
  const { planTemplateSend } = await import("@/lib/public-api-send.server");
  const planned = planTemplateSend(
    {
      name: row.name,
      language: row.language,
      category: row.category,
      status: row.status,
      components: row.components,
    },
    {
      document: null,
      header:
        header?.type === "text"
          ? { type: "text", params: Array.from({ length: spec.header.length }, () => "x") }
          : header?.type === "location"
            ? { type: "location", latitude: 0, longitude: 0, name: null, address: null }
            : header && header.type !== "text"
              ? {
                  type: header.type as "image" | "video" | "document",
                  media: {
                    kind: header.type as "image",
                    url: "https://x",
                    base64: null,
                    filename: null,
                    caption: null,
                    field: "header",
                  },
                }
              : null,
      bodyParams: Array.from({ length: spec.body.length }, () => "x"),
      buttons: buttons
        .filter((b) => b.takes)
        .map((b) => ({
          index: b.index,
          type: (b.takes === "url_param"
            ? "url"
            : b.takes === "code"
              ? "copy_code"
              : "quick_reply") as "url",
          value: "x",
        })),
      offerExpiresAt: spec.offerExpiration ? new Date().toISOString() : null,
    },
    templates,
  );
  return {
    header,
    body_params: spec.body.length,
    buttons,
    offer_expires_at: spec.offerExpiration,
    sendable: row.status === "APPROVED" && planned.ok,
    ...(planned.ok ? {} : { not_sendable_because: planned.answer.body["error"] }),
  };
}

export async function publicTemplate(row: Row): Promise<Record<string, unknown>> {
  return {
    name: row.name,
    language: row.language,
    category: row.category ? row.category.toUpperCase() : null,
    status: row.status,
    rejection_reason: row.rejection_reason ?? null,
    components: row.components ?? [],
    send: await sendSpec(row),
    updated_at: row.updated_at ?? null,
  };
}

const COLUMNS =
  "name, language, category, status, components, rejection_reason, meta_template_id, updated_at";

async function wabaOf(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ wabaId: string } | ApiReply> {
  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { connection, error } = await getWhatsAppConnection(supabase, organizationId, null);
  if (!connection)
    return fail(400, "no_whatsapp_number", error ?? "Connect a WhatsApp number in AiDwar first.");
  return { wabaId: connection.wabaId };
}

const STATUSES = ["APPROVED", "PENDING", "REJECTED", "PAUSED"];

/** GET /api/v1/templates?status=&category=&language= */
export async function listTemplates(
  supabase: SupabaseClient,
  caller: ApiCaller,
  query: URLSearchParams,
): Promise<ApiReply> {
  const status = query.get("status")?.toUpperCase() ?? null;
  if (status && !STATUSES.includes(status))
    return fail(400, "invalid_filter", `\`status\` must be one of: ${STATUSES.join(", ")}.`);
  const category = query.get("category")?.toUpperCase() ?? null;
  const language = query.get("language");
  const waba = await wabaOf(supabase, caller.organizationId);
  if ("status" in waba) return waba;
  let read = supabase
    .from("message_templates")
    .select(COLUMNS)
    .eq("organization_id", caller.organizationId)
    .eq("waba_id", waba.wabaId);
  if (status) read = read.eq("status", status);
  if (language) read = read.eq("language", language);
  const { data, error } = await read.order("name", { ascending: true }).limit(1000);
  if (error) return fail(503, "unavailable", "We couldn't read your templates. Please try again.");
  const rows = ((data ?? []) as Row[]).filter(
    (r) => !category || String(r.category ?? "").toUpperCase() === category,
  );
  return { status: 200, body: { data: await Promise.all(rows.map(publicTemplate)) } };
}

/** GET /api/v1/templates/{name}?language= — every language of one template. */
export async function getTemplate(
  supabase: SupabaseClient,
  caller: ApiCaller,
  name: string,
  query: URLSearchParams,
): Promise<ApiReply> {
  const notFound = fail(
    404,
    "not_found",
    `There is no template named "${name.slice(0, 120)}" in this workspace.`,
  );
  if (!name || name.length > 512) return notFound;
  const waba = await wabaOf(supabase, caller.organizationId);
  if ("status" in waba) return waba;
  let read = supabase
    .from("message_templates")
    .select(COLUMNS)
    .eq("organization_id", caller.organizationId)
    .eq("waba_id", waba.wabaId)
    .eq("name", name);
  const language = query.get("language");
  if (language) read = read.eq("language", language);
  const { data, error } = await read.order("language", { ascending: true }).limit(50);
  if (error) return fail(503, "unavailable", "We couldn't read your templates. Please try again.");
  const rows = (data ?? []) as Row[];
  if (!rows.length) return notFound;
  return { status: 200, body: { name, data: await Promise.all(rows.map(publicTemplate)) } };
}
