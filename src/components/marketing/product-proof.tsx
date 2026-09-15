import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Check, CheckCheck, Info, PauseCircle, PencilLine, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { trackMarketing } from "@/lib/marketing-analytics";

/**
 * Illustrative walkthrough of the product surface.
 *
 * The conversations below are written examples, not recordings of a live
 * AiDwar run — they are labelled as such on the page. The owner controls shown
 * (Off / Draft only / Replying, knowledge, work history) mirror the real
 * controls in the workspace.
 */

export type { Example };

export type ProofAudience = "retail" | "services" | "growing";

type Example = {
  id: string;
  question: string;
  reply: string;
  /** What the product did behind the reply. */
  basis: string;
  /** True when the AI stops and asks the owner instead of answering. */
  asksOwner?: boolean;
};

export const AUDIENCES: Array<{
  id: ProofAudience;
  label: string;
  blurb: string;
  examples: Example[];
}> = [
  {
    id: "retail",
    label: "Retail & D2C",
    blurb: "Catalogue questions answered from your own product pages.",
    examples: [
      {
        id: "stock",
        question: "Do you have this kurta in medium?",
        reply:
          "Yes — the cotton kurta is listed in size M on our store page. Would you like the link to order?",
        basis: "Drawn from your product page, which the AI employee has read.",
      },
      {
        id: "price",
        question: "Bulk order pe kitna discount milega?",
        reply:
          "I don't have a bulk price written down, so I won't guess. I've asked the owner and will come back to you.",
        basis: "No bulk price in its knowledge, so it is designed to ask you rather than state a figure.",
        asksOwner: true,
      },
      {
        id: "delivery",
        question: "Do you deliver to Nagpur?",
        reply:
          "Our delivery page lists all-India shipping, and Nagpur is covered. Standard orders usually go out the next working day.",
        basis: "Answered from your delivery policy page.",
      },
    ],
  },
  {
    id: "services",
    label: "Services & appointments",
    blurb: "Enquiries qualified and passed to a person at the right moment.",
    examples: [
      {
        id: "slot",
        question: "Saturday ko appointment mil jayega?",
        reply:
          "I can take your details now and a team member will confirm the Saturday slot with you. May I have your name and preferred time?",
        basis: "Collects what your team needs before a human takes over.",
      },
      {
        id: "cost",
        question: "What does the consultation cost?",
        reply: "The consultation is listed at ₹800 on our services page. Shall I note your details down?",
        basis: "Price drawn from your own services page.",
      },
      {
        id: "handover",
        question: "I want to speak to someone right now.",
        reply: "Of course — I'm bringing a person in. They'll pick this chat up here shortly.",
        basis: "Marks the chat as 'Needs you' in the shared inbox with the full history.",
        asksOwner: true,
      },
    ],
  },
  {
    id: "growing",
    label: "Growing teams",
    blurb: "One shared inbox, clear ownership, and approval before anything goes out.",
    examples: [
      {
        id: "draft",
        question: "Is the Diwali offer still on?",
        reply:
          "Draft ready for your approval: \"The Diwali offer runs till Sunday — shall I send you the details?\"",
        basis: "In Draft only mode, replies wait for someone on your team to approve them.",
        asksOwner: true,
      },
      {
        id: "assign",
        question: "My order hasn't arrived yet.",
        reply:
          "I'm sorry about that. I've passed this to the team with your order details so someone can check it properly.",
        basis: "Handed to a teammate in the shared inbox, with the conversation attached.",
        asksOwner: true,
      },
      {
        id: "followup",
        question: "Send me the details later.",
        reply: "Noted — I'll follow up with you about this and keep it in one thread.",
        basis: "Logged as a follow-up you can see in the work history.",
      },
    ],
  },
];

const MODES = [
  {
    id: "off",
    label: "Off",
    icon: PauseCircle,
    body: "The AI employee stays quiet. Messages wait for your team, as they did before AiDwar.",
  },
  {
    id: "draft",
    label: "Draft only",
    icon: PencilLine,
    body: "It writes the reply and stops. Someone reads it and presses send. A good first week.",
  },
  {
    id: "replying",
    label: "Replying",
    icon: Send,
    body: "It answers from what it knows, and is designed to bring you in when it is not sure.",
  },
] as const;

