import { useEffect, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { StartQuestions } from "@/components/start/start-questions";
import { writeStartPrefill } from "@/lib/start-prefill";
import { signupSearchFrom } from "@/lib/start-page";
import type { Customers, Sells } from "@/lib/start-qualify";

/**
 * Batch 75: where the "finish sign-up" WhatsApp reminder lands
 * (/start/continue?t=…). The token resumes exactly one /start lead for 48
 * hours: the name and number come back prefilled and any answers already
 * given are remembered; both questions are still required, then /signup as
 * from /start. Not indexed; the token never leaves this site in a referrer.
 */
export const Route = createFileRoute("/start_/continue")({
  validateSearch: (search: Record<string, unknown>): { t?: string } =>
    typeof search["t"] === "string" ? { t: search["t"].slice(0, 300) } : {},
  head: () => ({
    meta: [
      { title: "Finish signing up — AiDwar" },
      { name: "robots", content: "noindex,nofollow" },
      { name: "referrer", content: "same-origin" },
    ],
  }),
  component: ContinueSignup,
});

type Resumed = {
  name: string;
  phone: string;
  sells: Sells | null;
  customers: Customers | null;
};

function ContinueSignup() {
  const { t } = Route.useSearch();
  const navigate = useNavigate();
  const [state, setState] = useState<"loading" | "expired" | "signed_up" | "ready">("loading");
  const [lead, setLead] = useState<Resumed | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/public/start-continue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ t: t ?? "" }),
        });
        const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!live) return;
        if (!res.ok) return setState("expired");
        if (out["signed_up"]) return setState("signed_up");
        setLead({
          name: String(out["name"] ?? ""),
          phone: String(out["phone"] ?? ""),
          sells: (out["sells"] as Sells | null) ?? null,
          customers: (out["customers"] as Customers | null) ?? null,
        });
        setState("ready");
      } catch {
        if (live) setState("expired");
      }
    })();
    return () => {
      live = false;
    };
  }, [t]);

  async function finish(answers: { sells: Sells; customers: Customers }) {
    if (!lead || saving) return;
    setSaving(true);
    try {
      await fetch("/api/public/start-qualify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(answers),
      });
    } catch {
      // both answers were given; a busy network never strands the visitor
    }
    writeStartPrefill({ name: lead.name, phone: lead.phone });
    await navigate({ to: "/signup", search: signupSearchFrom(window.location.search) as never });
  }

  const first = lead?.name.trim().split(/\s+/)[0] ?? "";
  return (
    <main className="grid min-h-screen place-items-center bg-[#06120e] px-4 py-10">
      <div className="w-full max-w-md rounded-3xl bg-background p-6 text-foreground shadow-2xl sm:p-8">
        <p className="text-xl font-extrabold tracking-tight">
          Ai<span className="text-success">Dwar</span>
        </p>
        {state === "loading" ? (
          <p className="mt-6 flex items-center gap-2 text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Getting your details…
          </p>
        ) : state === "expired" ? (
          <div className="mt-6 space-y-4" data-testid="continue-expired">
            <h1 className="text-2xl font-bold">This link has expired</h1>
            <p className="text-muted-foreground">
              It was good for 48 hours. Start again — it takes a minute.
            </p>
            <Link
              to="/start"
              className="inline-flex min-h-12 items-center rounded-xl bg-success px-5 font-bold text-success-foreground"
            >
              Start free trial
            </Link>
          </div>
        ) : state === "signed_up" ? (
          <div className="mt-6 space-y-4">
            <h1 className="text-2xl font-bold">You&apos;re already signed up</h1>
            <Link
              to="/login"
              className="inline-flex min-h-12 items-center rounded-xl bg-success px-5 font-bold text-success-foreground"
            >
              Log in
            </Link>
          </div>
        ) : lead ? (
          <div className="mt-6 space-y-5" data-testid="continue-ready">
            <div>
              <h1 className="text-2xl font-bold">Welcome back{first ? `, ${first}` : ""}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Finishing sign-up for{" "}
                <span className="font-semibold text-foreground">{lead.phone}</span>
              </p>
            </div>
            <StartQuestions
              onDone={(a) => void finish(a)}
              busy={saving}
              initial={{ sells: lead.sells, customers: lead.customers }}
            />
          </div>
        ) : null}
      </div>
    </main>
  );
}
