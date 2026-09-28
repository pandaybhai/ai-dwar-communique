/**
 * WhatsApp Forms (static Meta Flows) — field model, starter templates and the
 * Flow JSON generator. Pure data and functions: safe for client and server.
 */

export type FormFieldType =
  | "text"
  | "long_text"
  | "dropdown"
  | "radio"
  | "checkbox"
  | "date"
  | "opt_in";

/** Which contact detail a field fills in when the customer submits. */
export type FormFieldMap = "" | "name" | "email" | "pincode" | "phone";

export type FormField = {
  key: string;
  type: FormFieldType;
  label: string;
  required: boolean;
  options?: string[];
  helper?: string;
  map_to?: FormFieldMap;
};

export type FormRow = {
  id: string;
  organization_id: string;
  whatsapp_account_id: string | null;
  parent_id: string | null;
  version: number;
  name: string;
  purpose: string | null;
  cta: string;
  intro: string | null;
  fields: FormField[];
  meta_flow_id: string | null;
  status: "draft" | "published" | "deprecated" | "error";
  last_error: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

export const FLOW_JSON_VERSION = "7.1";
export const FORM_SCREEN = "FORM";

export const FIELD_TYPES: { value: FormFieldType; label: string; hasOptions: boolean }[] = [
  { value: "text", label: "Short answer", hasOptions: false },
  { value: "long_text", label: "Long answer", hasOptions: false },
  { value: "dropdown", label: "Dropdown", hasOptions: true },
  { value: "radio", label: "Pick one", hasOptions: true },
  { value: "checkbox", label: "Pick several", hasOptions: true },
  { value: "date", label: "Date", hasOptions: false },
  { value: "opt_in", label: "Yes / no agreement", hasOptions: false },
];

export function fieldHasOptions(type: FormFieldType): boolean {
  return FIELD_TYPES.find((t) => t.value === type)?.hasOptions ?? false;
}

/** A Meta-safe field name: lowercase letters, digits and underscores. */
export function fieldKey(label: string, taken: Set<string> = new Set()): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 30) || "field";
  const start = /^[a-z]/.test(base) ? base : `f_${base}`;
  let key = start;
  let n = 2;
  while (taken.has(key)) key = `${start}_${n++}`;
  return key;
}

export type StarterForm = {
  id: string;
  name: string;
  purpose: string;
  cta: string;
  intro: string;
  fields: FormField[];
};

export const STARTER_FORMS: StarterForm[] = [
  {
    id: "appointment",
    name: "Book an appointment",
    purpose: "appointment",
    cta: "Book now",
    intro: "Pick a day and time that suits you — we'll confirm on WhatsApp.",
    fields: [
      { key: "name", type: "text", label: "Your name", required: true, map_to: "name" },
      { key: "date", type: "date", label: "Preferred date", required: true },
      {
        key: "time_slot",
        type: "radio",
        label: "Preferred time",
        required: true,
        options: ["Morning", "Afternoon", "Evening"],
      },
      { key: "notes", type: "long_text", label: "Anything we should know?", required: false },
    ],
  },
  {
    id: "order",
    name: "Order details",
    purpose: "order",
    cta: "Fill order details",
    intro: "A few details so we can pack and ship your order.",
    fields: [
      { key: "name", type: "text", label: "Full name", required: true, map_to: "name" },
      { key: "size", type: "text", label: "Size", required: true },
      {
        key: "quantity",
        type: "dropdown",
        label: "Quantity",
        required: true,
        options: ["1", "2", "3", "4", "5"],
      },
      { key: "address", type: "long_text", label: "Delivery address", required: true },
      {
        key: "pincode",
        type: "text",
        label: "Pincode",
        required: true,
        helper: "6 digits",
        map_to: "pincode",
      },
    ],
  },
  {
    id: "callback",
    name: "Get a callback",
    purpose: "callback",
    cta: "Request a call",
    intro: "Tell us when to call and we'll ring you.",
    fields: [
      { key: "name", type: "text", label: "Your name", required: true, map_to: "name" },
      {
        key: "best_time",
        type: "radio",
        label: "Best time to call",
        required: true,
        options: ["Morning", "Afternoon", "Evening"],
      },
      { key: "topic", type: "long_text", label: "What is it about?", required: false },
    ],
  },
  {
    id: "feedback",
    name: "Feedback",
    purpose: "feedback",
    cta: "Share feedback",
    intro: "How did we do? It takes 10 seconds.",
    fields: [
      {
        key: "rating",
        type: "radio",
        label: "Your rating",
        required: true,
        options: ["5 — Loved it", "4 — Good", "3 — Okay", "2 — Poor", "1 — Bad"],
      },
      { key: "comments", type: "long_text", label: "Anything to add?", required: false },
      {
        key: "may_contact",
        type: "opt_in",
        label: "You may contact me about my feedback",
        required: false,
      },
    ],
  },
];

