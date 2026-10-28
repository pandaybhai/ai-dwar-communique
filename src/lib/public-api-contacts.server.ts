import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiCaller, ApiReply } from "@/lib/public-api.server";
import { MAX_BULK_CONTACTS, pathValue } from "@/lib/public-api";

/**
 * Batch 37 item 4: the Contacts API — upsert by phone (one, or up to
 * MAX_BULK_CONTACTS with a result per row), list with a cursor, read one,
 * add / remove tags. Always the key's own workspace.
 *
 * The same rules as the import (src/routes/api/contacts/import.ts): phones
 * through normalizePhone / toWaId, attributes merged into what the contact
 * has, tags by name in the workspace's tags / contact_tags. Opt-in: `opted_in:
 * true` records consent with source "api" — and only ever moves a contact
 * from "unknown" to "opted_in", in one conditional update, so a customer's
 * opt-out (even one landing meanwhile) is never flipped; false or left out
 * changes nothing. The consent columns (opt_in_source / opted_in_at) are
 * Batch 36's: written when the database has them, else left out (the same
 * PGRST204 retry as Batch 36's writeWithConsent), with the activity log
 * keeping who/when/how either way.
 *
 * Bulk work is batched (a few round trips for 1,000 rows, never one per row).
 * Never logs a phone, a name or an attribute.
 */

const fail = (status: number, code: string, error: string): ApiReply => ({
  status,
  body: { error, code },
});

const MAX_NAME = 120;
const MAX_ATTRIBUTES = 50;
const MAX_ATTRIBUTE_CHARS = 1024;
const MAX_TAGS = 20;
const MAX_TAG_CHARS = 50;
/** Rows per IN (…) list: keeps every request URL short. */
const CHUNK = 200;
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 100;

export type ContactInput = {
  phone: string;
  waId: string;
  name: string | null;
  /** Merged into the contact's; a null value removes that key. */
  attributes: Record<string, string | number | boolean | null> | null;
  tags: string[];
  optedIn: boolean;
};

export type ContactRow = {
  id: string;
  phone: string;
  wa_id: string | null;
  name: string | null;
  opt_in_status: string | null;
  attributes: Record<string, unknown> | null;
  source: string | null;
  created_at: string;
  updated_at: string | null;
};

/** A contact as the API shows it. */
export function publicContact(row: ContactRow, tags: string[]): Record<string, unknown> {
  return {
    phone: row.phone,
    wa_id: row.wa_id,
    name: row.name,
    opt_in_status: row.opt_in_status ?? "unknown",
    attributes: row.attributes ?? {},
    tags,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
  };
}

/** One contact of a request, checked. A string is why it can't be used. */
export async function parseContactInput(raw: unknown): Promise<ContactInput | string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "A contact must be an object.";
  const c = raw as Record<string, unknown>;
  const { normalizePhone, toWaId } = await import("@/lib/phone");
  const given =
    typeof c["phone"] === "string" || typeof c["phone"] === "number" ? String(c["phone"]) : "";
  const phone = normalizePhone(given);
  const waId = toWaId(phone);
  if (waId.length < 8 || waId.length > 15)
    return "`phone` must be a WhatsApp number with its country code, e.g. +919812345678.";

  let name: string | null = null;
  if (c["name"] !== undefined && c["name"] !== null) {
    if (typeof c["name"] !== "string") return "`name` must be a string.";
    name = c["name"].trim() || null;
    if (name && name.length > MAX_NAME) return `\`name\` is longer than ${MAX_NAME} characters.`;
  }

  let attributes: ContactInput["attributes"] = null;
  if (c["attributes"] !== undefined && c["attributes"] !== null) {
    const a = c["attributes"];
    if (typeof a !== "object" || Array.isArray(a)) return "`attributes` must be an object.";
    const entries = Object.entries(a as Record<string, unknown>);
    if (entries.length > MAX_ATTRIBUTES)
      return `\`attributes\` holds at most ${MAX_ATTRIBUTES} keys.`;
    attributes = {};
    for (const [k, v] of entries) {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,63}$/.test(k))
        return `attributes key "${k.slice(0, 70)}" must be 1–64 letters, digits, spaces or _ . -`;
      if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
        return `attributes.${k} must be a string, number, true/false or null.`;
      if (typeof v === "string" && v.length > MAX_ATTRIBUTE_CHARS)
        return `attributes.${k} is longer than ${MAX_ATTRIBUTE_CHARS} characters.`;
      attributes[k] = v as string | number | boolean | null;
    }
  }

  const tags = parseTagList(c["tags"]);
  if (typeof tags === "string") return tags;

  if (c["opted_in"] !== undefined && c["opted_in"] !== null && typeof c["opted_in"] !== "boolean")
    return "`opted_in` must be true or false.";

  return { phone, waId, name, attributes, tags, optedIn: c["opted_in"] === true };
}

