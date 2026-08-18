export type TemplateComponent = {
  type: string;
  format?: string;
  text?: string;
  example?: Record<string, unknown>;
  buttons?: Array<Record<string, unknown>>;
  cards?: Array<Record<string, unknown>>;
  /** Limited-time offer block. */
  limited_time_offer?: Record<string, unknown>;
  add_security_recommendation?: boolean;
  code_expiration_minutes?: number;
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

/* ================================================================== *
 * The authoring model
 *
 * One draft shape is edited in the builder, validated on the client for
 * instant feedback, sent to the server, and validated again there with
 * the same functions — so the rules can never drift between the two.
 * ================================================================== */

export type HeaderFormat = "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";

export type ButtonKind =
  | "QUICK_REPLY"
  | "URL"
  | "PHONE_NUMBER"
  | "COPY_CODE"
  | "FLOW"
  | "CATALOG"
  | "MPM"
  | "OTP";

export const MEDIA_HEADER_FORMATS: HeaderFormat[] = ["IMAGE", "VIDEO", "DOCUMENT"];

export function isMediaHeader(format: string | null | undefined): boolean {
  return MEDIA_HEADER_FORMATS.includes(String(format ?? "").toUpperCase() as HeaderFormat);
}

/** What a merchant is choosing between, in their words. */
export const HEADER_OPTIONS: Array<{ value: HeaderFormat; label: string; blurb: string }> = [
  { value: "NONE", label: "No header", blurb: "Just the message text." },
  { value: "TEXT", label: "Text", blurb: "A short bold line above the message." },
  { value: "IMAGE", label: "Image", blurb: "A photo — best for products and offers." },
  { value: "VIDEO", label: "Video", blurb: "A short clip that plays in the chat." },
  { value: "DOCUMENT", label: "Document", blurb: "A PDF, like an invoice or a menu." },
  { value: "LOCATION", label: "Location", blurb: "A map pin — the address is set when you send." },
];

export const BUTTON_OPTIONS: Array<{
  value: ButtonKind;
  label: string;
  blurb: string;
  /** Buttons that only make sense for a shop with a catalogue connected. */
  commerce?: boolean;
}> = [
  { value: "QUICK_REPLY", label: "Quick reply", blurb: "A tappable answer that comes back to your inbox." },
  { value: "URL", label: "Visit website", blurb: "Opens a link — can be personalised per customer." },
  { value: "PHONE_NUMBER", label: "Call us", blurb: "Dials your number." },
  { value: "COPY_CODE", label: "Copy code", blurb: "Copies a coupon code to the clipboard." },
  { value: "FLOW", label: "Open a form", blurb: "Opens a form you built in Meta (a Flow)." },
  { value: "CATALOG", label: "View catalogue", blurb: "Opens your shop inside the chat.", commerce: true },
  { value: "MPM", label: "See products", blurb: "Shows a hand-picked set of products.", commerce: true },
];

export type DraftButton = {
  type: ButtonKind;
  text: string;
  /** URL buttons. */
  url?: string;
  urlExample?: string;
  /** Phone buttons — full international format. */
  phone_number?: string;
  /** Copy-code buttons: an example coupon so Meta can review it. */
  example?: string;
  /** Flow buttons. */
  flow_id?: string;
  flow_action?: "navigate" | "data_exchange";
  navigate_screen?: string;
  /** Authentication templates. */
  otp_type?: "COPY_CODE" | "ONE_TAP";
};

export type DraftCard = {
  /** Every carousel card carries a media header — Meta requires one. */
  format: "IMAGE" | "VIDEO";
  /** Upload handle used at creation time; the URL is what we send with. */
  mediaHandle: string;
  mediaUrl: string;
  body: string;
  bodyExamples: Record<number, string>;
  buttons: DraftButton[];
};

export type TemplateDraft = {
  name: string;
  language: string;
  category: string;
  headerFormat: HeaderFormat;
  headerText: string;
  headerExample: string;
  /** Media headers: both the creation handle and the URL we send with later. */
  headerHandle: string;
  headerMediaUrl: string;
  headerFileName: string;
  body: string;
  bodyExamples: Record<number, string>;
  footer: string;
  buttons: DraftButton[];
  /** Carousel cards. An empty list means this is not a carousel template. */
  cards: DraftCard[];
  /** Limited-time offer, marketing only. */
  offerEnabled: boolean;
  offerText: string;
  offerHasExpiration: boolean;
  /** Authentication templates. */
  codeExpirationMinutes: number;
  addSecurityRecommendation: boolean;
};

export function emptyDraft(): TemplateDraft {
  return {
    name: "",
    language: "en_US",
    category: "MARKETING",
    headerFormat: "NONE",
    headerText: "",
    headerExample: "",
    headerHandle: "",
    headerMediaUrl: "",
    headerFileName: "",
    body: "",
    bodyExamples: {},
    footer: "",
    buttons: [],
    cards: [],
    offerEnabled: false,
    offerText: "",
    offerHasExpiration: true,
    codeExpirationMinutes: 10,
    addSecurityRecommendation: true,
  };
}

export function newButton(type: ButtonKind): DraftButton {
  const base: DraftButton = { type, text: "" };
  switch (type) {
    case "QUICK_REPLY":
      return { ...base, text: "Yes, please" };
    case "URL":
      return { ...base, text: "Shop now", url: "", urlExample: "" };
    case "PHONE_NUMBER":
      return { ...base, text: "Call us", phone_number: "" };
    case "COPY_CODE":
      return { ...base, text: "Copy code", example: "SAVE20" };
    case "FLOW":
      return { ...base, text: "Open form", flow_id: "", flow_action: "navigate", navigate_screen: "" };
    case "CATALOG":
      return { ...base, text: "View catalogue" };
    case "MPM":
      return { ...base, text: "See products" };
    case "OTP":
      return { ...base, text: "Copy code", otp_type: "COPY_CODE" };
    default:
      return base;
  }
}

export function newCard(): DraftCard {
  return {
    format: "IMAGE",
    mediaHandle: "",
    mediaUrl: "",
    body: "",
    bodyExamples: {},
    buttons: [],
  };
}

export const MAX_CAROUSEL_CARDS = 10;
export const MAX_CARD_BUTTONS = 2;
export const MAX_BUTTONS = 10;

/* ------------------------------------------------------------------ *
 * Meta's button combination rules, stated once.
 * ------------------------------------------------------------------ */

export type ButtonRuleResult = { errors: string[] };

export function validateButtons(buttons: DraftButton[], context: "template" | "card"): string[] {
  const errors: string[] = [];
  const limit = context === "card" ? MAX_CARD_BUTTONS : MAX_BUTTONS;
  const where = context === "card" ? "Each card" : "A message";

  if (buttons.length > limit) {
    errors.push(`${where} can have at most ${limit} button${limit > 1 ? "s" : ""}.`);
  }

  const count = (kind: ButtonKind) => buttons.filter((b) => b.type === kind).length;
  const quickReplies = count("QUICK_REPLY");
  const urls = count("URL");
  const phones = count("PHONE_NUMBER");
  const copies = count("COPY_CODE");
  const flows = count("FLOW");
  const catalog = count("CATALOG") + count("MPM");

  if (quickReplies > 10) errors.push("You can have up to 10 quick replies.");
  if (urls > 2) errors.push("You can have at most two website buttons.");
  if (phones > 1) errors.push("You can have only one call button.");
  if (copies > 1) errors.push("You can have only one copy-code button.");
  if (flows > 1) errors.push("You can have only one form button.");
  if (catalog > 1) errors.push("You can have only one catalogue or products button.");
  if (catalog > 0 && buttons.length > 1) {
    errors.push("A catalogue or products button has to be the only button on the message.");
  }

  // Mixed sets must keep the quick replies together, at the top or the bottom.
  if (quickReplies > 0 && quickReplies < buttons.length) {
    const positions = buttons
      .map((b, i) => (b.type === "QUICK_REPLY" ? i : -1))
      .filter((i) => i >= 0);
    const contiguous = positions.every((p, i) => i === 0 || p === (positions[i - 1] as number) + 1);
    const atEdge = positions[0] === 0 || positions[positions.length - 1] === buttons.length - 1;
    if (!contiguous || !atEdge) {
      errors.push(
        "Keep the quick replies together — all above the other buttons, or all below them.",
      );
    }
  }

  buttons.forEach((button, index) => {
    const label = `Button ${index + 1}`;
    if (button.type !== "CATALOG" && !button.text.trim()) {
      errors.push(`${label} needs a label.`);
    }
    if (button.text.length > 25) errors.push(`${label}'s label is too long (25 characters max).`);

    if (button.type === "URL") {
      const url = (button.url ?? "").trim();
      if (!url) errors.push(`${label} needs a web address.`);
      else if (!/^https?:\/\//i.test(url)) errors.push(`${label}'s web address must start with https://.`);
      if (extractVariables(url).length > 0 && !(button.urlExample ?? "").trim()) {
        errors.push(`${label} has a personalised link, so Meta needs an example of the full address.`);
      }
    }
    if (button.type === "PHONE_NUMBER" && !/^\+?[0-9]{6,20}$/.test((button.phone_number ?? "").trim())) {
      errors.push(`${label} needs a phone number with the country code, like +919876543210.`);
    }
    if (button.type === "COPY_CODE" && !(button.example ?? "").trim()) {
      errors.push(`${label} needs an example coupon code for Meta's review.`);
    }
    if (button.type === "FLOW" && !(button.flow_id ?? "").trim()) {
      errors.push(`${label} needs the ID of the form to open.`);
    }
  });

  return errors;
}

/** Everything wrong with a draft, in plain words, ready to show in the UI. */
export function validateDraft(draft: TemplateDraft): string[] {
  const errors: string[] = [];
  const isAuth = draft.category === "AUTHENTICATION";
  const isCarousel = draft.cards.length > 0;

  if (!slugifyTemplateName(draft.name)) errors.push("Give your template a name.");

  if (isAuth) {
    // Meta composes authentication bodies itself; the merchant only sets the
    // expiry and the one-tap behaviour.
    if (draft.codeExpirationMinutes < 1 || draft.codeExpirationMinutes > 90) {
      errors.push("A code can stay valid for between 1 and 90 minutes.");
    }
    if (draft.buttons.filter((b) => b.type === "OTP").length !== 1) {
      errors.push("An authentication template needs exactly one one-time-code button.");
    }
    return errors;
  }

  if (!draft.body.trim()) errors.push("Add the body text of your message.");
  if (draft.body.length > 1024) errors.push("The body is too long (1024 characters max).");

  const bodyVars = extractVariables(draft.body);
  if (bodyVars.some((v, i) => v !== i + 1)) {
    errors.push("Number your variables in order, starting at {{1}}.");
  }
  if (bodyVars.some((v) => !draft.bodyExamples[v]?.trim())) {
    errors.push("Meta requires an example value for every variable in the body.");
  }

  if (draft.headerFormat === "TEXT") {
    if (!draft.headerText.trim()) errors.push("Your text header is empty.");
    if (draft.headerText.length > 60) errors.push("A text header can be 60 characters at most.");
    const headerVars = extractVariables(draft.headerText);
    if (headerVars.length > 1) errors.push("A header can hold only one variable.");
    if (headerVars.length === 1 && !draft.headerExample.trim()) {
      errors.push("Give an example value for the header variable.");
    }
  }
  if (isMediaHeader(draft.headerFormat) && !draft.headerHandle) {
    errors.push("Upload the header file — Meta reviews the template with it attached.");
  }
  if (draft.footer.length > 60) errors.push("A footer can be 60 characters at most.");

  if (isCarousel) {
    if (draft.headerFormat !== "NONE") {
      errors.push("A carousel can't have its own header — each card carries its own picture.");
    }
    if (draft.footer.trim()) errors.push("A carousel can't have a footer.");
    if (draft.buttons.length > 0) {
      errors.push("Carousel buttons live on the cards, not on the message.");
    }
    if (draft.cards.length > MAX_CAROUSEL_CARDS) {
      errors.push(`A carousel can hold up to ${MAX_CAROUSEL_CARDS} cards.`);
    }

    // Meta requires every card to be built the same way: same media type, same
    // button types in the same order. Only the words and pictures differ.
    const first = draft.cards[0];
    draft.cards.forEach((card, i) => {
      const label = `Card ${i + 1}`;
      if (!card.mediaHandle) errors.push(`${label} needs its picture or video uploaded.`);
      if (!card.body.trim()) errors.push(`${label} needs some text.`);
      if (card.body.length > 160) errors.push(`${label}'s text is too long (160 characters max).`);

      const vars = extractVariables(card.body);
      if (vars.some((v, n) => v !== n + 1)) {
        errors.push(`${label}: number its variables in order, starting at {{1}}.`);
      }
      if (startsOrEndsWithVariable(card.body)) {
        errors.push(`${label}: Meta won't accept text that starts or ends with a variable — add a word before or after it.`);
      }
      if (vars.some((v) => !card.bodyExamples[v]?.trim())) {
        errors.push(`${label} needs an example value for every variable.`);
      }
      for (const e of validateButtons(card.buttons, "card")) errors.push(`${label}: ${e}`);

      if (first && i > 0) {
        if (card.format !== first.format) {
          errors.push(`${label} must use the same media type as card 1 (${first.format.toLowerCase()}).`);
        }
        const shape = (c: DraftCard) => c.buttons.map((b) => b.type).join(",");
        if (shape(card) !== shape(first)) {
          errors.push(`${label} must have the same buttons, in the same order, as card 1.`);
        }
      }
    });
  } else {
    for (const e of validateButtons(draft.buttons, "template")) errors.push(e);
  }

  if (draft.offerEnabled) {
    if (draft.category !== "MARKETING") {
      errors.push("A limited-time offer can only go on a marketing template.");
    }
    if (!draft.offerText.trim()) errors.push("Name the offer, e.g. “20% off this weekend”.");
    if (draft.offerText.length > 16) errors.push("The offer name can be 16 characters at most.");
    const hasCopyCode = draft.buttons.some((b) => b.type === "COPY_CODE");
    const hasUrl = draft.buttons.some((b) => b.type === "URL");
    if (!hasCopyCode && !hasUrl) {
      errors.push("A limited-time offer needs a copy-code button or a website button.");
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ *
 * Draft → Meta components
 * ------------------------------------------------------------------ */

function buttonToMeta(button: DraftButton): Record<string, unknown> {
  switch (button.type) {
    case "URL": {
      const url = (button.url ?? "").trim();
      const vars = extractVariables(url);
      return {
        type: "URL",
        text: button.text.trim(),
        url,
        ...(vars.length ? { example: [(button.urlExample ?? "").trim()] } : {}),
      };
    }
    case "PHONE_NUMBER":
      return {
        type: "PHONE_NUMBER",
        text: button.text.trim(),
        phone_number: (button.phone_number ?? "").trim(),
      };
    case "COPY_CODE":
      return { type: "COPY_CODE", example: (button.example ?? "").trim() };
    case "FLOW":
      return {
        type: "FLOW",
        text: button.text.trim(),
        flow_id: (button.flow_id ?? "").trim(),
        flow_action: button.flow_action ?? "navigate",
        ...(button.navigate_screen ? { navigate_screen: button.navigate_screen } : {}),
      };
    case "CATALOG":
      return { type: "CATALOG", text: button.text.trim() || "View catalog" };
    case "MPM":
      return { type: "MPM", text: button.text.trim() || "View products" };
    case "OTP":
      return {
        type: "OTP",
        otp_type: button.otp_type ?? "COPY_CODE",
        text: button.text.trim() || "Copy code",
      };
    case "QUICK_REPLY":
    default:
      return { type: "QUICK_REPLY", text: button.text.trim() };
  }
}

/**
 * The exact `components` array Meta is asked to approve. Also what we store, so
 * the send path and the preview read the same description of the template.
 */
export function draftToComponents(draft: TemplateDraft): TemplateComponent[] {
  const components: TemplateComponent[] = [];

  if (draft.category === "AUTHENTICATION") {
    const otp = draft.buttons.find((b) => b.type === "OTP") ?? newButton("OTP");
    components.push({
      type: "BODY",
      add_security_recommendation: draft.addSecurityRecommendation,
    });
    components.push({ type: "FOOTER", code_expiration_minutes: draft.codeExpirationMinutes });
    components.push({ type: "BUTTONS", buttons: [buttonToMeta(otp)] });
    return components;
  }

  if (draft.headerFormat === "TEXT") {
    const vars = extractVariables(draft.headerText);
    components.push({
      type: "HEADER",
      format: "TEXT",
      text: draft.headerText.trim(),
      ...(vars.length ? { example: { header_text: [draft.headerExample.trim()] } } : {}),
    });
  } else if (isMediaHeader(draft.headerFormat)) {
    components.push({
      type: "HEADER",
      format: draft.headerFormat,
      example: { header_handle: [draft.headerHandle] },
    });
  } else if (draft.headerFormat === "LOCATION") {
    components.push({ type: "HEADER", format: "LOCATION" });
  }

  const bodyVars = extractVariables(draft.body);
  components.push({
    type: "BODY",
    text: draft.body.trim(),
    ...(bodyVars.length
      ? { example: { body_text: [bodyVars.map((v) => (draft.bodyExamples[v] ?? "").trim())] } }
      : {}),
  });

  if (draft.footer.trim()) components.push({ type: "FOOTER", text: draft.footer.trim() });

  if (draft.offerEnabled) {
    components.push({
      type: "LIMITED_TIME_OFFER",
      limited_time_offer: {
        text: draft.offerText.trim(),
        has_expiration: draft.offerHasExpiration,
      },
    });
  }

  if (draft.buttons.length > 0) {
    components.push({ type: "BUTTONS", buttons: draft.buttons.map(buttonToMeta) });
  }

  if (draft.cards.length > 0) {
    components.push({
      type: "CAROUSEL",
      cards: draft.cards.map((card) => {
        const vars = extractVariables(card.body);
        return {
          components: [
            {
              type: "HEADER",
              format: card.format,
              example: { header_handle: [card.mediaHandle] },
            },
            {
              type: "BODY",
              text: card.body.trim(),
              ...(vars.length
                ? { example: { body_text: [vars.map((v) => (card.bodyExamples[v] ?? "").trim())] } }
                : {}),
            },
            ...(card.buttons.length
              ? [{ type: "BUTTONS", buttons: card.buttons.map(buttonToMeta) }]
              : []),
          ],
        };
      }),
    });
  }

  return components;
}

/**
 * What we store locally: Meta's own components, plus the URL of each uploaded
 * file. Meta is never sent this extra field — it only ever receives the upload
 * handle — but the send path needs a link it can still fetch months later,
 * long after the handle has expired.
 */
export function annotateStoredComponents(
  components: TemplateComponent[],
  draft: TemplateDraft,
): TemplateComponent[] {
  return components.map((component) => {
    const type = String(component.type).toUpperCase();
    if (type === "HEADER" && isMediaHeader(component.format) && draft.headerMediaUrl) {
      return {
        ...component,
        example: { ...(component.example ?? {}), aidwar_media_url: draft.headerMediaUrl },
      };
    }
    if (type === "CAROUSEL") {
      return {
        ...component,
        cards: (component.cards ?? []).map((card, index) => {
          const url = draft.cards[index]?.mediaUrl;
          if (!url) return card;
          const parts = ((card["components"] as TemplateComponent[] | undefined) ?? []).map((part) =>
            String(part.type).toUpperCase() === "HEADER"
              ? { ...part, example: { ...(part.example ?? {}), aidwar_media_url: url } }
              : part,
          );
          return { ...card, components: parts };
        }),
      };
    }
    return component;
  });
}

/* ------------------------------------------------------------------ *
 * Stored components → readable shape (preview, template list, picker)
 * ------------------------------------------------------------------ */

export type ReadableHeader = {
  format: HeaderFormat;
  text: string;
  /** Present for media headers created here; sync-only templates may lack it. */
  mediaUrl: string | null;
};

export type ReadableCard = {
  format: "IMAGE" | "VIDEO";
  mediaUrl: string | null;
  body: string;
  buttons: Array<Record<string, unknown>>;
};

export function templateHeader(
  components: TemplateComponent[] | null | undefined,
): ReadableHeader | null {
  const header = componentOf(components, "HEADER");
  if (!header) return null;
  const format = String(header.format ?? "TEXT").toUpperCase() as HeaderFormat;
  return {
    format,
    text: header.text ?? "",
    mediaUrl: (header.example?.["aidwar_media_url"] as string | undefined) ?? null,
  };
}

export function templateButtons(
  components: TemplateComponent[] | null | undefined,
): Array<Record<string, unknown>> {
  return componentOf(components, "BUTTONS")?.buttons ?? [];
}

export function templateCards(
  components: TemplateComponent[] | null | undefined,
): ReadableCard[] {
  const carousel = componentOf(components, "CAROUSEL");
  if (!carousel) return [];
  return (carousel.cards ?? []).map((card) => {
    const parts = (card["components"] as TemplateComponent[] | undefined) ?? [];
    const header = parts.find((p) => String(p.type).toUpperCase() === "HEADER");
    const body = parts.find((p) => String(p.type).toUpperCase() === "BODY");
    const buttons = parts.find((p) => String(p.type).toUpperCase() === "BUTTONS");
    return {
      format: (String(header?.format ?? "IMAGE").toUpperCase() === "VIDEO" ? "VIDEO" : "IMAGE") as
        | "IMAGE"
        | "VIDEO",
      mediaUrl: (header?.example?.["aidwar_media_url"] as string | undefined) ?? null,
      body: body?.text ?? "",
      buttons: buttons?.buttons ?? [],
    };
  });
}

export function templateOffer(
  components: TemplateComponent[] | null | undefined,
): { text: string; hasExpiration: boolean } | null {
  const offer = componentOf(components, "LIMITED_TIME_OFFER");
  if (!offer) return null;
  const block = (offer.limited_time_offer ?? {}) as Record<string, unknown>;
  return {
    text: String(block["text"] ?? "Limited-time offer"),
    hasExpiration: block["has_expiration"] !== false,
  };
}

/** Authentication bodies are composed by Meta; this is what a customer sees. */
export function authenticationPreviewText(
  components: TemplateComponent[] | null | undefined,
): { body: string; footer: string } | null {
  const body = componentOf(components, "BODY");
  if (!body || body.add_security_recommendation === undefined) return null;
  const minutes = componentOf(components, "FOOTER")?.code_expiration_minutes ?? 10;
  return {
    body:
      "{{1}} is your verification code." +
      (body.add_security_recommendation ? " For your security, do not share this code." : ""),
    footer: `This code expires in ${minutes} minutes.`,
  };
}

/* ------------------------------------------------------------------ *
 * Send-time payload construction
 *
 * Meta rejects a send with "(#131008) Required parameter is missing"
 * whenever a template declares a variable the payload doesn't fill —
 * body, header, media, coupon code or a dynamic URL button alike. We
 * derive what a template needs from its own stored components, so a new
 * template works without any code change.
 * ------------------------------------------------------------------ */

export type TemplateUrlButton = {
  /** Position of the button inside the BUTTONS block — Meta's "index". */
  index: number;
  /** Variables declared inside the URL, e.g. {{1}} in https://…/r/{{1}}. */
  variables: number[];
  url: string;
};

export type TemplateCardSpec = {
  /** Position of the card in the carousel — Meta's card_index. */
  index: number;
  format: "IMAGE" | "VIDEO";
  /** Whether we know a URL to send the card's media with. */
  mediaUrl: string | null;
  body: number[];
  urlButtons: TemplateUrlButton[];
  copyCodeButtons: number[];
};

export type TemplateVariableSpec = {
  header: number[];
  /** Set when the header is a picture, video, document or map pin. */
  headerMedia: { format: "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION"; url: string | null } | null;
  body: number[];
  urlButtons: TemplateUrlButton[];
  /** Button indexes that need a coupon code supplied at send time. */
  copyCodeButtons: number[];
  /** A limited-time offer with a countdown needs an expiry timestamp. */
  offerExpiration: boolean;
  cards: TemplateCardSpec[];
};

export function emptyVariableSpec(bodyVariables: number[] = []): TemplateVariableSpec {
  return {
    header: [],
    headerMedia: null,
    body: bodyVariables,
    urlButtons: [],
    copyCodeButtons: [],
    offerExpiration: false,
    cards: [],
  };
}

function buttonSpecs(buttons: Array<Record<string, unknown>>): {
  urlButtons: TemplateUrlButton[];
  copyCodeButtons: number[];
} {
  const urlButtons: TemplateUrlButton[] = [];
  const copyCodeButtons: number[] = [];
  buttons.forEach((button, index) => {
    const type = String(button["type"] ?? "").toUpperCase();
    if (type === "URL") {
      const url = String(button["url"] ?? "");
      const variables = extractVariables(url);
      if (variables.length > 0) urlButtons.push({ index, variables, url });
    } else if (type === "COPY_CODE") {
      copyCodeButtons.push(index);
    }
  });
  return { urlButtons, copyCodeButtons };
}

/** Everything a template needs filled in at send time. */
export function templateVariableSpec(
  components: TemplateComponent[] | null | undefined,
): TemplateVariableSpec {
  const list = (components ?? []) as TemplateComponent[];
  const header = list.find((c) => String(c.type).toUpperCase() === "HEADER");
  const headerFormat = String(header?.format ?? "TEXT").toUpperCase();

  const headerVars =
    header && headerFormat === "TEXT" ? extractVariables(header.text ?? "") : [];

  const headerMedia =
    header && headerFormat !== "TEXT"
      ? {
          format: headerFormat as "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION",
          url: (header.example?.["aidwar_media_url"] as string | undefined) ?? null,
        }
      : null;

  const { urlButtons, copyCodeButtons } = buttonSpecs(templateButtons(list));

  const cards: TemplateCardSpec[] = templateCards(list).map((card, index) => {
    const specs = buttonSpecs(card.buttons);
    return {
      index,
      format: card.format,
      mediaUrl: card.mediaUrl,
      body: extractVariables(card.body),
      urlButtons: specs.urlButtons,
      copyCodeButtons: specs.copyCodeButtons,
    };
  });

  const offer = templateOffer(list);

  return {
    header: headerVars,
    headerMedia,
    body: extractVariables(templateBodyText(list)),
    urlButtons,
    copyCodeButtons,
    offerExpiration: Boolean(offer?.hasExpiration),
    cards,
  };
}

/** What we can send a media header with: our stored URL, or a Meta media id. */
export type MediaValue = { link?: string; id?: string; filename?: string };

export type CardValues = {
  /** Per-card picture. Falls back to the URL stored on the template. */
  media?: MediaValue;
  /** Values for the card's own {{1}}, {{2}}… */
  values?: Record<string, string>;
  /** Short-link tokens, keyed by the card button's index. */
  buttonTokens?: Record<number, string>;
  /** Coupon codes, keyed by the card button's index. */
  couponCodes?: Record<number, string>;
};

export type TemplatePayloadInput = {
  spec: TemplateVariableSpec;
  /** Values keyed by variable number, as used in the body text. */
  values: Record<string, string>;
  /** Header values, when the header carries its own variables. */
  headerValues?: Record<string, string>;
  /** Short-link tokens, one per URL button, keyed by button index. */
  buttonTokens?: Record<number, string>;
  /** The picture, video or document for a media header. */
  headerMedia?: MediaValue;
  /** A map pin for a location header. */
  headerLocation?: { latitude: string; longitude: string; name?: string; address?: string };
  /** Coupon codes for copy-code buttons, keyed by button index. */
  couponCodes?: Record<number, string>;
  /** When the offer countdown runs out, in milliseconds since the epoch. */
  offerExpirationMs?: number;
  /** One entry per carousel card, in card order. */
  cards?: CardValues[];
};

export type TemplatePayloadResult =
  | { components: Array<Record<string, unknown>>; error: null }
  | { components: null; error: string };

/**
 * Builds the Graph `template.components` payload and refuses to send when a
 * declared parameter has no value — naming the component and index instead of
 * letting Meta answer with #131008.
 */
export function buildTemplatePayloadComponents(
  input: TemplatePayloadInput,
): TemplatePayloadResult {
  const components: Array<Record<string, unknown>> = [];
  const spec = input.spec;

  // ---- header: media, location or text ----
  if (spec.headerMedia) {
    const format = spec.headerMedia.format;
    if (format === "LOCATION") {
      const loc = input.headerLocation;
      if (!loc?.latitude || !loc?.longitude) {
        return {
          components: null,
          error: missingComponent("header", "a map pin (latitude and longitude)"),
        };
      }
      components.push({
        type: "header",
        parameters: [
          {
            type: "location",
            location: {
              latitude: loc.latitude,
              longitude: loc.longitude,
              ...(loc.name ? { name: loc.name } : {}),
              ...(loc.address ? { address: loc.address } : {}),
            },
          },
        ],
      });
    } else {
      const media = resolveMedia(input.headerMedia, spec.headerMedia.url);
      if (!media) {
        return {
          components: null,
          error: missingComponent("header", `the ${format.toLowerCase()} it shows`),
        };
      }
      components.push({
        type: "header",
        parameters: [{ type: format.toLowerCase(), [format.toLowerCase()]: media }],
      });
    }
  } else if (spec.header.length > 0) {
    const missing = spec.header.filter((n) => !(input.headerValues ?? {})[String(n)]?.trim());
    if (missing.length > 0) {
      return { components: null, error: missingMessage("header", missing) };
    }
    components.push({
      type: "header",
      parameters: spec.header.map((n) => ({
        type: "text",
        text: (input.headerValues ?? {})[String(n)] as string,
      })),
    });
  }

  // ---- body ----
  if (spec.body.length > 0) {
    const missing = spec.body.filter((n) => !input.values[String(n)]?.trim());
    if (missing.length > 0) {
      return { components: null, error: missingMessage("body", missing) };
    }
    components.push({
      type: "body",
      parameters: spec.body.map((n) => ({ type: "text", text: input.values[String(n)] })),
    });
  }

  // ---- limited-time offer countdown ----
  if (spec.offerExpiration) {
    if (!input.offerExpirationMs) {
      return {
        components: null,
        error: missingComponent("offer", "the time the offer runs out"),
      };
    }
    components.push({
      type: "limited_time_offer",
      parameters: [
        {
          type: "limited_time_offer",
          limited_time_offer: { expiration_time_ms: input.offerExpirationMs },
        },
      ],
    });
  }

  // ---- buttons on the message itself ----
  for (const button of spec.urlButtons) {
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

  for (const index of spec.copyCodeButtons) {
    const code = (input.couponCodes ?? {})[index];
    if (!code || !code.trim()) {
      return {
        components: null,
        error: missingComponent(`button ${index} (copy code)`, "a coupon code"),
      };
    }
    components.push({
      type: "button",
      sub_type: "copy_code",
      index: String(index),
      parameters: [{ type: "coupon_code", coupon_code: code.trim() }],
    });
  }

  // ---- carousel cards ----
  if (spec.cards.length > 0) {
    const cards: Array<Record<string, unknown>> = [];
    for (const card of spec.cards) {
      const supplied = (input.cards ?? [])[card.index] ?? {};
      const cardComponents: Array<Record<string, unknown>> = [];

      const media = resolveMedia(supplied.media, card.mediaUrl);
      if (!media) {
        return {
          components: null,
          error: missingComponent(
            `card ${card.index + 1}`,
            `the ${card.format.toLowerCase()} it shows`,
          ),
        };
      }
      cardComponents.push({
        type: "header",
        parameters: [{ type: card.format.toLowerCase(), [card.format.toLowerCase()]: media }],
      });

      if (card.body.length > 0) {
        const values = supplied.values ?? {};
        const missing = card.body.filter((n) => !values[String(n)]?.trim());
        if (missing.length > 0) {
          return { components: null, error: missingMessage(`card ${card.index + 1}`, missing) };
        }
        cardComponents.push({
          type: "body",
          parameters: card.body.map((n) => ({ type: "text", text: values[String(n)] })),
        });
      }

      for (const button of card.urlButtons) {
        const token = (supplied.buttonTokens ?? {})[button.index];
        if (!token || !token.trim()) {
          return {
            components: null,
            error: missingMessage(
              `card ${card.index + 1}, button ${button.index} (link)`,
              button.variables,
            ),
          };
        }
        cardComponents.push({
          type: "button",
          sub_type: "url",
          index: String(button.index),
          parameters: [{ type: "text", text: token }],
        });
      }

      for (const index of card.copyCodeButtons) {
        const code = (supplied.couponCodes ?? {})[index];
        if (!code || !code.trim()) {
          return {
            components: null,
            error: missingComponent(
              `card ${card.index + 1}, button ${index} (copy code)`,
              "a coupon code",
            ),
          };
        }
        cardComponents.push({
          type: "button",
          sub_type: "copy_code",
          index: String(index),
          parameters: [{ type: "coupon_code", coupon_code: code.trim() }],
        });
      }

      cards.push({ card_index: card.index, components: cardComponents });
    }
    components.push({ type: "carousel", cards });
  }

  return { components, error: null };
}

/** Prefers what the caller supplied, falls back to the template's own file. */
function resolveMedia(
  supplied: MediaValue | undefined,
  storedUrl: string | null,
): Record<string, string> | null {
  if (supplied?.id) return { id: supplied.id };
  if (supplied?.link) {
    return { link: supplied.link, ...(supplied.filename ? { filename: supplied.filename } : {}) };
  }
  if (storedUrl) return { link: storedUrl };
  return null;
}

function missingMessage(component: string, missing: number[]): string {
  const list = missing.map((n) => `{{${n}}}`).join(", ");
  return `This message can't be sent: the template's ${component} needs ${list} and we have no value for ${missing.length > 1 ? "them" : "it"}.`;
}

function missingComponent(component: string, needs: string): string {
  return `This message can't be sent: the template's ${component} needs ${needs} and we have none.`;
}
