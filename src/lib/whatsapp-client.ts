import { aidwar } from "@/integrations/aidwar/client";

/** Calls an authenticated AiDwar API route with the current session bearer. */
export async function callApi<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ data: T | null; error: string | null; raw: unknown }> {
  const { data: sessionData } = await aidwar.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) return { data: null, error: "Your session expired. Please sign in again.", raw: null };

  const res = await fetch(path, {
    method: init.method ?? "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(init.body ?? {}),
  });

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok) {
    const message =
      (json && typeof json === "object" && (json as Record<string, unknown>)["error"]) ||
      "Something went wrong. Please try again.";
    return { data: null, error: String(message), raw: json };
  }
  return { data: json as T, error: null, raw: json };
}
