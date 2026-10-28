import type { ApiReply } from "@/lib/public-api.server";

/**
 * Batch 38: small helpers the v1.2 endpoints share — the error answer, the
 * opaque list cursor, the id check. The route runner is Batch 37's
 * runApiRoute (public-api.server.ts).
 */

export type { ApiReply };

export const fail = (status: number, code: string, error: string): ApiReply => ({
  status,
  body: { error, code },
});

/** A cursor for "after this row" lists: opaque to callers (base64url of "time|id"). */
export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null): { at: string; id: string } | null | "invalid" {
  if (!raw) return null;
  try {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const [at, id] = text.split("|");
    if (
      !at ||
      !id ||
      !/^[0-9T:.+\- Z]{10,40}$/.test(at) ||
      Number.isNaN(Date.parse(at)) ||
      !/^[A-Za-z0-9-]{1,64}$/.test(id)
    )
      return "invalid";
    return { at, id };
  } catch {
    return "invalid";
  }
}

/** Ids the API takes in a path: uuid-like, nothing else reaches a query. */
export function validId(raw: string): boolean {
  return /^[A-Za-z0-9-]{1,64}$/.test(raw);
}
