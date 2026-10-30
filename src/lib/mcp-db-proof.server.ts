import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Batch 56: the MCP server's proof to the database.
 *
 * An AI app's access token (Supabase OAuth, `client_id` claim) gets nothing
 * from Supabase on its own (20261300_batch56_mcp_hardening.sql): PostgREST's
 * pre-request guard refuses it and restrictive SELECT policies hide every row
 * from Realtime and Storage — unless the request carries this proof, which
 * only the AiDwar MCP server has. So the token works only through the MCP
 * tools and their rules (masking, page caps, the kill switch, rate limits,
 * the audit log).
 *
 * The proof is an HMAC-SHA256 of a fixed message under a key derived with
 * HKDF from the server-only AIDWAR_SUPABASE_SERVICE_ROLE_KEY and the label
 * "aidwar-mcp-db-proof" (no new secret; the derived key is good for nothing
 * else). It travels only from this server to Supabase, as the
 * x-aidwar-mcp-proof header on the one client every tool reads through
 * (mcpUserClient). The database stores only its sha256, set through the
 * service-role-only mcp_set_db_proof_hash() by ensureDbProof, once per
 * isolate before the first read (the bootstrap; never client code).
 */

export const MCP_DB_PROOF_LABEL = "aidwar-mcp-db-proof";
export const MCP_DB_PROOF_HEADER = "x-aidwar-mcp-proof";
/** The guard's HINT when a client_id token comes without a valid proof. */
export const MCP_DB_PROOF_REFUSAL_HINT = "aidwar_mcp_proof_required";

const enc = new TextEncoder();
const proofCache = new Map<string, Promise<string>>();

function rootSecret(): string {
  const secret = process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!secret) throw new Error("Missing AiDwar backend service configuration.");
  return secret;
}

function base64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The header value (43 base64url characters); the same for every request of this deployment. */
export function mcpDbProof(secret = rootSecret()): Promise<string> {
  let proof = proofCache.get(secret);
  if (!proof) {
    proof = (async () => {
      const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(MCP_DB_PROOF_LABEL) },
        ikm,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      );
      return base64url(await crypto.subtle.sign("HMAC", key, enc.encode(`v1|${MCP_DB_PROOF_LABEL}`)));
    })();
    proofCache.set(secret, proof);
  }
  return proof;
}

/** sha256 hex of the proof: what the database keeps (and all it keeps). */
export async function mcpDbProofHash(proof: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(proof));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

type CreateClient = (url: string, key: string, options: Record<string, unknown>) => SupabaseClient;

let rejectionLogged = false;

/**
 * fetch for the MCP user client: a refusal by the guard for want of the proof
 * means the deployment and the database disagree (hash not set, or the key
 * rotated). The person only sees the tool's usual "something went wrong";
 * the log says why, once per isolate.
 */
export function proofWatchingFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await base(input, init);
    if ((res.status === 401 || res.status === 403) && !rejectionLogged) {
      const body = await res.clone().text().catch(() => "");
      if (body.includes(MCP_DB_PROOF_REFUSAL_HINT)) {
        rejectionLogged = true;
        console.error(
          JSON.stringify({
            at: "mcp_db_proof_rejected",
            error: "The database refused the MCP server's proof; every MCP read fails until mcp_set_db_proof_hash is run (ensureDbProof).",
          }),
        );
      }
    }
    return res;
  };
}

/**
 * The one Supabase client the MCP tools read through for a caller: their
 * OAuth access token (RLS decides what they see) plus the proof header on
 * every request (PostgREST, rpc and Storage alike).
 */
export function mcpUserClient(
  token: string,
  opts: { url: string; anonKey: string; proof: string; createClient: CreateClient; fetch?: typeof fetch },
): SupabaseClient {
  return opts.createClient(opts.url, opts.anonKey, {
    global: {
      headers: { Authorization: `Bearer ${token}`, [MCP_DB_PROOF_HEADER]: opts.proof },
      fetch: proofWatchingFetch(opts.fetch ?? fetch),
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type ProofSync = "match" | "set" | "replaced" | "not_applied" | "failed";

let ensured: Promise<ProofSync> | null = null;

/**
 * The bootstrap and self-check, once per isolate: store the proof's hash
 * (service role) and say what happened. "match" is silent; a first set or a
 * replacement is logged; a database without 20261300 (PGRST202) keeps
 * working as before; any other failure is logged loudly and retried by the
 * next isolate (or the next request after a failure).
 */
export function ensureDbProof(service: SupabaseClient, proof: Promise<string> | string): Promise<ProofSync> {
  if (!ensured) {
    ensured = (async (): Promise<ProofSync> => {
      try {
        const hash = await mcpDbProofHash(await proof);
        const { data, error } = await service.rpc("mcp_set_db_proof_hash", { p_hash: hash });
        if (error) {
          const code = (error as { code?: string }).code;
          if (code === "PGRST202") {
            console.warn(JSON.stringify({ at: "mcp_db_proof_not_applied", note: "20261300 isn't applied yet; MCP reads work as before." }));
            return "not_applied";
          }
          console.error(JSON.stringify({ at: "mcp_db_proof_failed", error: error.message, code: code ?? null }));
          ensured = null;
          return "failed";
        }
        const state = (typeof data === "string" ? data : Array.isArray(data) ? data[0] : null) as ProofSync | null;
        // A first set is expected once after 20261300; a replacement means the
        // old proof was being refused (the service-role key was rotated).
        if (state === "set") console.warn(JSON.stringify({ at: "mcp_db_proof_stored", state }));
        if (state === "replaced") console.error(JSON.stringify({ at: "mcp_db_proof_stored", state }));
        if (state !== "match" && state !== "set" && state !== "replaced") {
          console.error(JSON.stringify({ at: "mcp_db_proof_failed", error: `unexpected answer ${JSON.stringify(data)}` }));
          ensured = null;
          return "failed";
        }
        return state;
      } catch (error) {
        console.error(JSON.stringify({ at: "mcp_db_proof_failed", error: error instanceof Error ? error.message : String(error) }));
        ensured = null;
        return "failed";
      }
    })();
  }
  return ensured;
}

/** Test-only: forget the per-isolate state. */
export function resetDbProofStateForTests(): void {
  ensured = null;
  rejectionLogged = false;
  proofCache.clear();
}
