export type MatchMode = "all" | "any";

export type SegmentField =
  | "tag"
  | "opt_in_status"
  | "name"
  | "phone"
  | "created_at"
  | "attribute";

export type SegmentCondition = {
  field: SegmentField;
  operator: string;
  value?: string;
  value2?: string;
  key?: string;
};

export type SegmentFilters = {
  match: MatchMode;
  conditions: SegmentCondition[];
};

export type SegmentRow = {
  id: string;
  name: string;
  description: string | null;
  filters: SegmentFilters;
  created_by: string | null;
  created_at: string;
};

export const FIELD_LABELS: Record<SegmentField, string> = {
  tag: "Tag",
  opt_in_status: "Opt-in status",
  name: "Name",
  phone: "Phone",
  created_at: "Added date",
  attribute: "Custom attribute",
};

export const FIELD_OPERATORS: Record<SegmentField, { value: string; label: string }[]> = {
  tag: [
    { value: "has", label: "has" },
    { value: "not_has", label: "does not have" },
  ],
  opt_in_status: [{ value: "is", label: "is" }],
  name: [{ value: "contains", label: "contains" }],
  phone: [
    { value: "contains", label: "contains" },
    { value: "starts_with", label: "starts with" },
  ],
  created_at: [
    { value: "before", label: "before" },
    { value: "after", label: "after" },
    { value: "between", label: "between" },
  ],
  attribute: [
    { value: "equals", label: "equals" },
    { value: "contains", label: "contains" },
    { value: "gt", label: "greater than" },
    { value: "lt", label: "less than" },
    { value: "date_before", label: "date before" },
    { value: "date_after", label: "date after" },
    { value: "is_empty", label: "is empty" },
    { value: "is_not_empty", label: "is not empty" },
  ],
};

export const NO_VALUE_OPERATORS = new Set(["is_empty", "is_not_empty"]);

export function emptyFilters(): SegmentFilters {
  return { match: "all", conditions: [] };
}

export function newCondition(field: SegmentField = "tag"): SegmentCondition {
  return { field, operator: FIELD_OPERATORS[field][0]!.value, value: "" };
}

export function normalizeFilters(raw: unknown): SegmentFilters {
  const obj = (raw ?? {}) as Partial<SegmentFilters>;
  const match: MatchMode = obj.match === "any" ? "any" : "all";
  const conditions = Array.isArray(obj.conditions) ? (obj.conditions as SegmentCondition[]) : [];
  return { match, conditions };
}

/** Only conditions that can actually be evaluated. */
export function usableConditions(filters: SegmentFilters): SegmentCondition[] {
  return filters.conditions.filter((c) => {
    if (c.field === "attribute" && !c.key) return false;
    if (NO_VALUE_OPERATORS.has(c.operator)) return true;
    if (c.operator === "between") return Boolean(c.value && c.value2);
    return Boolean(c.value);
  });
}

export function describeCondition(c: SegmentCondition, tagName?: string): string {
  const op =
    FIELD_OPERATORS[c.field].find((o) => o.value === c.operator)?.label ?? c.operator;
  const subject = c.field === "attribute" ? (c.key ?? "attribute") : FIELD_LABELS[c.field];
  if (NO_VALUE_OPERATORS.has(c.operator)) return `${subject} ${op}`;
  if (c.operator === "between") return `${subject} ${op} ${c.value} and ${c.value2}`;
  return `${subject} ${op} ${c.field === "tag" ? (tagName ?? c.value) : c.value}`;
}
