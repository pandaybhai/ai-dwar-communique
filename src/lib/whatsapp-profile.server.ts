/**
 * Batch 35: read and change what a customer sees on a number's WhatsApp
 * business profile, through Meta's Cloud API:
 *   GET/POST /{phone-number-id}/whatsapp_business_profile (about, address,
 *     description, email, websites, vertical, profile_picture_handle);
 *   the photo through the Resumable Upload API (metaResumableUpload);
 *   the display name: GET /{phone-number-id}?fields=verified_name,name_status,
 *     new_display_name,new_name_status and POST /{phone-number-id}?new_display_name=…
 *     (Meta reviews it).
 * Every change is logged on the activity log. Meta's errors come back in
 * plain words (profileError).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WhatsAppConnection } from "@/lib/whatsapp-numbers.server";
import {
  PROFILE_PHOTO_MAX_BYTES,
  PROFILE_PHOTO_TYPES,
  profileProblems,
  type BusinessProfile,
  type DisplayNameStatus,
  type ProfilePatch,
} from "@/lib/whatsapp-profile";

export type ProfileAnswer<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

const PROFILE_FIELDS = "about,address,description,email,profile_picture_url,websites,vertical";
const NAME_FIELDS = "verified_name,name_status,new_display_name,new_name_status";

/** Meta's answer in words a merchant can act on. */
export async function profileError(body: Record<string, unknown>): Promise<string> {
  const { graphErrorMessage } = await import("@/lib/whatsapp-api.server");
  const err = (body["error"] ?? null) as Record<string, unknown> | null;
  const code = Number(err?.["code"] ?? 0);
  if (code === 190)
    return "Meta says this number's connection has expired. Reconnect the number in Settings → WhatsApp and try again.";
  if (code === 10 || code === 200 || code === 3) {
    return "Meta says this connection isn't allowed to change the profile. Reconnect the number so AiDwar can manage it, then try again.";
  }
  if (code === 4 || code === 80007 || code === 130429)
    return "Meta is limiting how often this can change. Wait a few minutes and try again.";
  const detail = graphErrorMessage(body);
  return `Meta didn't accept this: ${detail}`;
}

