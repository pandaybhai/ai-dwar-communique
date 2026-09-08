/**
 * The picture cards Aiden sends on day one.
 *
 * The drawing itself happens in the `render-card` function on the aidwar
 * backend: this app's server runtime refuses to load the rasteriser
 * ("Wasm code generation disallowed by embedder"), so all we do here is ask
 * for a card and hand back the URL.
 *
 * Rule of the house: a card is decoration. If anything at all goes wrong we
 * return null and the caller sends its words as plain text. A picture must
 * never be the reason a message doesn't arrive.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type CardKind = "id-card" | "notebook" | "brief" | "credits" | "on-duty";

const TIMEOUT_MS = 6000;

/** Short, stable fingerprint of the values a card was drawn with. */
function varsHash(vars: Record<string, string | number>): string {
  const text = JSON.stringify(vars);
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const urlCache = new Map<string, string>();

/**
 * Render one card and return a public URL for it, or null when anything at all
 * gets in the way.
 *
 * The `supabase` argument is kept for call-site compatibility; the renderer
 * writes to storage itself.
 */
export async function renderCard(
  _supabase: SupabaseClient,
  kind: CardKind,
  args: { sessionId: string; vars: Record<string, string | number> },
): Promise<string | null> {
  const cacheKey = `${args.sessionId}/${kind}-${varsHash(args.vars)}`;
  const cached = urlCache.get(cacheKey);
  if (cached) return cached;

  const baseUrl = process.env["AIDWAR_SUPABASE_URL"];
  const serviceKey = process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"];

  try {
    if (!baseUrl || !serviceKey) throw new Error("renderer credentials are not configured");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/$/, "")}/functions/v1/render-card`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ kind, vars: args.vars, cacheKey }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const payload = (await res.json().catch(() => null)) as
      | { url?: string; error?: string }
      | null;

    if (!res.ok) throw new Error(`render-card ${res.status}: ${payload?.error ?? "no body"}`);
    const url = payload?.url;
    if (!url) throw new Error("render-card returned no url");

    urlCache.set(cacheKey, url);
    return url;
  } catch (error) {
    console.error(
      "[onboarding-cards]",
      kind,
      error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
    );
    return null;
  }
}
