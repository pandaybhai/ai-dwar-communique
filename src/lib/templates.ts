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
  /** Templates live inside one business account — two numbers can mean two libraries. */
  waba_id: string | null;
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

/* ------------------------------------------------------------------ *
 * Send-time payload construction
 *
 * Meta rejects a send with "(#131008) Required parameter is missing"
 * whenever a template declares a variable the payload doesn't fill —
 * body, header or a dynamic URL button alike. We derive what a template
 * needs from its own stored components, so a new template with a link
 * button works without any code change.
 * ------------------------------------------------------------------ */

export type TemplateUrlButton = {
  /** Position of the button inside the BUTTONS block — Meta's "index". */
  index: number;
  /** Variables declared inside the URL, e.g. {{1}} in https://…/r/{{1}}. */
  variables: number[];
  url: string;
};

export type TemplateVariableSpec = {
  header: number[];
  body: number[];
  urlButtons: TemplateUrlButton[];
};

/** Everything a template needs filled in at send time. */
export function templateVariableSpec(
  components: TemplateComponent[] | null | undefined,
): TemplateVariableSpec {
  const list = (components ?? []) as TemplateComponent[];
  const header = list.find((c) => String(c.type).toUpperCase() === "HEADER");
  const headerVars =
    header && String(header.format ?? "TEXT").toUpperCase() === "TEXT"
      ? extractVariables(header.text ?? "")
      : [];

  const buttonsBlock = list.find((c) => String(c.type).toUpperCase() === "BUTTONS");
  const urlButtons: TemplateUrlButton[] = [];
  (buttonsBlock?.buttons ?? []).forEach((button, index) => {
    if (String(button["type"] ?? "").toUpperCase() !== "URL") return;
    const url = String(button["url"] ?? "");
    const variables = extractVariables(url);
    if (variables.length > 0) urlButtons.push({ index, variables, url });
  });

  return {
    header: headerVars,
    body: extractVariables(templateBodyText(list)),
    urlButtons,
  };
}

export type TemplatePayloadInput = {
  spec: TemplateVariableSpec;
  /** Values keyed by variable number, as used in the body text. */
  values: Record<string, string>;
  /** Header values, when the header carries its own variables. */
  headerValues?: Record<string, string>;
  /** Short-link tokens, one per URL button, keyed by button index. */
  buttonTokens?: Record<number, string>;
};

export type TemplatePayloadResult =
  | { components: Array<Record<string, unknown>>; error: null }
  | { components: null; error: string };

/**
 * Builds the Graph `template.components` payload and refuses to send when a
 * declared variable has no value — naming the component and index instead of
 * letting Meta answer with #131008.
 */
export function buildTemplatePayloadComponents(
  input: TemplatePayloadInput,
): TemplatePayloadResult {
  const components: Array<Record<string, unknown>> = [];

  if (input.spec.header.length > 0) {
    const missing = input.spec.header.filter(
      (n) => !(input.headerValues ?? {})[String(n)]?.trim(),
    );
    if (missing.length > 0) {
      return { components: null, error: missingMessage("header", missing) };
    }
    components.push({
      type: "header",
      parameters: input.spec.header.map((n) => ({
        type: "text",
        text: (input.headerValues ?? {})[String(n)] as string,
      })),
    });
  }

  if (input.spec.body.length > 0) {
    const missing = input.spec.body.filter((n) => !input.values[String(n)]?.trim());
    if (missing.length > 0) {
      return { components: null, error: missingMessage("body", missing) };
    }
    components.push({
      type: "body",
      parameters: input.spec.body.map((n) => ({ type: "text", text: input.values[String(n)] })),
    });
  }

  for (const button of input.spec.urlButtons) {
    const token = (input.buttonTokens ?? {})[button.index];
    if (!token || !token.trim()) {
      return {
        components: null,
        error: missingMessage(`button ${button.index} (link)`, button.variables),
      };
    }
    components.push({
      type: "button",
      sub_type: "url",
      index: String(button.index),
      parameters: [{ type: "text", text: token }],
    });
  }

  return { components, error: null };
}

function missingMessage(component: string, missing: number[]): string {
  const list = missing.map((n) => `{{${n}}}`).join(", ");
  return `This message can't be sent: the template's ${component} needs ${list} and we have no value for ${missing.length > 1 ? "them" : "it"}.`;
}
