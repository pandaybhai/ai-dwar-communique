import type { SupabaseClient } from "@supabase/supabase-js";
import { SCRIPTS, fillScript, type ScriptKey } from "@/lib/scripts";

type Loader = (key: ScriptKey) => Promise<string | null>;

const CACHE_MS = 60_000;
const cache = new Map<ScriptKey, { text: string | null; at: number }>();

function dbLoader(supabase: SupabaseClient): Loader {
  return async (key) => {
    const { data, error } = await supabase
      .from("ai_prompt_blocks")
      .select("content")
      .eq("key", key)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as { content?: string } | null)?.content ?? null;
  };
}

/**
 * One of Aiden's fixed texts, filled in. Always returns sendable text: the
 * built-in default is used when the saved row is missing, the lookup errors
 * or takes longer than timeoutMs, the text is blank, or any {placeholder}
 * is left unfilled. Every fallback is logged.
 */
export async function getScript(
  supabase: SupabaseClient | null,
  key: ScriptKey,
  vars: Record<string, string | number> = {},
  options: { timeoutMs?: number; load?: Loader; noCache?: boolean } = {},
): Promise<string> {
  const fallback = (reason: string) => {
    console.warn("[scripts] fallback", JSON.stringify({ key, reason }));
    return fillScript(SCRIPTS[key].text, vars) ?? SCRIPTS[key].text.replace(/\{[a-z_]+\}/g, "").replace(/\s{2,}/g, " ").trim();
  };

  let saved: string | null = null;
  const hit = options.noCache || options.load ? undefined : cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    saved = hit.text;
  } else {
    const load = options.load ?? (supabase ? dbLoader(supabase) : null);
    if (!load) return fallback("no_client");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      saved = await Promise.race([
        load(key),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), options.timeoutMs ?? 800);
        }),
      ]);
      if (!options.load) cache.set(key, { text: saved, at: Date.now() });
    } catch (error) {
      return fallback(error instanceof Error && error.message === "timeout" ? "timeout" : "error");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (saved === null) return fallback("missing");
  const filled = fillScript(saved, vars);
  return filled ?? fallback("blank_or_unfilled");
}

/** Drop cached texts after an admin save so the change is live at once in this worker. */
export function clearScriptCache(): void {
  cache.clear();
}
