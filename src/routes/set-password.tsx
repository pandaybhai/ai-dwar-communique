import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

/**
 * Batch 81: where the "Set a password" email lands (sent from the /999
 * success screen with resetPasswordForEmail). The link signs the browser in
 * (the client reads the session from the link); the person picks a password
 * with the existing auth API (updateUser) and goes on to the app. Email +
 * password log-in then works as for everyone else. Not indexed.
 */
export const Route = createFileRoute("/set-password")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Set your password — AiDwar" }, { name: "robots", content: "noindex" }],
  }),
  component: SetPassword,
});

function SetPassword() {
  const navigate = useNavigate();
  const [ready, setReady] = useState<"wait" | "yes" | "no">("wait");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void import("@/integrations/aidwar/client").then(async ({ aidwar }) => {
      // The link's session may land a moment after the page.
      for (let i = 0; i < 10 && live; i++) {
        const { data } = await aidwar.auth.getSession();
        if (data.session) {
          if (live) setReady("yes");
          return;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      if (live) setReady("no");
    });
    return () => {
      live = false;
    };
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    setBusy(true);
    const { aidwar } = await import("@/integrations/aidwar/client");
    const { error: err } = await aidwar.auth.updateUser({ password });
    setBusy(false);
    if (err) {
      setError("We couldn't save that password. Please try the link again.");
      return;
    }
    void navigate({ to: "/app" });
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-sm">
        <h1 className="text-2xl font-extrabold tracking-tight text-foreground">
          Set your password
        </h1>
        {ready === "wait" ? (
          <p className="mt-3 text-sm text-muted-foreground">Checking your link…</p>
        ) : ready === "no" ? (
          <p className="mt-3 text-sm text-muted-foreground">
            This link has expired or was already used. Open the newest email from AiDwar, or log in
            with the link we email you.
          </p>
        ) : (
          <form onSubmit={(e) => void save(e)} className="mt-4 space-y-3">
            <label htmlFor="new-password" className="block text-sm font-medium text-foreground">
              New password
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-12 w-full rounded-xl border border-input bg-background px-3 text-base"
            />
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">At least 8 characters.</p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="h-12 w-full rounded-xl bg-primary text-base font-semibold text-primary-foreground"
            >
              {busy ? "Saving…" : "Save and continue"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
