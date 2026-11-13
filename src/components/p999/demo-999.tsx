import { useEffect, useMemo, useRef, useState } from "react";
import { DEMO_CHATS, demoBeats, type DemoChat } from "@/lib/page-999";
import { usePlaying, useReducedMotion } from "@/components/p999/p999-motion";
import { cn } from "@/lib/utils";

/**
 * Batch 80: the wow moment — a phone where a customer's message lands and
 * Aiden answers, typed with WhatsApp's own rhythm (typing…, ticks turning
 * blue once the customer has read it). Six example shops; the chips switch
 * between them and the active chip fills while its chat plays, then the next
 * one takes over. CSS + a few timers, no video and no library. Loops only
 * while on screen; reduced motion shows the whole chat, still.
 */

function Ticks({ read }: { read: boolean }) {
  return (
    <svg
      viewBox="0 0 16 11"
      className="p9-tick"
      data-read={read ? "true" : "false"}
      aria-hidden="true"
    >
      <path
        d="M11.07.65 4.98 7.1 2.4 4.47l-.98.97 3.57 3.6L12.04 1.6zM14.6.65 8.5 7.1l-.6-.6-.98.97 1.58 1.6L15.57 1.6z"
        fill="currentColor"
      />
    </svg>
  );
}

function clock(offsetMin: number): string {
  const base = 19 * 60 + 42 + offsetMin; // 7:42 pm and on
  const h = Math.floor(base / 60) % 24;
  const m = base % 60;
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${String(m).padStart(2, "0")} ${h >= 12 ? "pm" : "am"}`;
}

/** Plays one chat: how many lines are shown, and whether Aiden is typing. */
function useChatPlay(chat: DemoChat, run: boolean, onDone: () => void) {
  const reduce = useReducedMotion();
  const [show, setShow] = useState(chat.lines.length);
  const [typing, setTyping] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (reduce || !run) {
      setShow(chat.lines.length);
      setTyping(false);
      return;
    }
    setShow(0);
    setTyping(false);
    const timers = demoBeats(chat).map((b) =>
      setTimeout(() => {
        if (b.show === -1) {
          done.current();
          return;
        }
        setShow(b.show);
        setTyping(b.typing);
      }, b.at),
    );
    return () => timers.forEach(clearTimeout);
  }, [chat, run, reduce]);

  return { show, typing };
}

function Phone({ chat, show, typing }: { chat: DemoChat; show: number; typing: boolean }) {
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [show, typing]);
  const lines = chat.lines.slice(0, show);
  return (
    <div className="p9-phone w-full">
      <div className="p9-screen">
        <div className="p9-notch" aria-hidden="true" />
        <div className="relative z-[2] flex items-center gap-2.5 bg-[#1f2c34] px-3.5 pb-2.5 pt-8">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-[#3ee6a0] text-[12px] font-extrabold text-[#022c1b]">
            {chat.initials}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-[#e9edef]">{chat.shop}</p>
            <p className="text-[11.5px] text-[#8696a0]">
              {typing ? (
                <span className="text-[#3ee6a0]">Aiden is typing…</span>
              ) : (
                "Business account"
              )}
            </p>
          </div>
        </div>
        <div
          ref={list}
          className="relative z-[1] flex h-[calc(100%-76px)] flex-col gap-1.5 overflow-hidden px-3 pb-4 pt-3"
        >
          <p className="mx-auto mb-1 rounded-md bg-[#182229] px-2 py-1 text-[10.5px] font-medium text-[#8696a0]">
            Today
          </p>
          {lines.map((line, i) => {
            const readByCustomer =
              line.from === "aiden" &&
              chat.lines.slice(i + 1, show).some((l) => l.from === "customer");
            return (
              <div
                key={`${chat.key}-${i}`}
                className={cn("p9-bubble p9-pop", line.from === "customer" ? "p9-in" : "p9-out")}
              >
                {line.from === "aiden" && line.card ? (
                  <div className="mb-1.5 overflow-hidden rounded-lg bg-[#0b3d33]">
                    <div className="grid h-20 place-items-center bg-gradient-to-br from-[#1e3a8a] via-[#3b5bdb] to-[#93c5fd]">
                      <span className="h-12 w-9 rounded-t-[18px] rounded-b-md bg-[#dbeafe]/80 shadow-inner" />
                    </div>
                    <div className="px-2 py-1.5">
                      <p className="text-[12.5px] font-semibold">{line.card.title}</p>
                      <p className="text-[12px] text-[#3ee6a0]">{line.card.price}</p>
                    </div>
                  </div>
                ) : null}
                {line.from === "aiden" ? (
                  <p className="mb-0.5 text-[11px] font-bold text-[#3ee6a0]">Aiden</p>
                ) : null}
                <p>{line.text}</p>
                <p className="p9-meta">
                  {clock(i)}
                  {line.from === "aiden" ? <Ticks read={readByCustomer} /> : null}
                </p>
              </div>
            );
          })}
          {typing ? (
            <div className="p9-bubble p9-out p9-pop w-fit p-0" aria-hidden="true">
              <span className="p9-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function Demo999({ aidenLink }: { aidenLink: string | null }) {
  const { ref, play } = usePlaying<HTMLDivElement>();
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(0);
  const chat = DEMO_CHATS[index]!;
  const duration = useMemo(() => {
    const beats = demoBeats(chat);
    return beats[beats.length - 1]!.at;
  }, [chat]);
  const { show, typing } = useChatPlay(chat, play === "on", () =>
    setIndex((i) => (i + 1) % DEMO_CHATS.length),
  );
  const chips = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Keep the active chip in view in the row (no page scroll).
    const row = chips.current;
    const active = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (row && active && row.scrollWidth > row.clientWidth) {
      const left =
        active.getBoundingClientRect().left -
        row.getBoundingClientRect().left +
        row.scrollLeft -
        16;
      row.scrollTo({ left: Math.max(0, left), behavior: reduce ? "auto" : "smooth" });
    }
  }, [index, reduce]);

  return (
    <div ref={ref} data-play={play} className="w-full">
      <div
        ref={chips}
        role="group"
        aria-label="Pick a business"
        className="p9-chips -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-auto lg:max-w-[440px] lg:flex-wrap lg:justify-center lg:px-0"
      >
        {DEMO_CHATS.map((c, i) => (
          <button
            key={c.key}
            type="button"
            className="p9-chip"
            aria-pressed={i === index}
            onClick={() => setIndex(i)}
            style={{ ["--dur" as string]: `${duration}ms` }}
          >
            {c.label}
            {i === index ? (
              <span key={`${c.key}-fill-${index}`} className="p9-chip-fill" aria-hidden="true" />
            ) : null}
          </button>
        ))}
      </div>

      <div className="p9-stage relative mx-auto mt-6 w-full max-w-[300px]">
        <div
          aria-hidden="true"
          className="absolute -inset-10 -z-10 rounded-full bg-[radial-gradient(closest-side,rgba(62,230,160,0.35),transparent)] blur-2xl"
        />
        <div className="p9-phone-in">
          <div className="p9-float">
            <div aria-hidden="true">
              <Phone chat={chat} show={show} typing={typing} />
            </div>
          </div>
        </div>
        <div className="sr-only" aria-live="polite">
          Example chat for {chat.label}:{" "}
          {chat.lines
            .map((l) => `${l.from === "aiden" ? "Aiden" : "Customer"}: ${l.text}`)
            .join(" ")}
        </div>
      </div>

      <p className="mt-6 text-center text-[13px] text-white/60">
        Example chats. Your Aiden answers from your own prices and policies.
      </p>
      {aidenLink ? (
        <p className="mt-3 text-center">
          <a
            href={aidenLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-white/20 px-4 text-[14px] font-semibold text-white transition-colors hover:border-[var(--mint)] hover:text-[var(--mint)]"
          >
            Try Aiden yourself <span aria-hidden="true">→</span>
          </a>
        </p>
      ) : null}
    </div>
  );
}

export default Demo999;
