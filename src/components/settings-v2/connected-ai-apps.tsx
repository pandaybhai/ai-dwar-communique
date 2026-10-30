import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { aidwar } from "@/integrations/aidwar/client";

/**
 * Batch 52: Settings > Connected AI apps. The AI assistants (Claude, ChatGPT,
 * Codex, Cursor…) this person allowed on /oauth/consent, from Supabase Auth's
 * own grant list (auth.oauth.listGrants), and Remove (auth.oauth.revokeGrant:
 * the app's sessions and refresh tokens end at once, and AiDwar MCP checks
 * the session on every call). The person's own grants, not a workspace
 * setting: nothing in AiDwar's tables is read or written.
 */

export type GrantView = { clientId: string; name: string; site: string | null; grantedAt: string; scopes: string[] };

type RawGrant = { client?: { id?: string; name?: string; uri?: string }; scopes?: string[]; granted_at?: string };

export function grantViews(raw: unknown): GrantView[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawGrant[])
    .filter((g) => g.client?.id)
    .map((g) => {
      let site: string | null = null;
      try {
        site = g.client?.uri ? new URL(g.client.uri).host : null;
      } catch {
        site = null;
      }
      return {
        clientId: String(g.client!.id),
        name: (g.client?.name ?? "").trim() || "An AI app",
        site,
        grantedAt: String(g.granted_at ?? ""),
        scopes: Array.isArray(g.scopes) ? g.scopes : [],
      };
    })
    .sort((a, b) => (a.grantedAt < b.grantedAt ? 1 : -1));
}

type OAuthApi = {
  listGrants: () => Promise<{ data: unknown; error: { message: string } | null }>;
  revokeGrant: (o: { clientId: string }) => Promise<{ error: { message: string } | null }>;
};
const oauthApi = () => (aidwar.auth as unknown as { oauth: OAuthApi }).oauth;

function connectedOn(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : `Connected ${d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;
}

export function ConnectedAiApps() {
  const [grants, setGrants] = useState<GrantView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function load() {
    setError(null);
    const { data, error: e } = await oauthApi().listGrants();
    if (e) {
      setError("We couldn't load your connected apps. Please try again.");
      setGrants([]);
      return;
    }
    setGrants(grantViews(data));
  }
  useEffect(() => {
    void load();
  }, []);

  async function remove(clientId: string) {
    setRemoving(clientId);
    const { error: e } = await oauthApi().revokeGrant({ clientId });
    setRemoving(null);
    setConfirming(null);
    if (e) {
      setError("We couldn't remove that app. Please try again.");
      return;
    }
    setGrants((g) => (g ?? []).filter((x) => x.clientId !== clientId));
  }

  return <ConnectedAiAppsView grants={grants} error={error} confirming={confirming} removing={removing} onAsk={setConfirming} onRemove={remove} />;
}

export function ConnectedAiAppsView({
  grants,
  error = null,
  confirming = null,
  removing = null,
  onAsk,
  onRemove,
}: {
  grants: GrantView[] | null;
  error?: string | null;
  confirming?: string | null;
  removing?: string | null;
  onAsk?: (clientId: string | null) => void;
  onRemove?: (clientId: string) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-body text-muted-foreground">
        Add <span className="font-semibold text-foreground">https://aidwar.in/mcp</span> to Claude, ChatGPT, Codex or Cursor
        and sign in to let it read your workspace and draft campaigns and flows. Sending or switching on always asks you
        first.{" "}
        <a
          href="/developers#mcp"
          className="rounded font-semibold text-aiden-deep underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
        >
          How to connect
        </a>
      </p>
      {error ? <p className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground">{error}</p> : null}
      {grants === null ? (
        <div className="space-y-3" aria-label="Loading connected apps">
          <Skeleton className="h-16 w-full rounded-2xl" />
          <Skeleton className="h-16 w-full rounded-2xl" />
        </div>
      ) : grants.length === 0 ? (
        <p className="rounded-2xl border border-border bg-card px-5 py-4 text-body text-muted-foreground">
          No AI apps are connected to your AiDwar account.
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {grants.map((g) => (
            <li
              key={g.clientId}
              className="flex flex-col gap-3 rounded-2xl border border-border bg-card px-5 py-4 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-foreground [overflow-wrap:anywhere]">{g.name}</p>
                <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {[g.site, connectedOn(g.grantedAt)].filter(Boolean).join(", ")}
                </p>
              </div>
              {confirming === g.clientId ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-foreground">Remove its access?</span>
                  <Button type="button" variant="outline" size="sm" disabled={removing !== null} onClick={() => onAsk?.(null)}>
                    Keep
                  </Button>
                  <Button type="button" variant="destructive" size="sm" disabled={removing !== null} onClick={() => onRemove?.(g.clientId)}>
                    {removing === g.clientId ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : null}
                    Remove
                  </Button>
                </div>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => onAsk?.(g.clientId)}>
                  Remove access
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
