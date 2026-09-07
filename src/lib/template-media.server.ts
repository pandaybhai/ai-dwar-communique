import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Uploading a header picture, video or document for a template.
 *
 * Meta needs the same file twice, in two different forms: a one-time upload
 * "handle" to attach to the template it reviews, and a reachable URL on every
 * send afterwards. This is the one place that produces both, so the Templates
 * page and the platform's own notice templates behave identically.
 */
export type TemplateMediaResult =
  | {
      ok: true;
      id: string | null;
      format: "IMAGE" | "VIDEO" | "DOCUMENT";
      handle: string;
      mediaUrl: string;
      fileName: string;
      byteSize: number;
    }
  | { ok: false; error: string; status?: number };

export async function uploadTemplateMedia(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    userId: string | null;
    bytes: Uint8Array;
    mime: string;
    fileName: string;
    format: "IMAGE" | "VIDEO" | "DOCUMENT";
    slot: string;
    whatsappAccountId?: string | null;
  },
): Promise<TemplateMediaResult> {
  const { GRAPH_VERSION, graphErrorMessage } = await import("@/lib/whatsapp-api.server");
  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");

  const { connection, error: connectionError } = await getWhatsAppConnection(
    supabase,
    input.organizationId,
    input.whatsappAccountId ?? null,
  );
  if (!connection) {
    return { ok: false, error: connectionError ?? "No connected number.", status: 400 };
  }

  // ---- 1. our own copy, which is what every send uses ----
  const extension = (input.fileName.split(".").pop() ?? "bin").toLowerCase().slice(0, 8);
  const path = `${input.organizationId}/${crypto.randomUUID()}.${extension}`;
  const { error: uploadError } = await supabase.storage
    .from("template-media")
    .upload(path, input.bytes, { contentType: input.mime, upsert: false });
  if (uploadError) {
    return { ok: false, error: "We couldn't save that file. Try again in a moment.", status: 500 };
  }
  const { data: publicUrl } = supabase.storage.from("template-media").getPublicUrl(path);
  const mediaUrl = publicUrl.publicUrl;

  // ---- 2. Meta's upload handle, for the template review ----
  const appId = process.env["META_APP_ID"];
  if (!appId) {
    await supabase.storage.from("template-media").remove([path]);
    return {
      ok: false,
      error:
        "Media headers aren't configured on this workspace yet. Contact support and we'll switch them on.",
      status: 500,
    };
  }

  const sessionRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${appId}/uploads?` +
      new URLSearchParams({
        file_length: String(input.bytes.byteLength),
        file_type: input.mime,
        file_name: input.fileName.slice(0, 120),
      }),
    { method: "POST", headers: { Authorization: `Bearer ${connection.accessToken}` } },
  );
  const sessionBody = (await sessionRes.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = sessionBody["id"] as string | undefined;
  if (!sessionRes.ok || !sessionId) {
    await supabase.storage.from("template-media").remove([path]);
    return {
      ok: false,
      error: `Meta wouldn't accept the file: ${graphErrorMessage(sessionBody)}`,
      status: 400,
    };
  }

  const uploadRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${sessionId}`, {
    method: "POST",
    headers: {
      // The resumable upload step authenticates with the same bearer token
      // that opened the session. Meta's older "OA <token>" scheme is rejected.
      Authorization: `Bearer ${connection.accessToken}`,
      file_offset: "0",
      "content-type": "application/octet-stream",
    },
    body: input.bytes as unknown as BodyInit,
  });
  const uploadBody = (await uploadRes.json().catch(() => ({}))) as Record<string, unknown>;
  const handle = uploadBody["h"] as string | undefined;
  if (!uploadRes.ok || !handle) {
    // Resumable-upload failures come back as { debug_info: { message } },
    // not the usual { error: { message } } envelope.
    const debug = uploadBody["debug_info"] as Record<string, unknown> | undefined;
    const reason =
      (typeof debug?.["message"] === "string" ? (debug["message"] as string) : null) ??
      graphErrorMessage(uploadBody);
    await supabase.storage.from("template-media").remove([path]);
    return { ok: false, error: `Meta wouldn't accept the file: ${reason}`, status: 400 };
  }

  const { data: asset } = await supabase
    .from("template_media_assets")
    .insert({
      organization_id: input.organizationId,
      slot: input.slot,
      format: input.format,
      storage_path: path,
      media_url: mediaUrl,
      mime_type: input.mime,
      file_name: input.fileName.slice(0, 200),
      byte_size: input.bytes.byteLength,
      meta_handle: handle,
      created_by: input.userId,
    })
    .select("id")
    .maybeSingle();

  return {
    ok: true,
    id: (asset?.id as string | undefined) ?? null,
    format: input.format,
    handle,
    mediaUrl,
    fileName: input.fileName,
    byteSize: input.bytes.byteLength,
  };
}
