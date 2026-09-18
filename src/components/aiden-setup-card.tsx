import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { AidenHandoff } from "@/components/aiden-handoff";
import { callApi } from "@/lib/whatsapp-client";

type Handoff = { code: string; wa_link: string; show_setup?: boolean };

/**
 * Owners who closed the sign-up screen before saying hello lose their code.
 * This puts it back in front of them until the step is actually done — there
 * is no dismiss, it disappears by finishing.
 */
export function AidenSetupCard({ organizationId }: { organizationId: string | null }) {
  const [handoff, setHandoff] = useState<Handoff | null>(null);

  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    setHandoff(null);
    callApi<Handoff>("/api/onboarding/start", {
      body: { organization_id: organizationId, mode: "card" },
    }).then((res) => {
      if (cancelled) return;
      if (res.data?.show_setup && res.data.code && res.data.wa_link) setHandoff(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  if (!handoff) return null;

  return (
    <div className="mb-6 rounded-2xl border border-primary/20 bg-primary/5 p-5 sm:p-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <MessageCircle className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-lg font-bold tracking-tight text-foreground">
            Aiden isn't set up yet
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Message him with your code and he'll read your website.
          </p>
        </div>
      </div>
      <div className="mt-5">
        <AidenHandoff code={handoff.code} waLink={handoff.wa_link} compact />
      </div>
    </div>
  );
}
