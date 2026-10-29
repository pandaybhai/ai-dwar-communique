import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  FileText,
  Loader2,
  Package,
  SendHorizontal,
  Sparkles,
  StickyNote,
} from "lucide-react";
import {
  CustomerBubble,
  MessageBubble,
  PhoneFrame,
  TypingBubble,
  previewModel,
} from "@/components/developers/whatsapp-phone";
import { AidenHandoff } from "@/components/aiden-handoff";
import { PrimaryAction, StepHeading } from "@/components/onboarding/journey-shell";
import {
  journeyApi,
  type JourneyStateReply,
  type LearnedItem,
  type TestReply,
} from "@/lib/onboarding-client";
import { callApi } from "@/lib/whatsapp-client";

type ChatTurn = { id: number; from: "customer" | "aiden" | "note"; text: string };

const READING = ["pending", "queued", "syncing"];

/**
 * Step 3 — Meet Aiden. Left: what he has learned from the business's own
 * site, arriving item by item while he reads. Right: the business's WhatsApp
 * chat as a customer sees it — the owner types a customer's question and
 * watches Aiden answer from their own material. Every answer is Aiden's own
 * (a real test run that sends nothing); when he has none, the chat says so
 * as a note, never as words put in his mouth.
 */
export function StepAiden({
  organizationId,
  business,
  logoUrl,
  host,
  onContinue,
}: {
  organizationId: string;
  business: string;
  logoUrl: string | null;
  host: string | null;
  onContinue: () => void;
}) {
  const [items, setItems] = useState<LearnedItem[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [handoff, setHandoff] = useState<{ code: string; wa_link: string } | null>(null);
  const [showHandoff, setShowHandoff] = useState(false);
  const seen = useRef(new Set<string>());
  const [fresh, setFresh] = useState<Record<string, number>>({});
  const nextId = useRef(1);
  const end = useRef<HTMLDivElement | null>(null);

  // What he has learned, polled while he reads, then once more at the end.
  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;
    const tick = async () => {
      const res = await journeyApi<JourneyStateReply>({
        action: "state",
        organization_id: organizationId,
        learned: true,
      });
      if (stopped || !res.data) return;
      const list = res.data.learned ?? [];
      const arriving: Record<string, number> = {};
      let n = 0;
      for (const item of list) {
        if (!seen.current.has(item.id)) {
          seen.current.add(item.id);
          arriving[item.id] = n++;
        }
      }
      if (n > 0) setFresh(arriving);
      setItems(list);
      const s = res.data.state.website?.status ?? null;
      setStatus(s);
      if (s && READING.includes(s)) timer = window.setTimeout(() => void tick(), 2500);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [organizationId]);

  // The optional "on your own phone" chat with Aiden (the original WhatsApp setup).
  useEffect(() => {
    let live = true;
    void callApi<{ code: string; wa_link: string }>("/api/onboarding/start", {
      body: { organization_id: organizationId },
    }).then((res) => {
      if (live && res.data?.wa_link) setHandoff(res.data);
    });
    return () => {
      live = false;
    };
  }, [organizationId]);

  // Keep the newest message in view inside the phone (never scrolls the page).
  useEffect(() => {
    const box = end.current?.closest(".wa-wall") as HTMLElement | null;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turns, asking]);

  const products = items.filter((i) => i.kind === "product");
  const suggestions = useMemo(() => {
    const out = ["What do you offer?"];
    const first = products[0];
    if (first)
      out.push(
        `How much is ${first.title.length > 26 ? `${first.title.slice(0, 24).trimEnd()}…` : first.title}?`,
      );
    out.push("How can I reach you?");
    return out;
  }, [products]);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || asking) return;
    const history = turns
      .filter((t) => t.from !== "note")
      .map((t) => ({
        role: t.from === "customer" ? ("user" as const) : ("assistant" as const),
        content: t.text,
      }));
    setTurns((prev) => [...prev, { id: nextId.current++, from: "customer", text }]);
    setDraft("");
    setAsking(true);
    const res = await journeyApi<TestReply>({
      action: "test",
      organization_id: organizationId,
      question: text,
      history,
    });
    setAsking(false);
    if (res.data?.answered && res.data.answer) {
      setAnswered(true);
      setTurns((prev) => [
        ...prev,
        { id: nextId.current++, from: "aiden", text: res.data!.answer! },
      ]);
    } else {
      setTurns((prev) => [
        ...prev,
        {
          id: nextId.current++,
          from: "note",
          text:
            res.error ??
            "Aiden has no answer for that yet. With real customers he asks you, and remembers what you say.",
        },
      ]);
    }
  }

  const reading = status !== null && READING.includes(status);
  const avatar = logoUrl?.startsWith("https://") ? (
    <img src={logoUrl} alt="" className="h-8 w-8 rounded-full bg-white object-contain p-0.5" />
  ) : (
    <span className="grid h-8 w-8 place-items-center rounded-full bg-white/90 text-[13px] font-bold text-[#008069]">
      {(business.charAt(0) || "A").toUpperCase()}
    </span>
  );

  return (
    <div>
      <StepHeading
        eyebrow="Meet Aiden"
        title={
          reading ? (
            <>Aiden is reading {host ?? "your site"} now.</>
          ) : (
            <>Aiden knows {business}. Try him.</>
          )
        }
        lead="Ask what a customer would ask. He answers from what he learned — nothing is sent to anyone."
      />

      <div className="mt-8 grid gap-6 lg:mt-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-10">
        {/* What he learned */}
        <section
          aria-labelledby="ob-learned"
          className="ob-rise min-w-0 self-start rounded-3xl border border-border bg-card p-5 sm:p-6"
          style={{ "--ob-delay": "80ms" } as React.CSSProperties}
        >
          <div className="flex items-center justify-between gap-3">
            <h2 id="ob-learned" className="text-base font-semibold">
              What Aiden learned{host ? <> from {host.replace(/^www\./, "")}</> : null}
            </h2>
            <span
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
              aria-live="polite"
            >
              {reading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              )}
              {items.length} {items.length === 1 ? "thing" : "things"}
              {reading ? " so far" : ""}
            </span>
          </div>
          {items.length === 0 ? (
            <div className="mt-5 space-y-3" aria-hidden={reading ? "true" : undefined}>
              {reading ? (
                [0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-11 animate-pulse rounded-xl bg-muted"
                    style={{ animationDelay: `${i * 120}ms` }}
                  />
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  {status === "error"
                    ? "He couldn't read that site. Ask him anyway, or add your answers later under AI employee."
                    : "Nothing yet — he works from what you told him."}
                </p>
              )}
            </div>
          ) : (
            <ul className="mt-5 max-h-56 space-y-2 overflow-y-auto pr-1 lg:max-h-[30rem]">
              {items.map((item) => {
                const order = fresh[item.id];
                const Icon =
                  item.kind === "product" ? Package : item.kind === "page" ? FileText : StickyNote;
                return (
                  <li
                    key={item.id}
                    className={`flex items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-2.5 ${order !== undefined ? "ob-rise" : ""}`}
                    style={
                      order !== undefined
                        ? ({ "--ob-delay": `${Math.min(order, 12) * 90}ms` } as React.CSSProperties)
                        : undefined
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                    {item.detail ? (
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {item.detail}
                      </span>
                    ) : null}
                    <span className="sr-only">
                      {item.kind === "product" ? "product" : item.kind === "page" ? "page" : "note"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* The customer's view */}
        <section
          aria-label={`Try Aiden as a customer of ${business}`}
          className="ob-rise flex flex-col items-center"
          style={{ "--ob-delay": "160ms" } as React.CSSProperties}
        >
          <PhoneFrame
            business={business}
            label={`${business}'s WhatsApp chat, as a customer sees it`}
            avatar={avatar}
            live
            composer={
              <form
                className="flex items-center gap-2 bg-[var(--wa-wall)] px-2 pb-4 pt-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  void ask(draft);
                }}
              >
                <label htmlFor="ob-ask" className="sr-only">
                  A customer's question
                </label>
                <input
                  id="ob-ask"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Ask like a customer…"
                  className="h-9 min-w-0 flex-1 rounded-full bg-[var(--wa-bubble)] px-4 text-[14px] text-[var(--wa-text)] placeholder:text-[var(--wa-meta)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00a884]"
                  autoComplete="off"
                  maxLength={500}
                />
                <button
                  type="submit"
                  disabled={!draft.trim() || asking}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#00796b] text-white disabled:opacity-60"
                  aria-label="Send"
                >
                  <SendHorizontal className="h-4 w-4" aria-hidden="true" />
                </button>
              </form>
            }
          >
            <>
              {turns.map((t) =>
                t.from === "customer" ? (
                  <div key={t.id} className="ob-rise">
                    <CustomerBubble text={t.text} />
                  </div>
                ) : t.from === "aiden" ? (
                  <div key={t.id} className="ob-rise">
                    <MessageBubble
                      model={previewModel({ kind: "text", text: t.text })}
                      status={null}
                    />
                  </div>
                ) : (
                  <p
                    key={t.id}
                    className="mx-auto max-w-[90%] rounded-md bg-warning-soft px-3 py-1.5 text-center text-[12.5px] text-warning-soft-foreground"
                  >
                    {t.text}
                  </p>
                ),
              )}
              {asking ? <TypingBubble label="Aiden is typing" /> : null}
              <div ref={end} aria-hidden="true" />
            </>
          </PhoneFrame>
          <div
            className="mt-4 flex max-w-[300px] flex-wrap justify-center gap-2"
            aria-label="Questions to try"
          >
            {suggestions.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => void ask(q)}
                disabled={asking}
                className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center">
        <PrimaryAction type="button" onClick={onContinue}>
          {answered ? "He's good — go live" : "Skip the test"} <ArrowRight aria-hidden="true" />
        </PrimaryAction>
        {handoff ? (
          <button
            type="button"
            onClick={() => setShowHandoff((v) => !v)}
            aria-expanded={showHandoff}
            className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Or chat with Aiden from your own phone
          </button>
        ) : null}
      </div>
      {handoff && showHandoff ? (
        <div className="ob-rise mt-6 max-w-2xl rounded-3xl border border-border bg-card p-5 sm:p-6">
          <p className="mb-4 text-sm text-muted-foreground">
            Message Aiden on WhatsApp with this code and he'll talk to you as your employee — send
            him photos, files or facts and he'll learn them.
          </p>
          <AidenHandoff code={handoff.code} waLink={handoff.wa_link} compact />
        </div>
      ) : null}
    </div>
  );
}
