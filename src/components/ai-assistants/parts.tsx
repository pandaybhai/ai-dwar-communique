import { useState, type CSSProperties } from "react";
import { Check, Copy, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CONNECT_CLIENTS, MCP_SAFETY, MCP_URL, OTHER_CLIENT } from "@/lib/mcp-connect";
import { PROMPT_GROUPS } from "@/lib/mcp-prompts";
import {
  ACTION_WORDS,
  type AssistantApp,
  type AssistantEvent,
  type AssistantsOverview,
} from "@/lib/mcp-workspace";
import { cn } from "@/lib/utils";
import { ASSISTANTS_COPY, type AssistantsCopy } from "./copy";

/**
 * Batch 53: the AI assistants page's sections, as plain views (no data
 * fetching) so the in-app page — Classic and Aiden Workspace alike, through
 * the shared tokens — the public /ai-assistants page and the tests render the
 * same thing. Every connect step and prompt comes from mcp-connect.ts and
 * mcp-prompts.ts; nothing is written twice.
 */

export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function CopyText({
  value,
  label,
  className,
  showText = true,
}: {
  value: string;
  label: string;
  className?: string;
  showText?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void copy()}
      aria-label={copied ? `${label}: copied` : label}
      className={cn("shrink-0", className)}
    >
      {copied ? (
        <Check className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
      {showText ? (copied ? "Copied" : "Copy") : null}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </Button>
  );
}

export function SectionCard({
  id,
  title,
  blurb,
  children,
  className,
  rise,
}: {
  id: string;
  title: string;
  blurb?: string;
  children: React.ReactNode;
  className?: string;
  /** Batch 57, Aiden Workspace only: arrive in turn (nd-rise, n × 70ms). */
  rise?: number | undefined;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      id={id}
      // Hallmark floor: no card inside a card — a section is a divider and a
      // heading; its rows are the cards.
      className={cn(
        "scroll-mt-24 space-y-4 border-t border-border pt-6 first:border-t-0 first:pt-0",
        rise !== undefined && "nd-rise",
        className,
      )}
      style={rise !== undefined ? ({ "--d": rise } as CSSProperties) : undefined}
    >
      <div className="space-y-1">
        <h2 id={`${id}-title`} className="text-lg font-semibold text-foreground">
          {title}
        </h2>
        {blurb ? <p className="text-body text-muted-foreground">{blurb}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function ServerUrl() {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <span className="text-sm font-medium text-muted-foreground">Server URL</span>
      <code className="min-w-0 flex-1 font-mono text-[0.9375rem] font-semibold text-foreground [overflow-wrap:anywhere]">
        {MCP_URL}
      </code>
      <CopyText value={MCP_URL} label="Copy the server URL" className={focusRing} />
    </div>
  );
}

const TABS = [
  ...CONNECT_CLIENTS.map((c) => ({ key: c.key as string, tab: c.name.split(" (")[0]!, client: c })),
  {
    key: OTHER_CLIENT.key as string,
    tab: OTHER_CLIENT.name,
    client: { ...OTHER_CLIENT, code: undefined, source: null as string | null },
  },
];

/** Connect: the URL and the steps for each app, from mcp-connect.ts (the same words as /developers#mcp). */
export function ConnectSteps({ defaultTab = "claude" }: { defaultTab?: string }) {
  return (
    <div className="space-y-4">
      <ServerUrl />
      <Tabs defaultValue={defaultTab}>
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className={focusRing}>
              {t.tab}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((t) => (
          <TabsContent key={t.key} value={t.key} className="space-y-3 pt-2">
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">Who can: </span>
              {t.client.availability}
            </p>
            <ol className="m-0 list-decimal space-y-1.5 pl-5 text-body text-foreground">
              {t.client.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {t.client.code ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-muted-foreground">
                    {t.client.code.label}
                  </span>
                  <CopyText
                    value={t.client.code.text}
                    label={`Copy ${t.client.code.label}`}
                    className={focusRing}
                  />
                </div>
                <pre className="overflow-x-auto rounded-xl bg-muted px-4 py-3 font-mono text-sm text-foreground">
                  {t.client.code.text}
                </pre>
              </div>
            ) : null}
            {t.client.source ? (
              <p className="text-sm text-muted-foreground">
                Steps from{" "}
                <a
                  href={t.client.source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "rounded font-medium text-primary underline-offset-4 hover:underline",
                    focusRing,
                  )}
                >
                  {t.tab}'s documentation
                </a>
                .
              </p>
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

/** The prompt library, grouped, each with Copy. */
export function PromptLibrary({ headingLevel = 3 }: { headingLevel?: 3 | 2 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="grid gap-5 md:grid-cols-2">
      {PROMPT_GROUPS.map((g) => (
        <div key={g.key} className="space-y-2.5">
          <H className="text-base font-semibold text-foreground">{g.title}</H>
          <ul className="m-0 grid list-none gap-2 p-0">
            {g.prompts.map((p) => (
              <li
                key={p.text}
                className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[0.9375rem] font-medium text-foreground">“{p.text}”</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{p.does}</p>
                </div>
                <CopyText
                  value={p.text}
                  label={`Copy the prompt: ${p.text}`}
                  showText={false}
                  className={focusRing}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function SafetyList() {
  return (
    <ul className="m-0 grid list-none gap-2 p-0 text-body text-foreground">
      {MCP_SAFETY.map((line) => (
        <li key={line} className="flex gap-2.5">
          <Check className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums font-semibold text-foreground">
          {used} of {limit}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function UsageMeters({ usage }: { usage: AssistantsOverview["usage"] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Meter
        label="Your actions this minute"
        used={usage.callsThisMinute}
        limit={usage.callsPerMinute}
      />
      <Meter
        label="Campaign sends this hour (whole workspace)"
        used={usage.sendsThisHour}
        limit={usage.sendsPerHour}
      />
    </div>
  );
}

const when = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      });
};

/** Owners and admins: the team's other connected apps (each person removes their own). */
export function TeamApps({ apps }: { apps: AssistantApp[] }) {
  const others = apps.filter((a) => !a.mine);
  if (!others.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-base font-semibold text-foreground">Your team's apps</h3>
      <ul className="m-0 grid list-none gap-2 p-0">
        {others.map((a) => (
          <li
            key={`${a.userId}-${a.clientId}`}
            className="flex flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
          >
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-foreground [overflow-wrap:anywhere]">
                {a.name} <span className="font-normal text-muted-foreground">for {a.member}</span>
              </p>
              <p className="text-sm text-muted-foreground">
                {[
                  a.site,
                  a.grantedAt ? `connected ${when(a.grantedAt)}` : null,
                  a.lastUsedAt ? `last used ${when(a.lastUsedAt)}` : "not used yet",
                ]
                  .filter(Boolean)
                  .join(", ")}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        Each person removes their own apps here. To stop every AI app in this workspace at once,
        switch AI assistants off below.
      </p>
    </div>
  );
}

export function Timeline({
  events,
  seesEveryone,
  copy = ASSISTANTS_COPY.classic.activity,
}: {
  events: AssistantEvent[];
  seesEveryone: boolean;
  /** The page's words for this design (copy.ts); Classic's by default. */
  copy?: AssistantsCopy["activity"];
}) {
  if (!events.length) {
    // Aiden Workspace: the illustrated empty state with its one next step.
    if (copy.emptyAction) {
      return (
        <EmptyState
          icon={History}
          title={copy.emptyTitle}
          description={copy.emptyBody}
          action={
            <Button asChild variant="outline" className="phone:min-h-11">
              <a href="#prompts">{copy.emptyAction}</a>
            </Button>
          }
        />
      );
    }
    return (
      <div className="rounded-xl border border-dashed border-border bg-card px-5 py-6">
        <p className="font-semibold text-foreground">{copy.emptyTitle}</p>
        <p className="mt-1 text-body text-muted-foreground">{copy.emptyBody}</p>
      </div>
    );
  }
  return (
    <ol className="m-0 grid list-none gap-2 p-0">
      {events.map((e) => (
        <li
          key={e.id}
          className="flex flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
        >
          <div className="min-w-0 flex-1">
            <p className="text-foreground [overflow-wrap:anywhere]">
              <span className="font-semibold">{e.app}</span>{" "}
              {ACTION_WORDS[e.action] ?? "made a change"}
              {e.name ? <span className="text-muted-foreground">: {e.name}</span> : null}
            </p>
            <p className="text-sm text-muted-foreground">
              {seesEveryone ? `${e.member === "You" ? "For you" : `For ${e.member}`}, ` : ""}
              <time dateTime={e.at}>{when(e.at)}</time>
            </p>
          </div>
          {e.link ? (
            <a
              href={e.link}
              className={cn(
                "rounded text-sm font-semibold text-primary underline-offset-4 hover:underline",
                focusRing,
              )}
            >
              {copy.open}
            </a>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
