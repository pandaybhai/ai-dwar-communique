import { aidwar } from "@/integrations/aidwar/client";

/** Calls an authenticated AiDwar API route with the current session bearer. */
export async function callApi<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ data: T | null; error: string | null; raw: unknown }> {
  const { data: sessionData } = await aidwar.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) return { data: null, error: "Your session expired. Please sign in again.", raw: null };

  const method = init.method ?? "POST";
  const sendsBody = method !== "GET" && method !== "HEAD";
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(sendsBody ? { "content-type": "application/json" } : {}),
    },
    ...(sendsBody ? { body: JSON.stringify(init.body ?? {}) } : {}),
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

/** Uploads a file to an authenticated AiDwar API route. */
export async function uploadApi<T>(
  path: string,
  form: FormData,
): Promise<{ data: T | null; error: string | null }> {
  const { data: sessionData } = await aidwar.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) return { data: null, error: "Your session expired. Please sign in again." };

  const res = await fetch(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
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
      "We couldn't upload that file. Please try again.";
    return { data: null, error: String(message) };
  }
  return { data: json as T, error: null };
}