/** Plain-language problems that would make Meta refuse the form. */
export function validateForm(input: { name: string; fields: FormField[] }): string | null {
  if (!input.name.trim()) return "Give the form a name.";
  if (input.fields.length === 0) return "Add at least one question.";
  if (input.fields.length > 20) return "A form can have at most 20 questions.";
  const keys = new Set<string>();
  for (const f of input.fields) {
    if (!f.label.trim()) return "Every question needs a label.";
    if (f.label.length > 30 && f.type !== "opt_in")
      return `“${f.label.slice(0, 30)}…” is too long — keep labels under 30 characters.`;
    if (f.type === "opt_in" && f.label.length > 120)
      return "Agreement text must be under 120 characters.";
    if (keys.has(f.key)) return `Two questions share the name “${f.key}”.`;
    keys.add(f.key);
    if (fieldHasOptions(f.type)) {
      const opts = (f.options ?? []).map((o) => o.trim()).filter(Boolean);
      if (opts.length < 2) return `“${f.label}” needs at least two choices.`;
      if (opts.length > 20) return `“${f.label}” can have at most 20 choices.`;
    }
  }
  return null;
}

function optionSource(options: string[] | undefined) {
  return (options ?? [])
    .map((o) => o.trim())
    .filter(Boolean)
    .map((title, i) => ({ id: `${i}_${fieldKey(title)}`.slice(0, 40), title: title.slice(0, 30) }));
}

function component(f: FormField): Record<string, unknown> {
  const helper = f.helper?.trim() ? { "helper-text": f.helper.trim().slice(0, 80) } : {};
  switch (f.type) {
    case "text":
      return {
        type: "TextInput",
        name: f.key,
        label: f.label,
        required: f.required,
        "input-type": f.map_to === "email" ? "email" : f.map_to === "phone" ? "phone" : "text",
        ...helper,
      };
    case "long_text":
      return { type: "TextArea", name: f.key, label: f.label, required: f.required, ...helper };
    case "dropdown":
      return {
        type: "Dropdown",
        name: f.key,
        label: f.label,
        required: f.required,
        "data-source": optionSource(f.options),
      };
    case "radio":
      return {
        type: "RadioButtonsGroup",
        name: f.key,
        label: f.label,
        required: f.required,
        "data-source": optionSource(f.options),
      };
    case "checkbox":
      return {
        type: "CheckboxGroup",
        name: f.key,
        label: f.label,
        required: f.required,
        "data-source": optionSource(f.options),
      };
    case "date":
      return { type: "DatePicker", name: f.key, label: f.label, required: f.required, ...helper };
    case "opt_in":
      return { type: "OptIn", name: f.key, label: f.label, required: f.required };
  }
}

/**
 * One-screen static Flow. The completion payload always carries the form id as
 * a literal, so a response can be matched even when the flow_token is Meta's
 * default (forms sent from a template button).
 */
export function buildFlowJson(input: {
  formId: string;
  name: string;
  intro: string | null;
  fields: FormField[];
}): Record<string, unknown> {
  const payload: Record<string, string> = { _form_id: input.formId };
  for (const f of input.fields) payload[f.key] = `\${form.${f.key}}`;
  const children: Record<string, unknown>[] = [];
  if (input.intro?.trim()) children.push({ type: "TextBody", text: input.intro.trim().slice(0, 4000) });
  children.push(...input.fields.map(component));
  children.push({
    type: "Footer",
    label: "Submit",
    "on-click-action": { name: "complete", payload },
  });
  return {
    version: FLOW_JSON_VERSION,
    screens: [
      {
        id: FORM_SCREEN,
        title: input.name.slice(0, 30),
        terminal: true,
        success: true,
        data: {},
        layout: {
          type: "SingleColumnLayout",
          children: [{ type: "Form", name: "form", children }],
        },
      },
    ],
  };
}

/** Option id → option title, so answers read the way the customer saw them. */
export function readableAnswers(
  fields: FormField[],
  raw: Record<string, unknown>,
): { key: string; label: string; value: string }[] {
  const out: { key: string; label: string; value: string }[] = [];
  const titleOf = (f: FormField, id: string) =>
    optionSource(f.options).find((o) => o.id === id)?.title ?? id;
  for (const f of fields) {
    const v = raw[f.key];
    if (v === undefined || v === null || v === "") continue;
    let value: string;
    if (Array.isArray(v)) value = v.map((x) => titleOf(f, String(x))).join(", ");
    else if (typeof v === "boolean") value = v ? "Yes" : "No";
    else if (fieldHasOptions(f.type)) value = titleOf(f, String(v));
    else value = String(v);
    out.push({ key: f.key, label: f.label, value });
  }
  // Anything the form didn't declare (older versions) still shows, never hidden.
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_") || k === "flow_token" || fields.some((f) => f.key === k)) continue;
    if (v === undefined || v === null || v === "") continue;
    out.push({ key: k, label: k.replace(/_/g, " "), value: Array.isArray(v) ? v.join(", ") : String(v) });
  }
  return out;
}

export function formReplyText(formName: string, answers: { label: string; value: string }[]): string {
  return [`Form: ${formName}`, ...answers.map((a) => `${a.label}: ${a.value}`)].join("\n");
}
