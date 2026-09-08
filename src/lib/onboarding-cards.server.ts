/**
 * The picture cards Aiden sends on day one.
 *
 * The five HTML files in ./onboarding-cards are the design and are used
 * unchanged — this module only fills the {{placeholders}}, turns the markup
 * into a PNG and puts it somewhere WhatsApp can fetch it.
 *
 * Rule of the house: a card is decoration. If anything at all goes wrong we
 * return null and the caller sends its words as plain text. A picture must
 * never be the reason a message doesn't arrive.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import idCardHtml from "./onboarding-cards/id-card.html?raw";
import notebookHtml from "./onboarding-cards/notebook.html?raw";
import briefHtml from "./onboarding-cards/brief.html?raw";
import creditsHtml from "./onboarding-cards/credits.html?raw";
import onDutyHtml from "./onboarding-cards/on-duty.html?raw";

export type CardKind = "id-card" | "notebook" | "brief" | "credits" | "on-duty";

const TEMPLATES: Record<CardKind, string> = {
  "id-card": idCardHtml,
  notebook: notebookHtml,
  brief: briefHtml,
  credits: creditsHtml,
  "on-duty": onDutyHtml,
};

const BUCKET = "onboarding-cards";

/** Must track the @resvg/resvg-wasm version in package.json. */
const RESVG_VERSION = "2.6.2";

/** The design is drawn at this size and upscaled to 1080x1350 on output. */
const DESIGN_WIDTH = 540;
const DESIGN_HEIGHT = 675;
const OUTPUT_WIDTH = 1080;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? whole : escapeHtml(String(value));
  });
}

/**
 * The design wraps a 540x675 card in a scale(2) box so a browser screenshot
 * lands at 1080x1350. We render the card itself and let the rasteriser do the
 * scaling, which is sharper and avoids relying on transform support.
 */
function cardMarkup(template: string): string {
  const body = template.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? template;
  const withoutScaler = body.replace(
    /<div style="[^"]*transform:\s*scale\([^"]*"\s*>/i,
    "<div>",
  );
  return withoutScaler.replace(/<style>[\s\S]*?<\/style>/gi, "").trim();
}


// ------------------------------------------------------- markup -> elements

type ParsedNode = {
  type: number;
  name?: string;
  value?: string;
  attributes?: Record<string, string>;
  children?: ParsedNode[];
};

const ELEMENT = 1;
const TEXT = 2;
const DOCUMENT = 0;

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}


/** Satori has no oklch support, so colours are converted to plain sRGB. */
function oklchToCss(l: number, c: number, hDeg: number, alpha: number): string {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;

  const lin = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];

  const channel = (v: number): number => {
    const srgb = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(srgb * 255)));
  };

  const [r, g, bl] = lin.map(channel) as [number, number, number];
  return alpha >= 1 ? `rgb(${r}, ${g}, ${bl})` : `rgba(${r}, ${g}, ${bl}, ${alpha})`;
}

/** Rewrites every oklch(...) inside a declaration value. */
function convertColors(value: string): string {
  return value.replace(/oklch\(([^)]+)\)/gi, (whole, inner: string) => {
    const [coords, alphaPart] = String(inner).split("/");
    const parts = (coords ?? "").trim().split(/\s+/);
    if (parts.length < 3) return whole;
    const num = (raw: string | undefined): number => {
      const text = (raw ?? "").trim();
      const n = Number.parseFloat(text);
      if (Number.isNaN(n)) return 0;
      return text.endsWith("%") ? n / 100 : n;
    };
    const alpha = alphaPart === undefined ? 1 : num(alphaPart);
    return oklchToCss(num(parts[0]), num(parts[1]), num(parts[2]), alpha);
  });
}

/** "font-size: 12px; color: red" -> { fontSize: "12px", color: "red" } */
function parseStyle(value: string): Record<string, string> {
  const style: Record<string, string> = {};
  let depth = 0;
  let current = "";
  const parts: string[] = [];
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === ";" && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);

  for (const part of parts) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const val = part.slice(at + 1).trim();
    if (!key || !val) continue;
    if (UNSUPPORTED_STYLE.has(key)) continue;
    style[camel(key)] = convertColors(val);
  }
  return style;
}

/** Declarations satori has no layout for; dropping them beats throwing. */
const UNSUPPORTED_STYLE = new Set([
  "font-variant-numeric",
  "text-wrap",
  "text-wrap-mode",
  "background-clip",
  "-webkit-background-clip",
  "-webkit-text-fill-color",
  "backdrop-filter",
  "mix-blend-mode",
  "grid-template-areas",
]);


/**
 * Satori wants React-shaped elements, not HTML. This is a deliberately small
 * converter for our own templates: inline styles, plain divs and inline SVG.
 */
