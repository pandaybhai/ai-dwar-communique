import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { callApi } from "@/lib/whatsapp-client";

/**
 * Batch 75: the first thing a new workspace sees — a big green "Talk to Aiden
 * on WhatsApp →" that opens WhatsApp with the setup code already typed (the
 * same wa.me link and AD code /api/onboarding/start has always returned;
 * the AD-code flow itself is unchanged). The owner starts the chat, so it is
 * free. Shown only while that step is genuinely open ("card" mode answers
 * show_setup false once Aiden is set up), on phones and desktops alike.
 */
export function TalkToAidenBanner({ organizationId }: { organizationId: string }) {
  const [handoff, setHandoff] = useState<{ code: string; wa_link: string } | null>(null);
  useEffect(() => {
    let live = true;
    setHandoff(null);
    void callApi<{ code?: string; wa_link?: string; show_setup?: boolean }>(
      "/api/onboarding/start",
      {
        body: { organization_id: organizationId, mode: "card" },
      },
    ).then((res) => {
      if (live && res.data?.show_setup && res.data.code && res.data.wa_link) {
        setHandoff({ code: res.data.code, wa_link: res.data.wa_link });
      }
    });
    return () => {
      live = false;
    };
  }, [organizationId]);
  if (!handoff) return null;
  return <TalkToAidenCard code={handoff.code} waLink={handoff.wa_link} />;
}

/** The card itself (pure, so it can be rendered on its own). */
export function TalkToAidenCard({ code, waLink }: { code: string; waLink: string }) {
  return (
    <section
      aria-labelledby="talk-to-aiden"
      data-testid="talk-to-aiden"
      className="mb-6 rounded-3xl border border-success-border bg-success-soft p-5 sm:p-6"
    >
      <h2 id="talk-to-aiden" className="text-lg font-bold text-foreground sm:text-xl">
        Set up AiDwar in a WhatsApp chat with Aiden
      </h2>
      <p className="mt-1 text-sm text-muted-foreground sm:text-base">
        Aiden learns your business from you in a few messages. It&apos;s free — you start the chat.
      </p>
      <a
        href={waLink}
        target="_blank"
        rel="noreferrer"
        className="mt-4 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-success px-6 text-lg font-bold text-success-foreground shadow-[0_14px_34px_-14px_var(--success)] transition hover:bg-success/90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-success/30 sm:w-auto"
      >
        <MessageCircle className="h-5 w-5" aria-hidden="true" />
        Talk to Aiden on WhatsApp →
      </a>
      <p className="mt-3 text-xs text-muted-foreground">
        Opens WhatsApp with your code{" "}
        <span className="font-mono font-semibold text-foreground">{code}</span> ready to send.
      </p>
    </section>
  );
}
