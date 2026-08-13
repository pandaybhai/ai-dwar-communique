export type TemplateComponent = {
  type: string;
  format?: string;
  text?: string;
  example?: Record<string, unknown>;
  buttons?: Array<Record<string, unknown>>;
};

export type TemplateRow = {
  id: string;
  organization_id: string;
  meta_template_id: string | null;
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: TemplateComponent[] | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
};

export const TEMPLATE_LANGUAGES = [
  { value: "en_US", label: "English (US)" },
  { value: "en", label: "English" },
  { value: "hi", label: "Hindi" },
];

export const TEMPLATE_CATEGORIES = [
  { value: "MARKETING", label: "Marketing" },
  { value: "UTILITY", label: "Utility" },
  { value: "AUTHENTICATION", label: "Authentication" },
];

/** Meta requires lowercase letters, digits and underscores only. */
export function slugifyTemplateName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 512);
}

/** Returns the ordered, de-duplicated {{n}} placeholders found in the text. */
export function extractVariables(text: string): number[] {
  const found = new Set<number>();
  for (const m of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) found.add(Number(m[1]));
  return Array.from(found).sort((a, b) => a - b);
}

export function componentOf(
  components: TemplateComponent[] | null | undefined,
  type: string,
): TemplateComponent | undefined {
  return (components ?? []).find((c) => String(c.type).toUpperCase() === type);
}

export function templateBodyText(components: TemplateComponent[] | null | undefined): string {
  return componentOf(components, "BODY")?.text ?? "";
}

export function templateFooterText(components: TemplateComponent[] | null | undefined): string {
  return componentOf(components, "FOOTER")?.text ?? "";
}

/** Fills {{1}}, {{2}}… with the given values for a live preview. */
export function renderTemplate(text: string, values: Record<number, string>): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n) => values[Number(n)] || `{{${n}}}`);
}

export function statusBadgeClass(status: string): string {
  switch (status.toUpperCase()) {
    case "APPROVED":
      return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "REJECTED":
      return "border-destructive/25 bg-destructive/10 text-destructive";
    case "PAUSED":
      return "border-border bg-muted text-muted-foreground";
    default:
      return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  }
}