export function parseTagList(raw: unknown): string[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "`tags` must be an array of names.";
  if (raw.length > MAX_TAGS) return `\`tags\` holds at most ${MAX_TAGS} names.`;
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string" || !t.trim() || t.trim().length > MAX_TAG_CHARS)
      return `Each tag must be a name of 1–${MAX_TAG_CHARS} characters.`;
    if (!out.some((x) => x.toLowerCase() === t.trim().toLowerCase())) out.push(t.trim());
  }
  return out;
}

type DbError = { code?: string; message?: string } | null | undefined;
const CONSENT_COLUMNS = ["opt_in_source", "opted_in_at"];

/** The database doesn't have Batch 36's consent columns yet. */
function missingConsentColumn(error: DbError): boolean {
  if (!error) return false;
  const text = `${error.code ?? ""} ${error.message ?? ""}`;
  return (
    CONSENT_COLUMNS.some((c) => text.includes(c)) &&
    (error.code === "PGRST204" || error.code === "42703" || /column/i.test(text))
  );
}

function withoutConsent<T extends Record<string, unknown>>(row: T): T {
  const copy: Record<string, unknown> = { ...row };
  for (const c of CONSENT_COLUMNS) delete copy[c];
  return copy as T;
}

/** A contacts write with the consent columns, and once more without them when the database doesn't know them. */
async function withConsent<R extends { error: DbError }>(
  run: (strip: boolean) => PromiseLike<R>,
): Promise<R> {
  const first = await run(false);
  return missingConsentColumn(first.error) ? run(true) : first;
}

/** Tag names -> ids in the workspace (existing ones matched without regard to case), creating the missing. */
async function tagIds(
  supabase: SupabaseClient,
  organizationId: string,
  names: string[],
  create: boolean,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!names.length) return out;
  const { data } = await supabase
    .from("tags")
    .select("id, name")
    .eq("organization_id", organizationId)
    .limit(5000);
  const existing = (data ?? []) as Array<{ id: string; name: string }>;
  for (const n of names) {
    const hit = existing.find((t) => t.name.toLowerCase() === n.toLowerCase());
    if (hit) out.set(n.toLowerCase(), hit.id);
  }
  // One spelling per name (the first given): tags are matched without regard to case.
  const missing = names.filter(
    (n, i) =>
      !out.has(n.toLowerCase()) &&
      names.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i,
  );
  if (create && missing.length) {
    await supabase.from("tags").upsert(
      missing.map((name) => ({ organization_id: organizationId, name })),
      { onConflict: "organization_id,name", ignoreDuplicates: true },
    );
    const { data: again } = await supabase
      .from("tags")
      .select("id, name")
      .eq("organization_id", organizationId)
      .in("name", missing);
    for (const t of (again ?? []) as Array<{ id: string; name: string }>)
      if (!out.has(t.name.toLowerCase())) out.set(t.name.toLowerCase(), t.id);
  }
  return out;
}

