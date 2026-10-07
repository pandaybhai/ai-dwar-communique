import { outsideFetch } from "@/lib/outside-call.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isServiceWindowOpen } from "@/lib/service-window";
import {
  FORM_SCREEN,
  buildFlowJson,
  formReplyText,
  readableAnswers,
  type FormField,
  type FormRow,
} from "@/lib/wa-forms";

type AnyRecord = Record<string, unknown>;

const PURPOSE_CATEGORY: Record<string, string> = {
  appointment: "APPOINTMENT_BOOKING",
  order: "SHOPPING",
  callback: "CONTACT_US",
  feedback: "SURVEY",
};

/** Every readable Meta validation problem, one per line. */
function metaErrors(body: AnyRecord): string {
  const lines: string[] = [];
  const errors = body["validation_errors"];
  if (Array.isArray(errors)) {
    for (const e of errors as AnyRecord[]) {
      const msg = String(e["message"] ?? e["error"] ?? "").trim();
      const where = e["pointers"] ? "" : e["line_start"] ? ` (line ${e["line_start"]})` : "";
      if (msg) lines.push(`${msg}${where}`);
    }
  }
  const err = body["error"] as AnyRecord | undefined;
  if (err) {
    const user = String(err["error_user_msg"] ?? "").trim();
    const msg = String(err["message"] ?? "").trim();
    lines.push(user || msg);
  }
  return lines.filter(Boolean).join("\n") || "Meta refused the form without saying why.";
}

async function graph(
  path: string,
  token: string,
  init: { method?: string; body?: AnyRecord } = {},
): Promise<{ ok: boolean; body: AnyRecord }> {
  const res = await outsideFetch("meta", `https://graph.facebook.com/v25.0/${path}`, {
    method: init.method ?? "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  let body: AnyRecord = {};
  try {
    body = (await res.json()) as AnyRecord;
  } catch {
    body = {};
  }
  const hasValidation =
    Array.isArray(body["validation_errors"]) && (body["validation_errors"] as unknown[]).length > 0;
  return { ok: res.ok && !hasValidation, body };
}

/**
 * Publishes a form on the number's business account with the merchant's own
 * token: create the Flow with its JSON, then publish. Meta's validation errors
 * are stored on the form so the builder can show them.
 */
export async function publishForm(
  supabase: SupabaseClient,
  form: FormRow,
): Promise<{ ok: boolean; error: string | null; metaFlowId: string | null }> {
  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { connection, error } = await getWhatsAppConnection(
    supabase,
    form.organization_id,
    form.whatsapp_account_id,
  );
  if (!connection) return { ok: false, error: error ?? "No connected number.", metaFlowId: null };

  const flowJson = buildFlowJson({
    formId: form.id,
    name: form.name,
    intro: form.intro,
    fields: form.fields,
  });

  const fail = async (message: string, metaFlowId: string | null) => {
    await supabase
      .from("wa_forms")
      .update({
        status: "error",
        last_error: message.slice(0, 2000),
        flow_json: flowJson,
        meta_flow_id: metaFlowId,
        whatsapp_account_id: connection.accountId,
      })
      .eq("id", form.id);
    return { ok: false, error: message, metaFlowId };
  };

  let metaFlowId = form.meta_flow_id;
  if (metaFlowId) {
    // A draft that failed before: replace its JSON on the existing Meta flow.
    const blob = new Blob([JSON.stringify(flowJson)], { type: "application/json" });
    const fd = new FormData();
    fd.append("file", blob, "flow.json");
    fd.append("name", "flow.json");
    fd.append("asset_type", "FLOW_JSON");
    const res = await outsideFetch("meta", `https://graph.facebook.com/v25.0/${metaFlowId}/assets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${connection.accessToken}` },
      body: fd,
    });
    let body: AnyRecord = {};
    try {
      body = (await res.json()) as AnyRecord;
    } catch {
      body = {};
    }
    const bad =
      !res.ok ||
      (Array.isArray(body["validation_errors"]) && (body["validation_errors"] as unknown[]).length > 0);
    if (bad) return fail(metaErrors(body), metaFlowId);
  } else {
    const created = await graph(`${connection.wabaId}/flows`, connection.accessToken, {
      body: {
        name: `${form.name} v${form.version} ${form.id.slice(0, 6)}`.slice(0, 200),
        categories: [PURPOSE_CATEGORY[form.purpose ?? ""] ?? "OTHER"],
        flow_json: JSON.stringify(flowJson),
      },
    });
    metaFlowId = (created.body["id"] as string | undefined) ?? null;
    if (!created.ok || !metaFlowId) return fail(metaErrors(created.body), metaFlowId);
  }

  const published = await graph(`${metaFlowId}/publish`, connection.accessToken);
  if (!published.ok) return fail(metaErrors(published.body), metaFlowId);

  const now = new Date().toISOString();
  await supabase
    .from("wa_forms")
    .update({
      status: "published",
      last_error: null,
      flow_json: flowJson,
      meta_flow_id: metaFlowId,
      published_at: now,
      whatsapp_account_id: connection.accountId,
    })
    .eq("id", form.id);

  // The version this one replaces stops being offered.
  if (form.parent_id) {
    const { data: parent } = await supabase
      .from("wa_forms")
      .select("id, meta_flow_id, status")
      .eq("id", form.parent_id)
      .eq("organization_id", form.organization_id)
      .maybeSingle();
    const p = parent as { id: string; meta_flow_id: string | null; status: string } | null;
    if (p && p.status === "published") {
      if (p.meta_flow_id) await graph(`${p.meta_flow_id}/deprecate`, connection.accessToken);
      await supabase.from("wa_forms").update({ status: "deprecated" }).eq("id", p.id);
    }
  }
  return { ok: true, error: null, metaFlowId };
}