export async function readProfile(
  connection: WhatsAppConnection,
): Promise<ProfileAnswer<{ profile: BusinessProfile; name: DisplayNameStatus }>> {
  const { graphFetch } = await import("@/lib/whatsapp-api.server");
  const [profileRes, nameRes] = await Promise.all([
    graphFetch(`${connection.phoneNumberId}/whatsapp_business_profile`, connection.accessToken, {
      query: { fields: PROFILE_FIELDS },
    }),
    graphFetch(connection.phoneNumberId, connection.accessToken, {
      query: { fields: NAME_FIELDS },
    }),
  ]);
  if (!profileRes.ok) return { ok: false, status: 502, error: await profileError(profileRes.body) };
  const row = ((profileRes.body["data"] as Array<Record<string, unknown>> | undefined)?.[0] ??
    {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const profile: BusinessProfile = {
    about: str(row["about"]),
    address: str(row["address"]),
    description: str(row["description"]),
    email: str(row["email"]),
    websites: Array.isArray(row["websites"]) ? (row["websites"] as unknown[]).map(String) : [],
    vertical: str(row["vertical"]),
    profile_picture_url:
      typeof row["profile_picture_url"] === "string"
        ? (row["profile_picture_url"] as string)
        : null,
  };
  const n = nameRes.ok ? nameRes.body : {};
  const opt = (v: unknown) => (typeof v === "string" && v ? v : null);
  const name: DisplayNameStatus = {
    verified_name: opt(n["verified_name"]),
    name_status: opt(n["name_status"]),
    new_display_name: opt(n["new_display_name"]),
    new_name_status: opt(n["new_name_status"]),
  };
  return { ok: true, data: { profile, name } };
}

/** Only the fields that changed are sent; Meta's limits are checked first. */
export async function updateProfile(
  supabase: SupabaseClient,
  actor: { organizationId: string; userId: string },
  connection: WhatsAppConnection,
  patch: ProfilePatch,
): Promise<ProfileAnswer<{ fields: string[] }>> {
  const clean: ProfilePatch = {};
  if (patch.about !== undefined) clean.about = String(patch.about).trim();
  if (patch.address !== undefined) clean.address = String(patch.address).trim();
  if (patch.description !== undefined) clean.description = String(patch.description).trim();
  if (patch.email !== undefined) clean.email = String(patch.email).trim();
  if (patch.vertical !== undefined) clean.vertical = String(patch.vertical);
  if (patch.websites !== undefined) {
    clean.websites = (Array.isArray(patch.websites) ? patch.websites : [])
      .map((w) => String(w).trim())
      .filter(Boolean);
  }
  const fields = Object.keys(clean);
  if (fields.length === 0) return { ok: false, status: 400, error: "Nothing to change." };
  const problems = profileProblems(clean);
  if (problems.length) return { ok: false, status: 400, error: problems[0]! };

  const { graphFetch, logServerActivity } = await import("@/lib/whatsapp-api.server");
  const res = await graphFetch(
    `${connection.phoneNumberId}/whatsapp_business_profile`,
    connection.accessToken,
    {
      method: "POST",
      body: { messaging_product: "whatsapp", ...clean },
    },
  );
  if (!res.ok) return { ok: false, status: 502, error: await profileError(res.body) };
  await logServerActivity(
    supabase,
    actor.organizationId,
    actor.userId,
    "whatsapp_profile_updated",
    {
      whatsapp_account_id: connection.accountId,
      fields,
    },
  );
  return { ok: true, data: { fields } };
}

/** The photo: uploaded through the Resumable Upload API, then set by its handle. */
export async function updateProfilePhoto(
  supabase: SupabaseClient,
  actor: { organizationId: string; userId: string },
  connection: WhatsAppConnection,
  file: { bytes: Uint8Array; mime: string; fileName: string },
): Promise<ProfileAnswer<{ updated: true }>> {
  if (!PROFILE_PHOTO_TYPES.includes(file.mime))
    return { ok: false, status: 400, error: "Use a JPG or PNG picture." };
  if (file.bytes.byteLength === 0)
    return { ok: false, status: 400, error: "That picture is empty." };
  if (file.bytes.byteLength > PROFILE_PHOTO_MAX_BYTES)
    return { ok: false, status: 400, error: "That picture is over 5 MB. Use a smaller one." };

  const { metaResumableUpload } = await import("@/lib/template-media.server");
  const upload = await metaResumableUpload(connection.accessToken, file);
  if (!upload.ok) {
    return {
      ok: false,
      status: upload.noAppId ? 500 : 502,
      error: upload.noAppId
        ? "Profile photos aren't configured on this workspace yet. Contact support and we'll switch them on."
        : `Meta didn't accept the picture: ${upload.reason}`,
    };
  }
  const { graphFetch, logServerActivity } = await import("@/lib/whatsapp-api.server");
  const res = await graphFetch(
    `${connection.phoneNumberId}/whatsapp_business_profile`,
    connection.accessToken,
    {
      method: "POST",
      body: { messaging_product: "whatsapp", profile_picture_handle: upload.handle },
    },
  );
  if (!res.ok) return { ok: false, status: 502, error: await profileError(res.body) };
  await logServerActivity(
    supabase,
    actor.organizationId,
    actor.userId,
    "whatsapp_profile_photo_updated",
    {
      whatsapp_account_id: connection.accountId,
      byte_size: file.bytes.byteLength,
    },
  );
  return { ok: true, data: { updated: true } };
}

/** Meta's display-name change: a request Meta reviews, never an instant change. */
export async function requestDisplayName(
  supabase: SupabaseClient,
  actor: { organizationId: string; userId: string },
  connection: WhatsAppConnection,
  rawName: string,
): Promise<ProfileAnswer<{ requested: string }>> {
  const name = String(rawName ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (name.length < 3)
    return { ok: false, status: 400, error: "Type the new display name (3 characters or more)." };
  if (name.length > 512) return { ok: false, status: 400, error: "That name is too long." };

  const { graphFetch, logServerActivity } = await import("@/lib/whatsapp-api.server");
  const res = await graphFetch(connection.phoneNumberId, connection.accessToken, {
    method: "POST",
    query: { new_display_name: name },
  });
  if (!res.ok) return { ok: false, status: 502, error: await profileError(res.body) };
  await logServerActivity(
    supabase,
    actor.organizationId,
    actor.userId,
    "whatsapp_display_name_requested",
    {
      whatsapp_account_id: connection.accountId,
      new_display_name: name,
    },
  );
  return { ok: true, data: { requested: name } };
}
