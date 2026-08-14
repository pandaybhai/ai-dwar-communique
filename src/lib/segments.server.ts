import type { SupabaseClient } from "@supabase/supabase-js";
import {
  NO_VALUE_OPERATORS,
  normalizeFilters,
  usableConditions,
  type SegmentCondition,
  type SegmentFilters,
} from "@/lib/segments";

export type SegmentPreviewContact = {
  id: string;
  name: string | null;
  phone: string;
  opt_in_status: string;
  created_at: string;
};

export type SegmentEvaluation = {
  count: number;
  preview: SegmentPreviewContact[];
};

const KEY_RE = /^[a-z0-9_]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEVER = "id.eq.00000000-0000-0000-0000-000000000000";

/** Quote a value for a PostgREST filter expression. */
function q(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function like(value: string): string {
  return value.replace(/[*]/g, "");
}

async function contactIdsForTag(
  supabase: SupabaseClient,
  organizationId: string,
  tagId: string,
): Promise<string[]> {
  if (!UUID_RE.test(tagId)) return [];
  const { data } = await supabase
    .from("contact_tags")
    .select("contact_id")
    .eq("organization_id", organizationId)
    .eq("tag_id", tagId)
    .limit(50000);
  return ((data as { contact_id: string }[]) ?? []).map((r) => r.contact_id);
}

function attrPath(key: string): string | null {
  return KEY_RE.test(key) ? `attributes->>${key}` : null;
}

function exprForAttribute(c: SegmentCondition): string | null {
  const path = attrPath(c.key ?? "");
  if (!path) return null;
  const v = c.value ?? "";
  switch (c.operator) {
    case "equals":
      return `${path}.eq.${q(v)}`;
    case "contains":
      return `${path}.ilike.${q(`*${like(v)}*`)}`;
    case "gt":
    case "date_after":
      return `${path}.gt.${q(v)}`;
    case "lt":
    case "date_before":
      return `${path}.lt.${q(v)}`;
    case "is_empty":
      return `or(${path}.is.null,${path}.eq.${q("")})`;
    case "is_not_empty":
      return `and(${path}.not.is.null,${path}.neq.${q("")})`;
    default:
      return null;
  }
}

async function exprForCondition(
  supabase: SupabaseClient,
  organizationId: string,
  c: SegmentCondition,
): Promise<string | null> {
  const v = (c.value ?? "").trim();
  switch (c.field) {
    case "tag": {
      const ids = await contactIdsForTag(supabase, organizationId, v);
      if (c.operator === "has") return ids.length ? `id.in.(${ids.join(",")})` : NEVER;
      return ids.length ? `not.id.in.(${ids.join(",")})` : "id.not.is.null";
    }
    case "opt_in_status":
      return ["opted_in", "opted_out", "unknown"].includes(v) ? `opt_in_status.eq.${v}` : null;
    case "name":
      return `name.ilike.${q(`*${like(v)}*`)}`;
    case "phone":
      return c.operator === "starts_with"
        ? `phone.ilike.${q(`${like(v)}*`)}`
        : `phone.ilike.${q(`*${like(v)}*`)}`;
    case "created_at": {
      if (c.operator === "between") {
        const a = (c.value ?? "").trim();
        const b = (c.value2 ?? "").trim();
        if (!a || !b) return null;
        return `and(created_at.gte.${a},created_at.lte.${b} 23:59:59)`;
      }
      if (!v) return null;
      return c.operator === "before" ? `created_at.lt.${v}` : `created_at.gt.${v} 23:59:59`;
    }
    case "source": {
      if (!/^[a-z0-9_]+$/.test(v)) return null;
      return c.operator === "is_not" ? `source.neq.${v}` : `source.eq.${v}`;
    }
    case "attribute":
      return exprForAttribute(c);
    default:
      return null;
  }
}

/**
 * Builds the PostgREST filter expressions for a segment. Reusable by segment
 * preview and (later) campaign audience resolution.
 */
export async function segmentExpressions(
  supabase: SupabaseClient,
  organizationId: string,
  rawFilters: unknown,
): Promise<{ match: "all" | "any"; expressions: string[] }> {
  const filters: SegmentFilters = normalizeFilters(rawFilters);
  const conditions = usableConditions(filters).slice(0, 25);
  const expressions: string[] = [];
  for (const c of conditions) {
    if (!NO_VALUE_OPERATORS.has(c.operator) && c.field !== "created_at" && !c.value?.trim()) {
      continue;
    }
    const expr = await exprForCondition(supabase, organizationId, c);
    if (expr) expressions.push(expr);
  }
  return { match: filters.match, expressions };
}

type OrFilterable<T> = { or: (filters: string) => T };

/** Applies segment filters to a contacts query builder. */
export function applySegment<T extends OrFilterable<T>>(
  query: T,
  match: "all" | "any",
  expressions: string[],
): T {
  let q2 = query;
  if (!expressions.length) return q2;
  if (match === "any") return q2.or(expressions.join(","));
  for (const expr of expressions) q2 = q2.or(expr);
  return q2;
}

/** Evaluates a segment live: total matching count + first 5 contacts. */
export async function evaluateSegment(
  supabase: SupabaseClient,
  organizationId: string,
  rawFilters: unknown,
): Promise<SegmentEvaluation> {
  const { match, expressions } = await segmentExpressions(supabase, organizationId, rawFilters);

  const countQuery = applySegment(
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId),
    match,
    expressions,
  );
  const previewQuery = applySegment(
    supabase
      .from("contacts")
      .select("id, name, phone, opt_in_status, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(5),
    match,
    expressions,
  );

  const [{ count }, { data }] = await Promise.all([countQuery, previewQuery]);
  return {
    count: count ?? 0,
    preview: (data as SegmentPreviewContact[]) ?? [],
  };
}

/** Resolves all contact ids in a segment (for campaign audiences). */
export async function resolveSegmentContactIds(
  supabase: SupabaseClient,
  organizationId: string,
  rawFilters: unknown,
  limit = 50000,
): Promise<string[]> {
  const { match, expressions } = await segmentExpressions(supabase, organizationId, rawFilters);
  const { data } = await applySegment(
    supabase.from("contacts").select("id").eq("organization_id", organizationId).limit(limit),
    match,
    expressions,
  );
  return ((data as { id: string }[]) ?? []).map((r) => r.id);
}
