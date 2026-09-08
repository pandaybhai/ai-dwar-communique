/**
 * Pictures and voice notes, turned into words.
 *
 * Owners send photos of price lists and talk instead of typing; customers do
 * the same. Everything here produces plain text the rest of the AI already
 * understands, and every call is metered on the workspace like a reader call.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** ₹ per transcription call — the same order as the website reader. */
export const TRANSCRIBE_COST = 0.25;

const GATEWAY = "https://ai.gateway.lovable.dev/v1";

/** Meta media id -> bytes + mime. Null when Meta no longer has the file. */
export async function fetchMetaMedia(
  mediaId: string,
  accessToken: string,
  maxBytes = 8 * 1024 * 1024,
): Promise<{ bytes: Uint8Array; mime: string | null } | null> {
  const { GRAPH_VERSION } = await import("@/lib/whatsapp-api.server");
  const lookup = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = (await lookup.json().catch(() => ({}))) as Record<string, unknown>;
  const url = body["url"] as string | undefined;
  if (!lookup.ok || !url) return null;
  const file = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!file.ok) return null;
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > maxBytes) return null;
  return {
    bytes: new Uint8Array(buffer),
    mime: (body["mime_type"] as string | undefined) ?? file.headers.get("content-type"),
  };
}

function audioExtension(mime: string | null | undefined): string {
  const m = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  return "ogg";
}

/**
 * A voice note -> its words. Uses the platform's OpenAI credential (the same
 * one the chat runs resolve) and falls back to the Lovable gateway. Metered
 * as `transcription` on the workspace.
 */
export async function transcribeAudio(
  supabase: SupabaseClient,
  organizationId: string,
  bytes: Uint8Array,
  mime: string | null,
): Promise<{ text: string | null; error: string | null }> {
  const { providerCredential, meterAiUsage } = await import("@/lib/ai-run.server");
  const cred = await providerCredential(supabase, organizationId, "openai");

  const attempts: Array<{ base: string; headers: Record<string, string>; model: string }> = [];
  if (cred.key && cred.direct) {
    attempts.push({
      base: cred.base,
      headers: { Authorization: `Bearer ${cred.key}` },
      model: "gpt-4o-mini-transcribe",
    });
  }
  const gatewayKey = process.env["LOVABLE_API_KEY"];
  if (gatewayKey) {
    attempts.push({
      base: GATEWAY,
      headers: { Authorization: `Bearer ${gatewayKey}` },
      model: "openai/gpt-4o-mini-transcribe",
    });
  }
  if (attempts.length === 0) return { text: null, error: "No transcription credential." };

  let lastError = "Transcription failed.";
  for (const attempt of attempts) {
    try {
      const form = new FormData();
      form.append("model", attempt.model);
      form.append(
        "file",
        new Blob([bytes as unknown as ArrayBuffer], { type: mime ?? "audio/ogg" }),
        `voice.${audioExtension(mime)}`,
      );
      const res = await fetch(`${attempt.base}/audio/transcriptions`, {
        method: "POST",
        headers: attempt.headers,
        body: form,
      });
      const raw = await res.text();
      if (!res.ok) {
        lastError = `${res.status} ${raw.slice(0, 200)}`;
        console.error("[ai-media] transcription failed", attempt.base, lastError);
        continue;
      }
      let text = "";
      try {
        text = String((JSON.parse(raw) as { text?: string }).text ?? "");
      } catch {
        text = raw;
      }
      await meterAiUsage(supabase, organizationId, "transcription", {
        costAmount: TRANSCRIBE_COST,
        runs: 1,
      });
      const clean = text.trim();
      return clean ? { text: clean, error: null } : { text: null, error: "Nothing was said." };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error("[ai-media] transcription error", lastError);
    }
  }
  return { text: null, error: lastError };
}

/**
 * One line about a customer's photo, so the agent can answer "is this in
 * stock?" or "how much is this?" — never a transcription of a whole document.
 */
export async function describeImage(
  supabase: SupabaseClient,
  organizationId: string,
  bytes: Uint8Array,
  mime: string | null,
  options: { channel?: "onboarding" | null; conversationId?: string | null } = {},
): Promise<{ text: string | null; error: string | null }> {
  const { executeRun } = await import("@/lib/ai-run.server");
  const base64 = Buffer.from(bytes as unknown as ArrayLike<number>).toString("base64");
  try {
    const run = await executeRun(supabase, {
      organizationId,
      task: "agent_reply",
      tier: "everyday",
      input: "Describe this picture.",
      imageDataUrl: `data:${mime && mime.startsWith("image/") ? mime : "image/jpeg"};base64,${base64}`,
      system:
        "In one short sentence, say what this picture shows (product, item, receipt, screenshot, " +
        "place). Quote any product name, code or price visible. No opinions, no greetings.",
      metadata: { purpose: "customer_image" },
      conversationId: options.conversationId ?? null,
      billingExempt: true,
      channel: options.channel ?? null,
    });
    const text = (run.output ?? "").trim();
    return text ? { text, error: null } : { text: null, error: run.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ai-media] describe failed", message);
    return { text: null, error: message };
  }
}