function toVNode(node: ParsedNode): unknown {
  if (node.type === TEXT) return node.value ?? "";
  // Comments and doctype carry nothing satori can draw.
  if (node.type !== ELEMENT && node.type !== DOCUMENT) return null;


  const children = (node.children ?? [])
    .map((child) => toVNode(child))
    .filter((child) => child !== null)
    .filter((child) => !(typeof child === "string" && child.trim().length === 0));

  if (!node.name || node.type !== ELEMENT) {
    // The document wrapper: hand satori the single card element.
    return children.find((c) => typeof c === "object") ?? { type: "div", props: { children } };
  }


  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.attributes ?? {})) {
    if (key === "style") props["style"] = parseStyle(value);
    else if (key.startsWith("data-") || key.startsWith("aria-")) props[key] = value;
    else props[camel(key)] = value;
  }

  // Satori lays out with flexbox only and refuses a plain div that has more
  // than one child, so a div without its own display gets the flex default.
  // A grid becomes a wrapping flex row of equal-width cells.
  let columns = 0;
  if (node.name === "div") {
    const style = { ...((props["style"] as Record<string, string> | undefined) ?? {}) };
    if (style["display"] === "grid") {
      const repeat = (style["gridTemplateColumns"] ?? "").match(/repeat\(\s*(\d+)/);
      columns = repeat ? Number.parseInt(repeat[1] ?? "2", 10) : 2;
      style["display"] = "flex";
      style["flexDirection"] = "row";
      style["flexWrap"] = "wrap";
      delete style["gridTemplateColumns"];
      delete style["gridTemplateRows"];
    }
    if (!style["display"]) style["display"] = "flex";
    props["style"] = style;
  }

  // Leave a little room for the gap so two cells still share one row.
  const basis = columns > 0 ? `${(100 / columns - 3).toFixed(2)}%` : null;
  const laidOut = basis
    ? children.map((child) =>
        child !== null && typeof child === "object"
          ? {
              ...(child as { type: string; props: Record<string, unknown> }),
              props: {
                ...(child as { props: Record<string, unknown> }).props,
                style: {
                  ...(((child as { props: Record<string, unknown> }).props["style"] as
                    | Record<string, string>
                    | undefined) ?? {}),
                  flexGrow: "0",
                  flexShrink: "0",
                  flexBasis: basis,
                },
              },
            }
          : child,
      )
    : children;

  props["children"] = laidOut.length === 1 ? laidOut[0] : laidOut;



  return { type: node.name, props };
}


// ------------------------------------------------------------------- fonts

type LoadedFont = { name: string; data: ArrayBuffer; weight: number; style: "normal" };

let fontsPromise: Promise<LoadedFont[]> | null = null;

/** Google's CSS endpoint hands back a plain TTF when we don't claim a modern browser. */
async function fetchFont(family: string, weight: number): Promise<LoadedFont | null> {
  try {
    const cssRes = await fetch(
      `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`,
    );
    if (!cssRes.ok) return null;
    const css = await cssRes.text();
    const url = css.match(/src:\s*url\((https:[^)]+\.ttf)\)/i)?.[1];
    if (!url) return null;
    const fontRes = await fetch(url);
    if (!fontRes.ok) return null;
    return { name: family, data: await fontRes.arrayBuffer(), weight, style: "normal" };
  } catch {
    return null;
  }
}

function loadFonts(): Promise<LoadedFont[]> {
  if (!fontsPromise) {
    fontsPromise = Promise.all([
      fetchFont("Plus Jakarta Sans", 400),
      fetchFont("Plus Jakarta Sans", 600),
      fetchFont("Plus Jakarta Sans", 700),
      fetchFont("Plus Jakarta Sans", 800),
      fetchFont("Caveat", 600),
    ])
      .then((list) => list.filter((f): f is LoadedFont => f !== null))
      .catch(() => []);
  }
  return fontsPromise;
}

// -------------------------------------------------------------------- wasm

let wasmReady: Promise<boolean> | null = null;

async function initRenderer(): Promise<boolean> {
  if (!wasmReady) {
    wasmReady = (async () => {
      try {
        const { initWasm } = await import("@resvg/resvg-wasm");
        // Fetched rather than bundled: the rasteriser's wasm expects host
        // bindings the worker bundler can't resolve at build time.
        const res = await fetch(`https://unpkg.com/@resvg/resvg-wasm@${RESVG_VERSION}/index_bg.wasm`);
        if (!res.ok) return false;
        await initWasm(await res.arrayBuffer());
        return true;
      } catch {
        return false;
      }
    })();

  }
  return wasmReady;
}

// ------------------------------------------------------------------- cache

const urlCache = new Map<string, string>();

function cacheKey(sessionId: string, kind: CardKind, vars: Record<string, string | number>): string {
  return `${sessionId}:${kind}:${JSON.stringify(vars)}`;
}

/**
 * Render one card and return a public URL for it, or null when anything at all
 * gets in the way.
 */
export async function renderCard(
  supabase: SupabaseClient,
  kind: CardKind,
  args: { sessionId: string; vars: Record<string, string | number> },
): Promise<string | null> {
  const key = cacheKey(args.sessionId, kind, args.vars);
  const cached = urlCache.get(key);
  if (cached) return cached;

  try {
    const template = TEMPLATES[kind];
    if (!template) return null;

    const [fonts, ready] = await Promise.all([loadFonts(), initRenderer()]);
    if (fonts.length === 0 || !ready) return null;

    const [{ default: satori }, { parse }, { Resvg }] = await Promise.all([
      import("satori"),
      import("ultrahtml"),
      import("@resvg/resvg-wasm"),
    ]);

    const markup = cardMarkup(fill(template, args.vars));
    const svg = await satori(toVNode(parse(markup)) as never, {

      width: DESIGN_WIDTH,
      height: DESIGN_HEIGHT,
      fonts: fonts.map((f) => ({
        name: f.name,
        data: f.data,
        weight: f.weight as 400,
        style: f.style,
      })),
    });

    const png = new Resvg(svg, {
      fitTo: { mode: "width", value: OUTPUT_WIDTH },
      background: "#ffffff",
    })
      .render()
      .asPng();

    const path = `${args.sessionId}/${kind}-${Date.now()}.png`;
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, png, { contentType: "image/png", upsert: true });
    if (error) return null;

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    const url = data?.publicUrl ?? null;
    if (url) urlCache.set(key, url);
    return url;
  } catch {
    return null;
  }
}
