import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { aidwar } from "@/integrations/aidwar/client";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";
import { MCP_URL } from "@/lib/mcp-connect";
import { STARTER_PROMPTS } from "@/lib/mcp-prompts";
import { CopyText, focusRing } from "./parts";

/**
 * Batch 53: "Connect your AI assistant" on Home, in Classic and Aiden
 * Workspace. For people with mcp.use while AI assistants are on, until they
 * dismiss it (remembered for this person on this device) or connect an app
 * (Supabase Auth lists a grant). The URL to copy, two starter prompts and a
 * link to the AI assistants page.
 */

const dismissKey = (userId: string) => `aidwar.ai_assistants_card.${userId}`;

export function readDismissed(userId: string | null): boolean {
  if (!userId || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(dismissKey(userId)) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(userId: string) {
  try {
    window.localStorage.setItem(dismissKey(userId), "1");
  } catch {
    // Private mode: the card comes back next visit.
  }
}

type OAuthApi = { listGrants: () => Promise<{ data: unknown; error: { message: string } | null }> };

export function ConnectAssistantCard({ className = "mb-6" }: { className?: string }) {
  const org = useOrg();
  const { can, loading } = usePermissions();
  const userId = org.profile?.id ?? null;
  const [dismissed, setDismissed] = useState(() => readDismissed(userId));
  const [connected, setConnected] = useState<boolean | null>(null);
  const eligible = !loading && can("mcp.use") && !org.flagsLoading && org.isFeatureEnabled("mcp_access");

  useEffect(() => {
    setDismissed(readDismissed(userId));
  }, [userId]);

  useEffect(() => {
    if (!eligible || dismissed) return;
    let cancelled = false;
    const api = (aidwar.auth as unknown as { oauth?: OAuthApi }).oauth;
    if (!api?.listGrants) {
      setConnected(false);
      return;
    }
    void api
      .listGrants()
      .then(({ data, error }) => {
        if (!cancelled) setConnected(!error && Array.isArray(data) && data.length > 0);
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eligible, dismissed]);

  if (!eligible || dismissed || connected !== false || !userId) return null;
  return (
    <ConnectAssistantCardView
      className={className}
      onDismiss={() => {
        writeDismissed(userId);
        setDismissed(true);
      }}
    />
  );
}

export function ConnectAssistantCardView({ onDismiss, className = "mb-6" }: { onDismiss?: () => void; className?: string }) {
  return (
    <section
      aria-labelledby="connect-ai-title"
      className={`relative space-y-3 rounded-2xl border border-border bg-card p-5 pr-12 sm:p-6 sm:pr-14 ${className}`}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onDismiss}
        aria-label="Dismiss: Connect your AI assistant"
        className={`absolute right-2 top-2 ${focusRing}`}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </Button>
      <div className="space-y-1">
        <h2 id="connect-ai-title" className="text-lg font-semibold text-foreground">
          Connect your AI assistant
        </h2>
        <p className="text-body text-muted-foreground">
          Add AiDwar to Claude, ChatGPT, Codex or Cursor and ask about your numbers or have it draft a campaign. Nothing
          is sent until you confirm.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <code className="min-w-0 font-mono text-[0.9375rem] font-semibold text-foreground [overflow-wrap:anywhere]">
          {MCP_URL}
        </code>
        <CopyText value={MCP_URL} label="Copy the server URL" className={focusRing} />
      </div>
      <ul className="m-0 grid list-none gap-1.5 p-0 text-body text-foreground sm:grid-cols-2">
        {STARTER_PROMPTS.map((p) => (
          <li key={p} className="rounded-xl bg-muted px-3 py-2">
            “{p}”
          </li>
        ))}
      </ul>
      <Link
        to="/app/ai-assistants"
        className={`inline-flex rounded font-semibold text-primary underline-offset-4 hover:underline ${focusRing}`}
      >
        How to connect, and more to ask
      </Link>
    </section>
  );
}