/** Tag names for some contacts. */
async function tagsOf(
  supabase: SupabaseClient,
  organizationId: string,
  contactIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const ids = contactIds.slice(i, i + CHUNK);
    const { data: links } = await supabase
      .from("contact_tags")
      .select("contact_id, tag_id")
      .eq("organization_id", organizationId)
      .in("contact_id", ids);
    const rows = (links ?? []) as Array<{ contact_id: string; tag_id: string }>;
    const tagIdList = Array.from(new Set(rows.map((r) => r.tag_id)));
    if (!tagIdList.length) continue;
    const { data: tags } = await supabase
      .from("tags")
      .select("id, name")
      .eq("organization_id", organizationId)
      .in("id", tagIdList);
    const names = new Map(
      ((tags ?? []) as Array<{ id: string; name: string }>).map((t) => [t.id, t.name]),
    );
    for (const r of rows) {
      const name = names.get(r.tag_id);
      if (!name) continue;
      out.set(r.contact_id, [...(out.get(r.contact_id) ?? []), name].sort());
    }
  }
  return out;
}

const CONTACT_COLUMNS =
  "id, phone, wa_id, name, opt_in_status, attributes, source, created_at, updated_at";

async function readByPhones(
  supabase: SupabaseClient,
  organizationId: string,
  phones: string[],
): Promise<Map<string, ContactRow> | null> {
  const out = new Map<string, ContactRow>();
  for (let i = 0; i < phones.length; i += CHUNK) {
    const { data, error } = await supabase
      .from("contacts")
      .select(CONTACT_COLUMNS)
      .eq("organization_id", organizationId)
      .in("phone", phones.slice(i, i + CHUNK));
    if (error) return null;
    for (const r of (data ?? []) as ContactRow[]) out.set(r.phone, r);
  }
  return out;
}

/**
 * Moves updated_at for contacts whose tags changed (contact_tags isn't on the
 * row), so a list sync that keeps its cursor sees the change. Gives back the rows.
 */
async function touch(
  supabase: SupabaseClient,
  organizationId: string,
  ids: string[],
): Promise<ContactRow[]> {
  const out: ContactRow[] = [];
  const at = new Date().toISOString();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data } = await supabase
      .from("contacts")
      .update({ updated_at: at })
      .eq("organization_id", organizationId)
      .in("id", ids.slice(i, i + CHUNK))
      .select(CONTACT_COLUMNS);
    out.push(...((data ?? []) as ContactRow[]));
  }
  return out;
}

const sameTags = (a: string[] | undefined, b: string[] | undefined) =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

function merged(
  existing: Record<string, unknown> | null,
  given: ContactInput["attributes"],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(given ?? {})) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

export type UpsertResult = {
  index: number;
  phone: string | null;
  status: "created" | "updated" | "unchanged" | "error";
  contact?: Record<string, unknown>;
  /** Asked to opt in, but the customer had opted out: left as it was. */
  opt_out_kept?: boolean;
  error?: { code: string; message: string };
};

/**
 * Upserts contacts by phone for the key's workspace. `rows` are the raw
 * request objects; each answers on its own (a bad row never stops the rest).
 * Throws only when the database can't be read at all.
 */
