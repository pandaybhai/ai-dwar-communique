/**
 * Batch 72: what a visitor typed on /start (name, WhatsApp number), handed to
 * /signup in this tab only — sessionStorage, never the address bar, so the
 * number is never in a URL, a referrer or an analytics page_location.
 */
const KEY = "aidwar.start.prefill";

export type StartPrefill = { name: string; phone: string };

export function writeStartPrefill(value: StartPrefill): void {
  try {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ name: value.name.slice(0, 100), phone: value.phone.slice(0, 30) }),
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
    };
  } catch {
    return { name: "", phone: "" };
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
