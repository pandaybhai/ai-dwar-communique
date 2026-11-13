/**
 * Batch 72: what a visitor typed on /start (name, WhatsApp number), handed to
 * /signup in this tab only — sessionStorage, never the address bar, so the
 * number is never in a URL, a referrer or an analytics page_location.
 */
const KEY = "aidwar.start.prefill";

/** Batch 78: + the business name typed on /start (sign-up itself has no field for it). */
export type StartPrefill = { name: string; phone: string; business?: string };

export function writeStartPrefill(value: StartPrefill): void {
  try {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({
        name: value.name.slice(0, 100),
        phone: value.phone.slice(0, 30),
        business: (value.business ?? "").slice(0, 150),
      }),
    );
  } catch {
    // sign-up simply starts empty
  }
}

export function readStartPrefill(): StartPrefill {
  try {
    const raw = typeof window === "undefined" ? null : window.sessionStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Partial<StartPrefill>) : {};
    return {
      name: typeof v.name === "string" ? v.name : "",
      phone: typeof v.phone === "string" ? v.phone : "",
      business: typeof v.business === "string" ? v.business : "",
    };
  } catch {
    return { name: "", phone: "", business: "" };
  }
}

export function clearStartPrefill(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}

/**
 * Batch 75: tells the server this new account came from /start, so the
 * reminder never goes to someone who already signed up. The lead is read from
 * the signed /start cookie on the server (never from here); keepalive lets it
 * finish while the page moves on. Never blocks or fails sign-up.
 */
export function linkStartLead(userId: string): void {
  try {
    void fetch("/api/public/start-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ user_id: userId }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // linking is a courtesy; sign-up never waits on it
  }
}