export async function upsertContacts(
  supabase: SupabaseClient,
  caller: ApiCaller,
  rows: unknown[],
): Promise<UpsertResult[]> {
  const orgId = caller.organizationId;
  const results: UpsertResult[] = [];
  const inputs: Array<{ index: number; input: ContactInput }> = [];
  const seen = new Set<string>();
  for (const [index, raw] of rows.entries()) {
    const parsed = await parseContactInput(raw);
    if (typeof parsed === "string") {
      const phone = (raw as Record<string, unknown> | null)?.["phone"];
      results[index] = {
        index,
        phone: typeof phone === "string" ? phone : null,
        status: "error",
        error: { code: "invalid_contact", message: parsed },
      };
      continue;
    }
    if (seen.has(parsed.phone)) {
      results[index] = {
        index,
        phone: parsed.phone,
        status: "error",
        error: { code: "duplicate_phone", message: "This phone is earlier in the same request." },
      };
      continue;
    }
    seen.add(parsed.phone);
    inputs.push({ index, input: parsed });
  }
  if (!inputs.length) return results;

  const existing = await readByPhones(
    supabase,
    orgId,
    inputs.map((x) => x.input.phone),
  );
  if (!existing) throw new Error("contacts read failed");
  const now = new Date().toISOString();

  // ---- new contacts: one insert (a number created meanwhile is left to the update below) ----
  const fresh = inputs.filter((x) => !existing.has(x.input.phone));
  const created = new Set<string>();
  if (fresh.length) {
    const insertRows = fresh.map(({ input }) => ({
      organization_id: orgId,
      phone: input.phone,
      wa_id: input.waId,
      name: input.name,
      attributes: merged(null, input.attributes),
      opt_in_status: input.optedIn ? "opted_in" : "unknown",
      source: "api",
      source_detail: { api_key_id: caller.keyId },
      opt_in_source: input.optedIn ? "api" : null,
      opted_in_at: input.optedIn ? now : null,
    }));
    const { data, error } = await withConsent((strip) =>
      supabase
        .from("contacts")
        .upsert(strip ? insertRows.map(withoutConsent) : insertRows, {
          onConflict: "organization_id,phone",
          ignoreDuplicates: true,
        })
        .select(CONTACT_COLUMNS),
    );
    if (error) throw new Error(`contacts insert failed: ${error.message}`);
    for (const r of (data ?? []) as ContactRow[]) {
      existing.set(r.phone, r);
      created.add(r.phone);
    }
    const raced = fresh.filter((x) => !created.has(x.input.phone)).map((x) => x.input.phone);
    if (raced.length) {
      const again = await readByPhones(supabase, orgId, raced);
      for (const [phone, r] of again ?? []) existing.set(phone, r);
    }
  }

  // ---- existing contacts: name and attributes, one upsert; never opt_in_status ----
  const changed = new Set<string>();
  const updates: Array<Record<string, unknown>> = [];
  for (const { input } of inputs) {
    const row = existing.get(input.phone);
    if (!row || created.has(input.phone)) continue;
    const name = input.name ?? row.name;
    const attributes = input.attributes
      ? merged(row.attributes, input.attributes)
      : (row.attributes ?? {});
    if (name === row.name && JSON.stringify(attributes) === JSON.stringify(row.attributes ?? {}))
      continue;
    updates.push({
      organization_id: orgId,
      phone: input.phone,
      wa_id: row.wa_id ?? input.waId,
      name,
      attributes,
    });
    changed.add(input.phone);
  }
  if (updates.length) {
    const { data, error } = await supabase
      .from("contacts")
      .upsert(updates, { onConflict: "organization_id,phone" })
      .select(CONTACT_COLUMNS);
    if (error) throw new Error(`contacts update failed: ${error.message}`);
    for (const r of (data ?? []) as ContactRow[]) existing.set(r.phone, r);
  }

  // ---- opt-in: only "unknown" -> "opted_in", in one conditional update; an opt-out stays ----
  const optInIds = inputs
    .filter((x) => x.input.optedIn && !created.has(x.input.phone))
    .map((x) => existing.get(x.input.phone))
    .filter((r): r is ContactRow => Boolean(r) && r!.opt_in_status === "unknown")
    .map((r) => r.id);
  const optedInNow = new Set<string>(
    fresh
      .filter((x) => x.input.optedIn && created.has(x.input.phone))
      .map((x) => existing.get(x.input.phone)!.id),
  );
  for (let i = 0; i < optInIds.length; i += CHUNK) {
    const ids = optInIds.slice(i, i + CHUNK);
    const patch = { opt_in_status: "opted_in", opt_in_source: "api", opted_in_at: now };
    const { data, error } = await withConsent((strip) =>
      supabase
        .from("contacts")
        .update(strip ? withoutConsent(patch) : patch)
        .eq("organization_id", orgId)
        .in("id", ids)
        .eq("opt_in_status", "unknown")
        .select(CONTACT_COLUMNS),
    );
    if (error) throw new Error(`contacts opt-in failed: ${error.message}`);
    for (const r of (data ?? []) as ContactRow[]) {
      existing.set(r.phone, r);
      optedInNow.add(r.id);
      changed.add(r.phone);
    }
  }

  // ---- tags (added, never removed here) ----
  const allTags = Array.from(new Set(inputs.flatMap((x) => x.input.tags)));
  const contactIds = inputs
    .map((x) => existing.get(x.input.phone)?.id)
    .filter((id): id is string => Boolean(id));
  const tagsBefore = allTags.length
    ? await tagsOf(supabase, orgId, contactIds)
    : new Map<string, string[]>();
  if (allTags.length) {
    const ids = await tagIds(supabase, orgId, allTags, true);
    const links: Array<Record<string, unknown>> = [];
    for (const { input } of inputs) {
      const contact = existing.get(input.phone);
      if (!contact) continue;
      for (const t of input.tags) {
        const tagId = ids.get(t.toLowerCase());
        if (tagId) links.push({ organization_id: orgId, contact_id: contact.id, tag_id: tagId });
      }
    }
    for (let i = 0; i < links.length; i += 1000) {
      await supabase.from("contact_tags").upsert(links.slice(i, i + 1000), {
        onConflict: "contact_id,tag_id",
        ignoreDuplicates: true,
      });
    }
  }
  const tags = await tagsOf(supabase, orgId, contactIds);
  // A contact that only gained a tag changed too: its updated_at moves.
  const retagged = new Set(
    allTags.length
      ? inputs
          .map((x) => existing.get(x.input.phone))
          .filter(
            (r): r is ContactRow =>
              Boolean(r) &&
              !created.has(r!.phone) &&
              !sameTags(tagsBefore.get(r!.id), tags.get(r!.id)),
          )
          .map((r) => r.id)
      : [],
  );
  for (const r of await touch(supabase, orgId, [...retagged])) existing.set(r.phone, r);

  for (const { index, input } of inputs) {
    const row = existing.get(input.phone);
    if (!row) {
      results[index] = {
        index,
        phone: input.phone,
        status: "error",
        error: { code: "unavailable", message: "We couldn't save this contact. Please try again." },
      };
      continue;
    }
    results[index] = {
      index,
      phone: input.phone,
      status: created.has(input.phone)
        ? "created"
        : changed.has(input.phone) || retagged.has(row.id)
          ? "updated"
          : "unchanged",
      contact: publicContact(row, tags.get(row.id) ?? []),
      ...(input.optedIn && row.opt_in_status === "opted_out" ? { opt_out_kept: true } : {}),
    };
  }

  // ---- the record of consent, and the merchant's webhook ----
  if (optedInNow.size) {
    const { logServerActivity } = await import("@/lib/whatsapp-api.server");
    await logServerActivity(supabase, orgId, null, "contacts_opted_in", {
      source: "api",
      api_key_id: caller.keyId,
      contact_ids: [...optedInNow].slice(0, 500),
      changed: optedInNow.size,
      at: now,
    });
    const { apiEventsWanted, contactEventPayload, queueApiEvents } =
      await import("@/lib/public-api-webhooks.server");
    if (await apiEventsWanted(supabase, orgId)) {
      const byId = new Map([...existing.values()].map((r) => [r.id, r]));
      await queueApiEvents(
        supabase,
        [...optedInNow].map((id) => {
          const r = byId.get(id)!;
          return {
            organizationId: orgId,
            event: "contact.opted_in" as const,
            dedupeKey: `contact.opted_in:${id}:${Date.parse(now)}`,
            occurredAt: now,
            payload: contactEventPayload({
              event: "contact.opted_in",
              phone: r.phone,
              name: r.name,
              optInStatus: r.opt_in_status,
              source: r.source,
              occurredAt: now,
            }),
          };
        }),
      );
    }
  }
  return results;
}

