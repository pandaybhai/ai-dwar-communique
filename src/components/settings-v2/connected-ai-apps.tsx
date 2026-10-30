import { useEffect, useState, type CSSProperties } from "react";
import { Bot, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { aidwar } from "@/integrations/aidwar/client";
import { useNewDesign } from "@/lib/new-design";
import { cn } from "@/lib/utils";
import { connectedAppsCopy, connectedOnText, lastUsedOnText } from "./copy";

/**
 * Batch 52: Settings > Connected AI apps. The AI assistants (Claude, ChatGPT,
 * Codex, Cursor…) this person allowed on /oauth/consent, from Supabase Auth's
 * own grant list (auth.oauth.listGrants), and Remove (auth.oauth.revokeGrant:
 * the app's sessions and refresh tokens end at once, and AiDwar MCP checks
 * the session on every call). The person's own grants, not a workspace
 * setting: nothing in AiDwar's tables is read or written.
 */

export type GrantView = {
  clientId: string;
  name: string;
  site: string | null;
  grantedAt: string;
  scopes: string[];
};

type RawGrant = {
  client?: { id?: string; name?: string; uri?: string };
  scopes?: string[];
  granted_at?: string;
};

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
    : connectedOnText(d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }));
}

function lastUsedText(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : lastUsedOnText(d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }));
}

/**
 * Batch 53: the same list on the AI assistants page, in Classic and Aiden
 * Workspace. `lastUsed` (client id -> time) comes from the page's server
 * read when 20261270 is applied; `intro` false leaves out the how-to line
 * (the page has its own Connect section).
 */
export function ConnectedAiApps({
  lastUsed,
  intro = true,
}: { lastUsed?: Record<string, string | null> | undefined; intro?: boolean } = {}) {
  const nd = useNewDesign();
  const copy = connectedAppsCopy(nd);
  const [grants, setGrants] = useState<GrantView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function load() {
    setError(null);
    setLoadFailed(false);
    const { data, error: e } = await oauthApi().listGrants();
    if (e) {
      setError(copy.loadFailed);
      setLoadFailed(true);
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
      setError(copy.removeFailed);
      return;
    }
    setGrants((g) => (g ?? []).filter((x) => x.clientId !== clientId));
  }

  return (
    <ConnectedAiAppsView
      grants={grants}
      error={error}
      confirming={confirming}
      removing={removing}
      onAsk={setConfirming}
      onRemove={remove}
      onRetry={loadFailed ? () => void load() : undefined}
      lastUsed={lastUsed}
      intro={intro}
      newDesign={nd}
    />
  );
}

export function ConnectedAiAppsView({
  grants,
  error = null,
  confirming = null,
  removing = null,
  onAsk,
  onRemove,
  onRetry,
  lastUsed,
  intro = true,
  newDesign = false,
}: {
  grants: GrantView[] | null;
  /** Batch 57: Aiden Workspace's words and look (the page passes useNewDesign()); Classic by default. */
  newDesign?: boolean;
  /** Batch 57, Aiden Workspace: "Try again" after a failed load (the same read). */
  onRetry?: (() => void) | undefined;
  lastUsed?: Record<string, string | null> | undefined;
  intro?: boolean;
  error?: string | null;
  confirming?: string | null;
  removing?: string | null;
  onAsk?: (clientId: string | null) => void;
  onRemove?: (clientId: string) => void;
}) {
  const nd = newDesign;
  const copy = connectedAppsCopy(nd);
  // Aiden Workspace: 44px targets on a phone (Classic is unchanged).
  const tap = nd ? "phone:min-h-11" : undefined;
  return (
    <div className="space-y-4">
      {intro ? (
        <p className="text-body text-muted-foreground">
          Add <span className="font-semibold text-foreground">https://aidwar.in/mcp</span> to
          Claude, ChatGPT, Codex or Cursor and sign in to let it read your workspace and draft
          campaigns and flows. Sending or switching on always asks you first.{" "}
          <a
            href="/developers#mcp"
            className="rounded font-semibold text-aiden-deep underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
          >
            How to connect
          </a>
        </p>
      ) : null}
      {error ? (
        nd ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : (
          <p className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground">
            {error}
          </p>
        )
      ) : null}
      {grants === null ? (
        <div className="space-y-3" aria-label={copy.loadingLabel}>
          <Skeleton className="h-16 w-full rounded-2xl" />
          <Skeleton className="h-16 w-full rounded-2xl" />
        </div>
      ) : grants.length === 0 ? (
        nd ? (
          onRetry ? null : (
            <EmptyState
              icon={Bot}
              title={copy.emptyTitle}
              description={copy.emptyBody}
              action={
                <Button asChild variant="outline" className="phone:min-h-11">
                  <a href={intro ? "/developers#mcp" : "#connect"}>{copy.emptyAction}</a>
                </Button>
              }
            />
          )
        ) : (
          <p className="rounded-2xl border border-border bg-card px-5 py-4 text-body text-muted-foreground">
            {copy.emptyTitle}
          </p>
        )
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {grants.map((g, i) => (
            <li
              key={g.clientId}
              className={cn(
                "flex flex-col gap-3 rounded-2xl border border-border bg-card px-5 py-4 sm:flex-row sm:items-center",
                nd && "nd-rise",
              )}
              style={nd ? ({ "--d": i } as CSSProperties) : undefined}
            >
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-foreground [overflow-wrap:anywhere]">{g.name}</p>
                <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {[g.site, connectedOn(g.grantedAt), lastUsedText(lastUsed?.[g.clientId])]
                    .filter(Boolean)
                    .join(", ")}
                </p>
              </div>
              {confirming === g.clientId ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-foreground">{copy.confirm}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={tap}
                    disabled={removing !== null}
                    onClick={() => onAsk?.(null)}
                  >
                    {copy.keep}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className={tap}
                    disabled={removing !== null}
                    onClick={() => onRemove?.(g.clientId)}
                  >
                    {removing === g.clientId ? (
                      <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />
                    ) : null}
                    {copy.remove}
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={tap}
                  onClick={() => onAsk?.(g.clientId)}
                >
                  {copy.ask}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
