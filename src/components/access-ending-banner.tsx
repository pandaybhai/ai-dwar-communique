import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/whatsapp-client";
import { accessBanner } from "@/lib/renewals";

/**
 * Batch 82: the /199 paid trial's banner — shown when 5 days or fewer of the
 * 30-day access period are left (organizations.plan_period_ends_at), only
 * while the workspace's latest paid plan fee is that offer. "Talk to us"
 * opens WhatsApp with our team; there is no automatic charge and nothing is
 * locked. A failed read shows nothing.
 */
export function AccessEndingBanner({ organizationId }: { organizationId: string }) {
  const [state, setState] = useState<{ text: string; link: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    void callApi<{ ends_at: string | null; paid_trial: boolean; talk_link: string | null }>(
      "/api/app/access-period",
      { body: { organization_id: organizationId } },
    ).then(({ data }) => {
      if (!live || !data?.paid_trial) return;
      const banner = accessBanner(data.ends_at);
      setState(banner ? { text: banner.text, link: data.talk_link } : null);
    });
    return () => {
      live = false;
    };
  }, [organizationId]);
  if (!state) return null;
  return <AccessEndingBannerView text={state.text} talkLink={state.link} />;
}

/** The banner itself (also rendered by the tests and screenshots). */
export function AccessEndingBannerView({
  text,
  talkLink,
}: {
  text: string;
  talkLink: string | null;
}) {
  return (
    <div
      className="shrink-0 border-b border-warning-border bg-warning-soft px-4 py-2 text-sm text-foreground sm:px-6"
      data-testid="access-ending-banner"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">{text}</span>
        {talkLink ? (
          <Button asChild size="sm" className="rounded-full">
            <a href={talkLink} target="_blank" rel="noopener noreferrer">
              <MessageCircle className="mr-1.5 h-4 w-4" aria-hidden="true" /> Talk to us
            </a>
          </Button>
        ) : (
          <Button asChild size="sm" className="rounded-full">
            <Link to="/app/billing">Choose a plan</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