/** POST /api/v1/contacts: one contact. 201 created, 200 updated / unchanged. */
export async function upsertOneContact(
  supabase: SupabaseClient,
  caller: ApiCaller,
  raw: unknown,
): Promise<ApiReply> {
  const [result] = await upsertContacts(supabase, caller, [raw]);
  if (!result || result.status === "error")
    return fail(400, "invalid_contact", result?.error?.message ?? "The contact can't be saved.");
  return {
    status: result.status === "created" ? 201 : 200,
    body: {
      status: result.status,
      contact: result.contact,
      ...(result.opt_out_kept ? { opt_out_kept: true } : {}),
    },
  };
}

/** POST /api/v1/contacts/bulk: { contacts: [...] } up to MAX_BULK_CONTACTS, a result per row. */
export async function upsertContactsBulk(
  supabase: SupabaseClient,
  caller: ApiCaller,
  raw: unknown,
): Promise<ApiReply> {
  const list = (raw as Record<string, unknown> | null)?.["contacts"];
  if (!Array.isArray(list) || !list.length)
    return fail(400, "invalid_contacts", "`contacts` must be a non-empty array.");
  if (list.length > MAX_BULK_CONTACTS)
    return fail(
      400,
      "too_many_contacts",
      `A bulk call takes at most ${MAX_BULK_CONTACTS} contacts; this one has ${list.length}.`,
    );
  const results = await upsertContacts(supabase, caller, list);
  const count = (s: UpsertResult["status"]) => results.filter((r) => r.status === s).length;
  return {
    status: 200,
    body: {
      created: count("created"),
      updated: count("updated"),
      unchanged: count("unchanged"),
      errors: count("error"),
      results,
    },
  };
}

