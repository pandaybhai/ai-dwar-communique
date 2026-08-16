import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Credential resolution for a multi-number workspace.
 *
 * Embedded Signup hands back a token scoped to a WABA, and a WABA can hold
 * several phone numbers. So the chain is always:
 *   account (a number) -> its WABA -> that WABA's token.
 *
 * Every Meta call in the app goes through getWhatsAppConnection so no code path
 * can silently pick "whichever number it finds first". The account is taken
 * from the conversation (inbox, automations, opt-out replies) or from the
 * campaign; the workspace default is only a last resort.
 */

export type WhatsAppConnection = {
  accountId: string;
  organizationId: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  status: string;
  isDefault: boolean;
  accessToken: string;
};

export type ConnectionResult = { connection: WhatsAppConnection | null; error: string | null };

type AccountRow = {
  id: string;
  organization_id: string;
  waba_id: string | null;
  phone_number_id: string | null;
  display_phone_number: string | null;
  status: string;
  is_default: boolean;
};

const ACCOUNT_COLUMNS =
  "id, organization_id, waba_id, phone_number_id, display_phone_number, status, is_default";

/**
 * Resolves which number to act as. Explicit id wins and is always checked
 * against the organization — a client-supplied account id is never trusted on
 * its own. Falling back to the default keeps single-number workspaces working
 * exactly as before.
 */
export async function resolveAccount(
  supabase: SupabaseClient,
  organizationId: string,
  whatsappAccountId?: string | null,
): Promise<{ account: AccountRow | null; error: string | null }> {
  if (whatsappAccountId) {
    const { data } = await supabase
      .from("whatsapp_accounts")
      .select(ACCOUNT_COLUMNS)
      .eq("id", whatsappAccountId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!data) {
      return { account: null, error: "That number isn't connected to this workspace." };
    }
    return { account: data as AccountRow, error: null };
  }

  const { data: preferred } = await supabase
    .from("whatsapp_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .order("is_default", { ascending: false })
    .order("connected_at", { ascending: false, nullsFirst: false })
    .limit(1);

  const account = ((preferred ?? [])[0] as AccountRow | undefined) ?? null;
  if (!account) {
    return { account: null, error: "Connect a WhatsApp number before sending messages." };
  }
  return { account, error: null };
}

/** Resolves the account, its WABA and that WABA's stored access token. */
export async function getWhatsAppConnection(
  supabase: SupabaseClient,
  organizationId: string,
  whatsappAccountId?: string | null,
): Promise<ConnectionResult> {
  const { account, error } = await resolveAccount(supabase, organizationId, whatsappAccountId);
  if (!account) return { connection: null, error };

  if (!account.waba_id || !account.phone_number_id) {
    return {
      connection: null,
      error: "This number is missing its business account details. Reconnect it to continue.",
    };
  }

  const { data: cred } = await supabase
    .from("whatsapp_credentials")
    .select("access_token")
    .eq("organization_id", organizationId)
    .eq("waba_id", account.waba_id)
    .maybeSingle();

  const accessToken = (cred?.access_token as string | undefined) ?? "";
  if (!accessToken) {
    return {
      connection: null,
      error: "We couldn't find stored credentials for this number. Reconnect it to continue.",
    };
  }

  return {
    connection: {
      accountId: account.id,
      organizationId,
      wabaId: account.waba_id,
      phoneNumberId: account.phone_number_id,
      displayPhoneNumber: account.display_phone_number,
      status: account.status,
      isDefault: account.is_default,
      accessToken,
    },
    error: null,
  };
}

/** Every distinct WABA an organization can currently reach, with its token. */
export async function listWabaConnections(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Array<{ wabaId: string; accessToken: string; accountIds: string[] }>> {
  const { data: accounts } = await supabase
    .from("whatsapp_accounts")
    .select("id, waba_id")
    .eq("organization_id", organizationId)
    .eq("status", "active");

  const byWaba = new Map<string, string[]>();
  for (const row of (accounts ?? []) as Array<{ id: string; waba_id: string | null }>) {
    if (!row.waba_id) continue;
    byWaba.set(row.waba_id, [...(byWaba.get(row.waba_id) ?? []), row.id]);
  }
  if (byWaba.size === 0) return [];

  const { data: creds } = await supabase
    .from("whatsapp_credentials")
    .select("waba_id, access_token")
    .eq("organization_id", organizationId)
    .in("waba_id", Array.from(byWaba.keys()));

  const out: Array<{ wabaId: string; accessToken: string; accountIds: string[] }> = [];
  for (const c of (creds ?? []) as Array<{ waba_id: string; access_token: string | null }>) {
    if (!c.access_token) continue;
    out.push({
      wabaId: c.waba_id,
      accessToken: c.access_token,
      accountIds: byWaba.get(c.waba_id) ?? [],
    });
  }
  return out;
}

/**
 * Makes one number the workspace default. A partial unique index allows exactly
 * one, so the previous default is cleared first.
 */
export async function setDefaultAccount(
  supabase: SupabaseClient,
  organizationId: string,
  accountId: string,
): Promise<void> {
  await supabase
    .from("whatsapp_accounts")
    .update({ is_default: false })
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .neq("id", accountId);
  await supabase
    .from("whatsapp_accounts")
    .update({ is_default: true })
    .eq("id", accountId)
    .eq("organization_id", organizationId);
}

/** Promotes another active number when the current default goes away. */
export async function ensureDefaultAccount(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<void> {
  const { data: existing } = await supabase
    .from("whatsapp_accounts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .eq("status", "active")
    .limit(1);
  if (existing && existing.length > 0) return;

  const { data: candidates } = await supabase
    .from("whatsapp_accounts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .order("connected_at", { ascending: false, nullsFirst: false })
    .limit(1);
  const next = (candidates ?? [])[0] as { id: string } | undefined;
  if (!next) return;
  await setDefaultAccount(supabase, organizationId, next.id);
}
