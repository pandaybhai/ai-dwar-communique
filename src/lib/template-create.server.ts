import type { SupabaseClient } from "@supabase/supabase-js";
import type { TemplateDraft } from "@/lib/templates";

/**
 * The one path that submits a template to Meta and files it locally.
 *
 * The Templates page, the cash-on-delivery helper and the billing notices all
 * come through here, so a template created by the platform behaves exactly
 * like one a merchant built by hand.
 */
export type CreateTemplateResult =
  | { ok: true; id: string | null; metaTemplateId: string | null; status: string }
  | { ok: false; error: string; providerResponse?: unknown };

export async function createTemplateFromDraft(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    userId: string | null;
    draft: TemplateDraft;
    whatsappAccountId?: string | null;
  },
): Promise<CreateTemplateResult> {
  const {
    slugifyTemplateName,
    validateDraft,
    draftToComponents,
    annotateStoredComponents,
    emptyDraft,
  } = await import("@/lib/templates");
  const { graphFetch, graphErrorMessage, logServerActivity } = await import(
    "@/lib/whatsapp-api.server"
  );
  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");

  const draft: TemplateDraft = { ...emptyDraft(), ...input.draft };
  draft.name = slugifyTemplateName(draft.name);
  draft.category = String(draft.category).toUpperCase() as TemplateDraft["category"];
  if (!["MARKETING", "UTILITY", "AUTHENTICATION"].includes(draft.category)) {
    return { ok: false, error: "Choose a valid category." };
  }

  // The same rules the builder enforces, applied again here — a request that
  // skips the UI can't create something Meta will reject.
  const problems = validateDraft(draft);
  if (problems.length > 0) return { ok: false, error: problems[0] as string };

  const { connection, error: connectionError } = await getWhatsAppConnection(
    supabase,
    input.organizationId,
    input.whatsappAccountId ?? null,
  );
  if (!connection) return { ok: false, error: connectionError ?? "No connected number." };

  const name = draft.name;
  const language = draft.language;
  const category = draft.category;
  const components = draftToComponents(draft);

  const result = await graphFetch(
    `${connection.wabaId}/message_templates`,
    connection.accessToken,
    { method: "POST", body: { name, language, category, components } },
  );
  if (!result.ok) {
    return { ok: false, error: graphErrorMessage(result.body), providerResponse: result.body };
  }

  const metaId = (result.body["id"] as string) ?? null;
  const rawStatus = String(result.body["status"] ?? "PENDING").toUpperCase();
  const status = ["PENDING", "APPROVED", "REJECTED", "PAUSED"].includes(rawStatus)
    ? rawStatus
    : "PENDING";
  const nowIso = new Date().toISOString();

  const { data: saved, error: saveErr } = await supabase
    .from("message_templates")
    .upsert(
      {
        organization_id: input.organizationId,
        waba_id: connection.wabaId,
        meta_template_id: metaId,
        name,
        language,
        category,
        status,
        // Stored with the media URLs attached, so sends keep working after
        // Meta's upload handles expire.
        components: annotateStoredComponents(components, draft),
        rejection_reason: null,
        updated_at: nowIso,
      },
      { onConflict: "organization_id,waba_id,name,language" },
    )
    .select("id")
    .single();

  if (saveErr) {
    return {
      ok: false,
      error: "Submitted to review, but we couldn't save it locally. Try syncing.",
    };
  }

  // Tie the uploaded files to the template they belong to, so a deleted
  // template takes its artwork with it.
  const handles = [draft.headerHandle, ...draft.cards.map((c) => c.mediaHandle)].filter(Boolean);
  if (saved?.id && handles.length > 0) {
    await supabase
      .from("template_media_assets")
      .update({ message_template_id: saved.id })
      .eq("organization_id", input.organizationId)
      .in("meta_handle", handles as string[]);
  }

  const { emitEvent } = await import("@/lib/events.server");
  await emitEvent(supabase, "template.created", {
    organizationId: input.organizationId,
    actorUserId: input.userId,
    whatsappAccountId: connection.accountId,
    entityType: "message_template",
    entityId: saved?.id ?? null,
    properties: {
      template_name: name,
      language,
      category,
      waba_id: connection.wabaId,
      header_format: draft.headerFormat,
      button_count: draft.buttons.length,
      card_count: draft.cards.length,
    },
  });

  if (input.userId) {
    await logServerActivity(supabase, input.organizationId, input.userId, "template_created", {
      template_name: name,
      language,
      category,
      whatsapp_account_id: connection.accountId,
    });
  }


  return { ok: true, id: saved?.id ?? null, metaTemplateId: metaId, status };
}
