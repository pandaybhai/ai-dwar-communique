import { useEffect, useState } from "react";
import { BellRing, MessagesSquare, PenLine, X, Zap } from "lucide-react";
import { useOrg } from "@/lib/org-context";
import { TOUR_KEY, readStorage, writeStorage } from "@/lib/onboarding-client";

type Tip = { icon: typeof Zap; title: string; body: string };

/** The three tips, by the mode the owner just chose. */
export function tourTips(mode: "draft" | "replying" | null): Tip[] {
  return [
    {
      icon: MessagesSquare,
      title: "Every customer chat lands here",
      body: "Messages to your WhatsApp number appear in this list, newest first. Your whole team sees the same Inbox.",
    },
    mode === "replying"
      ? {
          icon: Zap,
          title: "Aiden answers on his own",
          body: "You'll see his replies in each chat. Type in any chat to step in — he steps back for that customer.",
        }
      : {
          icon: PenLine,
          title: "Aiden's draft waits for you",
          body: "Open a chat and his suggested reply is ready above the message box. Send it as it is, or change a word first.",
        },
    {
      icon: BellRing,
      title: "When he needs you, you'll know",
      body: "If a customer asks something he can't answer, the chat is marked for you and you get a WhatsApp message.",
    },
  ];
}

/**
 * Batch 40: shown once in the Inbox right after Go live (the journey sets
 * the flag), three short tips, dismissible at any point.
 */
export function InboxTour() {
  const { active } = useOrg();
  const orgId = active?.organization.id ?? null;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"draft" | "replying" | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const flag = orgId ? readStorage("local", TOUR_KEY(orgId)) : null;
    if (!flag?.startsWith("pending")) return;
    setMode(flag.endsWith(":replying") ? "replying" : "draft");
    setOpen(true);
  }, [orgId]);

  if (!open || !orgId) return null;
  const tips = tourTips(mode);
  const tip = tips[index]!;
  const Icon = tip.icon;
  const close = () => {
    writeStorage("local", TOUR_KEY(orgId), "done");
    setOpen(false);
  };

  return (
    <section
      aria-label="Getting started with the Inbox"
      className="ob-pop relative rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-card)] sm:p-6"
    >
      <button
        type="button"
        onClick={close}
        className="absolute right-3 top-3 rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Close the tips"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
      <div className="flex items-start gap-4 pr-8">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-accent text-accent-foreground">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div aria-live="polite">
          <p className="text-xs font-semibold text-primary-strong">
            Tip {index + 1} of {tips.length}
          </p>
          <h2 className="mt-1 text-lg font-bold tracking-tight">{tip.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{tip.body}</p>
        </div>
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <div className="flex gap-1.5" aria-hidden="true">
          {tips.map((_, i) => (
            <span key={i} className={`h-1.5 rounded-full transition-all ${i === index ? "w-6 bg-primary-strong" : "w-1.5 bg-border"}`} />
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={close} className="rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">
            Skip
          </button>
          <button
            type="button"
            onClick={() => (index + 1 < tips.length ? setIndex(index + 1) : close())}
            className="rounded-full bg-primary-strong px-4 py-2 text-sm font-semibold text-primary-strong-foreground"
          >
            {index + 1 < tips.length ? "Next" : "Got it"}
          </button>
        </div>
      </div>
    </section>
  );
}
