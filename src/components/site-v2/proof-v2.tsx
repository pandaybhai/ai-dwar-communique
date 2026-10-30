import { BookOpen, Check, CheckCheck, Info } from "lucide-react";
import { AidenOrb } from "@/components/design-v2/aiden-orb";
import { WhatsAppBubble } from "@/components/design-v2/whatsapp-bubble";
import {
  AUDIENCES,
  MODES,
  useProductProof,
  useShownSteps,
  type Example,
  type ProofAudience,
  type ProofMode,
} from "@/components/marketing/product-proof";
import { cn } from "@/lib/utils";

/**
 * Batch 51: "Pick a question. See how it would be handled." in the new
 * design, for the new landing (new_site) only. The same walkthrough as the
 * current landing's ProductProof: its examples, modes, state and analytics
 * event (useProductProof, useShownSteps) and every word; only the look is
 * the new design's: porcelain, WhatsApp bubbles, Aiden's orb, the tokens.
 * The classic landing keeps ProductProof, unchanged.
 */

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden";

/** A bubble arriving: rises and fades in (in place at once with reduced motion). */
const step = (on: boolean) =>
  cn(
    "transition-[opacity,transform] duration-300 motion-reduce:transition-none",
    on ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
  );

const ORB: Record<ProofMode, "replying" | "draft" | "off"> = {
  replying: "replying",
  draft: "draft",
  off: "off",
};

export function ProductProofNew({
  audience,
  onAudienceChange,
}: {
  audience: ProofAudience;
  onAudienceChange: (audience: ProofAudience) => void;
}) {
  const { group, example, mode, setMode, setExampleId, engage } = useProductProof(audience);

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_1.05fr] lg:items-start lg:gap-12">
      <div className="min-w-0">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-aiden-soft px-3 py-1 text-[0.8125rem] font-semibold text-aiden-deep">
          <Info className="size-3.5" aria-hidden="true" /> Illustrative walkthrough
        </span>
        <h2 className="m-0 mt-4 max-w-2xl font-display text-[clamp(1.75rem,3.4vw,2.5rem)] font-extrabold leading-[1.05] tracking-[-0.025em]">
          Pick a question. See how it would be handled.
        </h2>
        <p className="m-0 mt-4 max-w-lg text-muted-foreground">
          These are written examples of the product&apos;s behaviour, not a recording of a live
          customer chat. On the right is an example of the controls available in AiDwar.
        </p>

        <div role="tablist" aria-label="Business type" className="mt-8 flex flex-wrap gap-2">
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
                "rounded-full border px-4 py-2 text-sm font-semibold transition-colors duration-200",
                FOCUS,
                a.id === audience
                  ? "border-transparent bg-ink text-ink-foreground"
                  : "border-line bg-surface text-muted-foreground hover:bg-bubble-in hover:text-foreground",
              )}
            >
              {a.label}
            </button>
          ))}
        </div>
        <p className="m-0 mt-3 text-sm text-muted-foreground">{group.blurb}</p>

        <ul className="m-0 mt-6 grid list-none gap-2 p-0">
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
                  "w-full rounded-[14px] border px-4 py-3 text-left text-[0.9375rem] transition-[background-color,border-color,box-shadow] duration-200",
                  FOCUS,
                  e.id === example.id
                    ? "border-aiden bg-surface font-semibold text-foreground shadow-md"
                    : "border-line bg-surface text-muted-foreground hover:border-aiden/40 hover:text-foreground",
                )}
              >
                &ldquo;{e.question}&rdquo;
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid min-w-0 gap-6">
        <ExampleChatNew example={example} mode={mode} />

        <div className="rounded-[20px] border border-line bg-surface p-6 shadow-md">
          <p className="m-0 font-display text-lg font-semibold">You stay in charge</p>
          <div
            role="group"
            aria-label="You stay in charge"
            className="mt-4 grid gap-1 rounded-[14px] bg-ground p-1 sm:grid-cols-3"
          >
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                aria-pressed={mode === m.id}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-[11px] px-3 py-2 text-sm font-semibold transition-[background-color,color,box-shadow] duration-200",
                  FOCUS,
                  mode === m.id
                    ? "bg-surface text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <m.icon className="size-4" aria-hidden="true" />
                {m.label}
              </button>
            ))}
          </div>
          <p className="m-0 mt-4 text-sm leading-relaxed text-muted-foreground">
            {MODES.find((m) => m.id === mode)!.body}
          </p>
          <div className="mt-5 grid gap-4 border-t border-line pt-5 sm:grid-cols-2">
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

/** The example chat as WhatsApp draws it: Aiden's orb on top, the bubbles on the porcelain wall. */
export function ExampleChatNew({ example, mode }: { example: Example; mode: ProofMode }) {
  const shown = useShownSteps(example, mode);
  const sent = mode === "replying";
  const heldBack = mode === "off";

  return (
    <figure className="m-0 overflow-hidden rounded-[24px] border border-line bg-surface shadow-lg">
      <figcaption className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <AidenOrb state={ORB[mode]} size={40} />
        <span className="min-w-0">
          <span className="block truncate font-semibold text-foreground">Customer chat</span>
          <span className="block text-sm text-aiden-deep">
            {heldBack ? "AI is off" : sent ? "AI is replying" : "AI is drafting for approval"}
          </span>
        </span>
      </figcaption>

      <div className="nd-wall flex min-h-[220px] flex-col justify-end gap-2 px-4 py-5">
        <WhatsAppBubble from="in" className={step(shown >= 1)}>
          {example.question}
        </WhatsAppBubble>
        <WhatsAppBubble
          from="out"
          className={step(shown >= 2)}
          meta={
            heldBack ? (
              <span>Not sent</span>
            ) : sent ? (
              <>
                <span>Sent</span>
                <CheckCheck className="h-3.5 w-3.5 text-aiden-deep" aria-hidden="true" />
              </>
            ) : (
              <>
                <span>Draft — waiting for approval</span>
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              </>
            )
          }
        >
          {heldBack ? "Waiting for your team — nothing was sent." : example.reply}
        </WhatsAppBubble>
      </div>

      <div className="flex items-start gap-2 border-t border-line px-5 py-4">
        <Info className="mt-0.5 size-4 shrink-0 text-aiden-deep" aria-hidden="true" />
        <p className="m-0 text-sm leading-relaxed text-muted-foreground">
          {example.basis}
          {example.asksOwner ? " It is designed to check with you before promising anything." : ""}
        </p>
      </div>
    </figure>
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
      <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-aiden-soft text-aiden-deep">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div>
        <p className="m-0 text-sm font-semibold">{title}</p>
        <p className="m-0 mt-0.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