export type SendFormResult = { ok: boolean; messageId: string | null; error: string | null };

/**
 * Sends a published form as an interactive "flow" message inside the 24-hour
 * window (a free service message). Outside the window the form must travel in
 * an approved template with a form button instead.
 */
export async function sendFormMessage(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    conversationId: string;
    formId: string;
    sentBy?: string | null;
    body?: string | null;
    source: "inbox" | "ai" | "flow";
  },
): Promise<SendFormResult> {
  const { data: formRow } = await supabase
    .from("wa_forms")
    .select("*")
    .eq("id", args.formId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  const form = formRow as FormRow | null;
  if (!form) return { ok: false, messageId: null, error: "That form doesn't exist." };
  if (form.status !== "published" || !form.meta_flow_id)
    return { ok: false, messageId: null, error: "Publish this form before sending it." };

  const { data: convRow } = await supabase
    .from("conversations")
    .select("id, whatsapp_account_id, last_customer_message_at, contacts(wa_id, phone)")
    .eq("id", args.conversationId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  const conv = convRow as {
    id: string;
    whatsapp_account_id: string | null;
    last_customer_message_at: string | null;
    contacts: { wa_id: string | null; phone: string } | null;
  } | null;
  if (!conv) return { ok: false, messageId: null, error: "Conversation not found." };
  if (!isServiceWindowOpen(conv)) {
    return {
      ok: false,
      messageId: null,
      error:
        "This customer hasn't messaged in the last 24 hours. Send an approved template with a form button instead.",
    };
  }
  if (form.whatsapp_account_id && conv.whatsapp_account_id && form.whatsapp_account_id !== conv.whatsapp_account_id) {
    return {
      ok: false,
      messageId: null,
      error: "This form was published on a different number than this conversation.",
    };
  }

  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { connection, error } = await getWhatsAppConnection(
    supabase,
    args.organizationId,
    conv.whatsapp_account_id,
  );
  if (!connection) return { ok: false, messageId: null, error: error ?? "No connected number." };

  const to = String(conv.contacts?.wa_id || conv.contacts?.phone || "").replace(/\D/g, "");
  const flowToken = `f:${form.id}:${crypto.randomUUID().slice(0, 8)}`;
  const bodyText = (args.body?.trim() || form.intro?.trim() || `Please fill in: ${form.name}`).slice(0, 1024);

  const res = await outsideFetch("meta", `https://graph.facebook.com/v25.0/${connection.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "flow",
        header: { type: "text", text: form.name.slice(0, 60) },
        body: { text: bodyText },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token: flowToken,
            flow_id: form.meta_flow_id,
            flow_cta: (form.cta || "Open form").slice(0, 20),
            flow_action: String("navigate"),
            flow_action_payload: { screen: FORM_SCREEN },
          },
        },
      },
    }),
  });
  let json: AnyRecord = {};
  try {
    json = (await res.json()) as AnyRecord;
  } catch {
    json = {};
  }
  const metaMessageId =
    ((json["messages"] as AnyRecord[] | undefined)?.[0]?.["id"] as string | undefined) ?? null;
  const nowIso = new Date().toISOString();
  const { data: inserted } = await supabase
    .from("messages")
    .insert({
      organization_id: args.organizationId,
      conversation_id: conv.id,
      meta_message_id: metaMessageId,
      direction: "outbound",
      type: "form",
      body: `${bodyText}\n\n[Form: ${form.name}]`,
      sent_by: args.sentBy ?? null,
      metadata: { kind: "form_sent", form_id: form.id, flow_token: flowToken, source: args.source },
      status: res.ok ? "pending" : "failed",
      status_updated_at: nowIso,
      ...(res.ok ? {} : { error_detail: JSON.stringify(json).slice(0, 300) }),
    })
    .select("id")
    .maybeSingle();
  await supabase.from("conversations").update({ last_message_at: nowIso }).eq("id", conv.id);

  if (res.ok) {
    await supabase.from("activity_log").insert({
      organization_id: args.organizationId,
      user_id: args.sentBy ?? null,
      action: "form_sent",
      details: { form_id: form.id, source: args.source },
    });
  }
  const err = (json["error"] as AnyRecord | undefined)?.["message"];
  return {
    ok: res.ok,
    messageId: (inserted?.id as string | undefined) ?? null,
    error: res.ok ? null : String(err ?? "WhatsApp refused the form message."),
  };
}

/** Parses an nfm_reply into its raw answers and the form it belongs to. */
export function parseFormReply(msg: AnyRecord): {
  raw: Record<string, unknown>;
  formId: string | null;
  flowToken: string | null;
} | null {
  const interactive = msg["interactive"] as AnyRecord | undefined;
  if (String(interactive?.["type"] ?? "") !== "nfm_reply") return null;
  const nfm = interactive?.["nfm_reply"] as AnyRecord | undefined;
  let raw: Record<string, unknown> = {};
  try {
    const text = nfm?.["response_json"];
    raw = typeof text === "string" ? (JSON.parse(text) as Record<string, unknown>) : ((text as AnyRecord) ?? {});
  } catch {
    raw = {};
  }
  const flowToken = typeof raw["flow_token"] === "string" ? (raw["flow_token"] as string) : null;
  const uuid = /^[0-9a-f-]{36}$/i;
  let formId = typeof raw["_form_id"] === "string" && uuid.test(raw["_form_id"] as string)
    ? (raw["_form_id"] as string)
    : null;
  if (!formId && flowToken?.startsWith("f:")) {
    const candidate = flowToken.split(":")[1] ?? "";
    if (uuid.test(candidate)) formId = candidate;
  }
  return { raw, formId, flowToken };
}

/**
 * Saves a form submission, fills in mapped contact details, writes the
 * readable answer onto the inbox message and starts the "after a form" flow.
 * Idempotent on the Meta message id.
 */
export async function handleFormReply(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    whatsappAccountId: string;
    contactId: string;
    conversationId: string;
    messageRowId: string | null;
    metaMessageId: string;
    msg: AnyRecord;
  },
): Promise<{ saved: boolean; text: string }> {
  const parsed = parseFormReply(args.msg);
  if (!parsed) return { saved: false, text: "" };

  let form: FormRow | null = null;
  if (parsed.formId) {
    const { data } = await supabase
      .from("wa_forms")
      .select("*")
      .eq("id", parsed.formId)
      .eq("organization_id", args.organizationId)
      .maybeSingle();
    form = (data as FormRow | null) ?? null;
  }
  const fields: FormField[] = form?.fields ?? [];
  const answers = readableAnswers(fields, parsed.raw);
  const text = formReplyText(form?.name ?? "Form", answers);
  const stored: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.raw)) if (!k.startsWith("_") && k !== "flow_token") stored[k] = v;

  const { data: inserted, error } = await supabase
    .from("wa_form_responses")
    .upsert(
      {
        organization_id: args.organizationId,
        form_id: form?.id ?? null,
        contact_id: args.contactId,
        conversation_id: args.conversationId,
        message_id: args.messageRowId,
        meta_message_id: args.metaMessageId,
        flow_token: parsed.flowToken,
        answers: stored,
      },
      { onConflict: "meta_message_id", ignoreDuplicates: true },
    )
    .select("id");
  if (error || !inserted || inserted.length === 0) return { saved: false, text };
  const responseId = inserted[0]!.id as string;

  if (args.messageRowId) {
    await supabase
      .from("messages")
      .update({
        type: "form_reply",
        body: text,
        metadata: {
          kind: "form_reply",
          form_id: form?.id ?? null,
          form_name: form?.name ?? "Form",
          response_id: responseId,
          answers,
        },
      })
      .eq("id", args.messageRowId);
  }

  // Mapped contact details (name straight onto the contact, the rest as attributes).
  const updates: Record<string, unknown> = {};
  const attrs: Record<string, unknown> = {};
  for (const f of fields) {
    const v = parsed.raw[f.key];
    if (!f.map_to || typeof v !== "string" || !v.trim()) continue;
    if (f.map_to === "name") updates["name"] = v.trim().slice(0, 120);
    else attrs[f.map_to] = v.trim().slice(0, 200);
  }
  if (Object.keys(attrs).length > 0) {
    const { data: c } = await supabase
      .from("contacts")
      .select("attributes")
      .eq("id", args.contactId)
      .maybeSingle();
    updates["attributes"] = { ...(((c as { attributes?: AnyRecord } | null)?.attributes) ?? {}), ...attrs };
  }
  if (Object.keys(updates).length > 0) {
    await supabase.from("contacts").update(updates).eq("id", args.contactId).eq("organization_id", args.organizationId);
  }

  await supabase.from("activity_log").insert({
    organization_id: args.organizationId,
    user_id: null,
    action: "form_submitted",
    details: { form_id: form?.id ?? null, response_id: responseId, fields: answers.length },
  });

  const { emitEvent } = await import("@/lib/events.server");
  await emitEvent(supabase, "form.submitted", {
    organizationId: args.organizationId,
    whatsappAccountId: args.whatsappAccountId,
    entityType: "form_response",
    entityId: responseId,
    properties: { form_id: form?.id ?? null, conversation_id: args.conversationId },
  });

  // Flows listen for this event through the "After a form is filled in" flow.
  try {
    const { scheduleFlow } = await import("@/lib/flows.server");
    await scheduleFlow(supabase, {
      organizationId: args.organizationId,
      flowKey: "form_followup",
      contactId: args.contactId,
      triggerType: "form_response",
      triggerId: responseId,
      event: "form_submitted",
    });
  } catch {
    // a flow problem must never lose the saved answers
  }

  // Flows v2: "form submitted" triggers (any form, or one specific form).
  try {
    const { dispatchFormSubmitted } = await import("@/lib/flow-triggers.server");
    await dispatchFormSubmitted(supabase, {
      organizationId: args.organizationId,
      contactId: args.contactId,
      conversationId: args.conversationId,
      formId: (form?.id as string | undefined) ?? null,
    });
  } catch {
    // same rule: never lose the saved answers
  }

  return { saved: true, text };
}