async function contactByPhone(
  supabase: SupabaseClient,
  organizationId: string,
  rawPhone: string,
): Promise<ContactRow | null | "error"> {
  const { normalizePhone, toWaId } = await import("@/lib/phone");
  const phone = normalizePhone(pathValue(rawPhone));
  if (toWaId(phone).length < 8) return null;
  const { data, error } = await supabase
    .from("contacts")
    .select(CONTACT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("phone", phone)
    .maybeSingle();
  if (error) return "error";
  return (data as ContactRow | null) ?? null;
}

const notFound = () =>
  fail(404, "not_found", "There is no contact with this phone number in this workspace.");

/** GET /api/v1/contacts/{phone}. */
export async function getContact(
  supabase: SupabaseClient,
  caller: ApiCaller,
  rawPhone: string,
): Promise<ApiReply> {
  const row = await contactByPhone(supabase, caller.organizationId, rawPhone);
  if (row === "error")
    return fail(503, "unavailable", "We couldn't read the contact. Please try again.");
  if (!row) return notFound();
  const tags = await tagsOf(supabase, caller.organizationId, [row.id]);
  return { status: 200, body: { contact: publicContact(row, tags.get(row.id) ?? []) } };
}

/** POST (add) / DELETE (remove) /api/v1/contacts/{phone}/tags[/{tag}]. */
export async function changeContactTags(
  supabase: SupabaseClient,
  caller: ApiCaller,
  rawPhone: string,
  action: "add" | "remove",
  rawTags: unknown,
): Promise<ApiReply> {
  const names = parseTagList(rawTags);
  if (typeof names === "string") return fail(400, "invalid_tags", names);
  if (!names.length) return fail(400, "invalid_tags", "`tags` must name at least one tag.");
  const orgId = caller.organizationId;
  const row = await contactByPhone(supabase, orgId, rawPhone);
  if (row === "error")
    return fail(503, "unavailable", "We couldn't read the contact. Please try again.");
  if (!row) return notFound();
  const before = (await tagsOf(supabase, orgId, [row.id])).get(row.id);
  const ids = await tagIds(supabase, orgId, names, action === "add");
  const tagIdList = names
    .map((n) => ids.get(n.toLowerCase()))
    .filter((id): id is string => Boolean(id));
  if (action === "add" && tagIdList.length) {
    const { error } = await supabase.from("contact_tags").upsert(
      tagIdList.map((tag_id) => ({ organization_id: orgId, contact_id: row.id, tag_id })),
      { onConflict: "contact_id,tag_id", ignoreDuplicates: true },
    );
    if (error) return fail(503, "unavailable", "We couldn't add the tags. Please try again.");
  } else if (tagIdList.length) {
    const { error } = await supabase
      .from("contact_tags")
      .delete()
      .eq("organization_id", orgId)
      .eq("contact_id", row.id)
      .in("tag_id", tagIdList);
    if (error) return fail(503, "unavailable", "We couldn't remove the tags. Please try again.");
  }
  const tags = await tagsOf(supabase, orgId, [row.id]);
  // Tags changed: the contact's updated_at moves, so a list sync sees it.
  const current = sameTags(before, tags.get(row.id))
    ? row
    : ((await touch(supabase, orgId, [row.id]))[0] ?? row);
  return { status: 200, body: { contact: publicContact(current, tags.get(row.id) ?? []) } };
}

// ------------------------------------------------------------ the list

type Cursor = { u: string; i: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (
      typeof c.u !== "string" ||
      Number.isNaN(Date.parse(c.u)) ||
      !/^[A-Za-z0-9-]{1,64}$/.test(String(c.i))
    )
      return null;
    return c;
  } catch {
    return null;
  }
}