export function ProductProof({
  audience,
  onAudienceChange,
}: {
  audience: ProofAudience;
  onAudienceChange: (audience: ProofAudience) => void;
}) {
  const group = useMemo(
    () => AUDIENCES.find((a) => a.id === audience) ?? AUDIENCES[0]!,
    [audience],
  );
  const [exampleId, setExampleId] = useState(group.examples[0]!.id);
  const [mode, setMode] = useState<(typeof MODES)[number]["id"]>("replying");
  const engaged = useRef(false);

  useEffect(() => {
    setExampleId(group.examples[0]!.id);
  }, [group]);

  const example = group.examples.find((e) => e.id === exampleId) ?? group.examples[0]!;

  function engage(props: Record<string, string>) {
    if (!engaged.current) {
      engaged.current = true;
      trackMarketing("proof_engaged", props);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_1.05fr] lg:items-start lg:gap-12">
      <div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-3 py-1 text-[11px] font-medium text-muted-foreground">
          <Info className="size-3" /> Illustrative walkthrough
        </span>
        <h2 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">
          Pick a question. See how it would be handled.
        </h2>
        <p className="mt-4 max-w-lg text-muted-foreground">
          These are written examples of the product&apos;s behaviour, not a recording of a live
          customer chat. On the right is an example of the controls available in AiDwar.
        </p>

        <div
          role="tablist"
          aria-label="Business type"
          className="mt-8 flex flex-wrap gap-2"
        >
          {AUDIENCES.map((a) => (
            <button
              key={a.id}
              role="tab"
              type="button"
              aria-selected={a.id === audience}
              onClick={() => {
                onAudienceChange(a.id);
                engage({ example: a.id, business_type: a.id });
              }}
              className={cn(
                "rounded-full border px-4 py-2 text-sm transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                a.id === audience
                  ? "border-primary bg-primary/10 font-medium text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
              )}
            >
              {a.label}
            </button>
          ))}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{group.blurb}</p>

        <ul className="mt-6 grid gap-2">
          {group.examples.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => {
                  setExampleId(e.id);
                  engage({ example: e.id, business_type: group.id });
                }}
                aria-pressed={e.id === example.id}
                className={cn(
                  "w-full rounded-2xl border px-4 py-3 text-left text-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 motion-reduce:transition-none",
                  e.id === example.id
                    ? "border-primary/40 bg-primary/5 text-foreground shadow-[var(--shadow-card)]"
                    : "border-border bg-card text-muted-foreground hover:border-primary/30 hover:text-foreground",
                )}
              >
                &ldquo;{e.question}&rdquo;
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid gap-6">
        <ExampleChat example={example} mode={mode} />

        <div className="rounded-3xl border border-border bg-card p-6">
          <p className="text-sm font-semibold">You stay in charge</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                aria-pressed={mode === m.id}
                className={cn(
                  "flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  mode === m.id
                    ? "border-primary bg-primary/10 font-medium text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                <m.icon className="size-4" />
                {m.label}
              </button>
            ))}
          </div>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            {MODES.find((m) => m.id === mode)!.body}
          </p>
          <div className="mt-5 grid gap-3 border-t border-border pt-5 sm:grid-cols-2">
            <Control
              icon={BookOpen}
              title="What it knows"
              body="Your website, catalogue and the answers you teach it. You can read and change all of it."
            />
            <Control
              icon={Check}
              title="What it did"
              body="Every reply, draft and handover is written into a work history you can look through."
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ExampleChat({
  example,
  mode,
}: {
  example: Example;
  mode: "off" | "draft" | "replying";
}) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setShown(2);
      return;
    }
    setShown(0);
    const a = setTimeout(() => setShown(1), 180);
    const b = setTimeout(() => setShown(2), 900);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [example, mode]);

  const sent = mode === "replying";
  const heldBack = mode === "off";

  return (
    <div className="overflow-hidden rounded-3xl border border-border bg-card shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-3 bg-gradient-to-r from-primary to-teal-500 px-5 py-4 text-primary-foreground">
        <div className="flex size-9 items-center justify-center rounded-full bg-primary-foreground/20 text-sm font-bold">
          AD
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">Customer chat</p>
          <p className="text-[11px] opacity-90">
            {heldBack ? "AI is off" : sent ? "AI is replying" : "AI is drafting for approval"}
          </p>
        </div>
      </div>

      <div className="grid gap-2 bg-secondary/50 px-4 py-5">
        <div
          className={cn(
            "flex justify-start transition-all duration-300 motion-reduce:transition-none",
            shown >= 1 ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
          )}
        >
          <p className="max-w-[85%] rounded-2xl rounded-bl-md bg-card px-3.5 py-2.5 text-[13px] leading-relaxed shadow-sm">
            {example.question}
          </p>
        </div>

        <div
          className={cn(
            "flex justify-end transition-all duration-300 motion-reduce:transition-none",
            shown >= 2 ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
          )}
        >
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/15 px-3.5 py-2.5 text-[13px] leading-relaxed shadow-sm">
            <p>{heldBack ? "Waiting for your team — nothing was sent." : example.reply}</p>
            <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
              {heldBack ? (
                <span>Not sent</span>
              ) : sent ? (
                <>
                  <span>Sent</span>
                  <CheckCheck className="size-3 text-primary" />
                </>
              ) : (
                <>
                  <span>Draft — waiting for approval</span>
                  <Check className="size-3" />
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-2 border-t border-border bg-card px-5 py-4">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {example.basis}
          {example.asksOwner ? " It is designed to check with you before promising anything." : ""}
        </p>
      </div>
    </div>
  );
}

function Control({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof BookOpen;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4" />
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