/**
 * GET /api/v1/contacts?limit=&cursor=&tag=&opt_in=&updated_since= — oldest
 * change first (updated_at, then id), so a sync that keeps the last cursor
 * sees every later change. One query (api_list_contacts, 20261150), tags
 * included.
 */
export async function listContacts(
  supabase: SupabaseClient,
  caller: ApiCaller,
  query: URLSearchParams,
): Promise<ApiReply> {
  const limitRaw = query.get("limit");
  const limit = limitRaw === null ? DEFAULT_PAGE : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE)
    return fail(400, "invalid_limit", `\`limit\` must be 1 to ${MAX_PAGE}.`);
  const optIn = query.get("opt_in");
  if (optIn !== null && !["opted_in", "opted_out", "unknown"].includes(optIn))
    return fail(400, "invalid_filter", "`opt_in` must be opted_in, opted_out or unknown.");
  const since = query.get("updated_since");
  if (since !== null && Number.isNaN(Date.parse(since)))
    return fail(400, "invalid_filter", "`updated_since` must be a time (ISO 8601).");
  const tag = query.get("tag");
  if (tag !== null && (!tag.trim() || tag.length > MAX_TAG_CHARS))
    return fail(
      400,
      "invalid_filter",
      `\`tag\` must be a tag name of 1–${MAX_TAG_CHARS} characters.`,
    );
  const cursorRaw = query.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor)
    return fail(400, "invalid_cursor", "`cursor` isn't one this API gave. Start again without it.");

  const { data, error } = await supabase.rpc("api_list_contacts", {
    p_org: caller.organizationId,
    p_limit: limit + 1,
    p_after_updated: cursor?.u ?? null,
    p_after_id: cursor?.i ?? null,
    p_tag: tag?.trim() || null,
    p_opt_in: optIn,
    p_updated_since: since ? new Date(since).toISOString() : null,
  });
  if (error) {
    // A cursor whose id isn't one of ours (invalid uuid) is the caller's to fix.
    if ((error as { code?: string }).code === "22P02")
      return fail(
        400,
        "invalid_cursor",
        "`cursor` isn't one this API gave. Start again without it.",
      );
    return fail(503, "unavailable", "We couldn't list contacts. Please try again.");
  }
  const rows = (data ?? []) as Array<ContactRow & { tags: string[] | null }>;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    status: 200,
    body: {
      data: page.map((r) => publicContact(r, [...(r.tags ?? [])].sort())),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor({ u: String(last.updated_at ?? last.created_at), i: last.id })
          : null,
    },
  };
}
