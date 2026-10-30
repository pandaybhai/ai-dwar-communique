import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ConnectSteps, CopyText, PromptLibrary, SafetyList } from "@/components/ai-assistants/parts";
import { MCP_URL } from "@/lib/mcp-connect";
import { cn } from "@/lib/utils";
import { AssistantDemo } from "./demos";
import { NewSiteShell } from "./site-shell";

/**
 * Batch 53: aidwar.in/ai-assistants, for merchants (not developers). Always
 * in the new look, for logged-out visitors too, whatever the new_site switch
 * says. Every step, prompt and safety line comes from the same files as the
 * in-app AI assistants page (mcp-connect.ts, mcp-prompts.ts). Product names
 * as text only; no third-party logos.
 */

const WRAP = "mx-auto w-full max-w-[1200px] px-[max(16px,env(safe-area-inset-left))]";
const H2 =
  "m-0 max-w-2xl font-display text-[clamp(1.75rem,3.4vw,2.5rem)] font-extrabold leading-[1.05] tracking-[-0.025em]";
const LINK =
  "rounded font-semibold text-aiden-deep underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden";

export const PUBLIC_TITLE = "Run WhatsApp marketing from Claude, ChatGPT, Codex or Cursor — AiDwar";
export const PUBLIC_DESCRIPTION =
  "Connect the AI assistant you already use to AiDwar. Ask how your campaigns did, draft the next one or build a chat flow. Nothing is sent until you confirm. Included on every plan.";

const STEPS = [
  { title: "Copy the address", body: `Copy ${MCP_URL}. It's the same for every AI app.` },
  {
    title: "Add it to your assistant",
    body: "In Claude, ChatGPT, Codex or Cursor, add a custom connector (MCP server) with that address. The exact steps for each app are below.",
  },
  {
    title: "Sign in and ask",
    body: "Sign in to AiDwar when your assistant asks and choose Allow. Then ask it anything below.",
  },
];

export const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "Which AI apps work with AiDwar?",
    a: "Claude (claude.ai and Claude Desktop), ChatGPT, Codex and Cursor, and any other app that connects to remote MCP servers with OAuth sign-in.",
  },
  {
    q: "Which plans do I need?",
    a: "Every AiDwar plan includes it, the free trial too. On the AI side: Claude allows one custom connector on its Free plan and more on Pro, Max, Team and Enterprise; ChatGPT allows custom connectors on Business and Enterprise/Edu; Codex and Cursor allow them for everyone.",
  },
  {
    q: "Is it safe?",
    a: "Your assistant signs in as you and can only do what you can do in AiDwar. It reads and drafts; sending a campaign or switching on a flow needs your yes with a confirm code that lasts 15 minutes. It can't message a single customer, change Aiden, billing, your team or settings, or delete anything. Owners can switch AI assistants off for the whole workspace at any time.",
  },
  {
    q: "How do I disconnect it?",
    a: "In AiDwar, open AI assistants and choose Remove next to the app. Its access ends at once. You can also remove AiDwar from the connector list in your AI app.",
  },
];

export function AiAssistantsPublic() {
  return (
    <NewSiteShell>
      <section className={cn(WRAP, "grid items-center gap-12 pb-16 pt-12 sm:pt-16 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:pb-24")}>
        <div className="flex min-w-0 flex-col gap-6">
          <span className="inline-flex w-fit items-center rounded-full bg-aiden-soft px-3.5 py-1.5 text-sm font-semibold text-aiden-deep">
            AiDwar for AI assistants
          </span>
          <h1 className="m-0 font-display text-[clamp(2.25rem,5.2vw,3.75rem)] font-extrabold leading-[1.02] tracking-[-0.035em] [text-wrap:balance]">
            Run WhatsApp marketing from Claude, ChatGPT, Codex or Cursor
          </h1>
          <p className="m-0 max-w-[48ch] text-[1.0625rem] text-muted-foreground">
            Ask the AI assistant you already use how your last campaign did, have it draft the next one or build a chat
            flow. AiDwar does the work and asks you before anything goes out. Included on every plan.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <Link to="/signup">Start free</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/demo">Book a demo</Link>
            </Button>
          </div>
        </div>
        <div>
          <AssistantDemo />
          <p className="m-0 mt-2 text-center text-sm text-muted-foreground">An example with a sample shop.</p>
        </div>
      </section>

      <section className="border-t border-border" aria-labelledby="connect-title">
        <div className={cn(WRAP, "flex flex-col gap-8 py-16 sm:py-20")}>
          <h2 id="connect-title" className={H2}>
            Connected in three steps
          </h2>
          <ol className="m-0 grid list-none gap-4 p-0 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-5">
                <span className="font-display text-3xl font-extrabold text-aiden-deep">{i + 1}</span>
                <h3 className="m-0 text-lg font-semibold">{s.title}</h3>
                <p className="m-0 text-muted-foreground">{s.body}</p>
                {i === 0 ? <CopyText value={MCP_URL} label="Copy the server URL" className="mt-1 w-fit" /> : null}
              </li>
            ))}
          </ol>
          <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
            <h3 className="m-0 mb-4 text-lg font-semibold">The exact steps for your app</h3>
            <ConnectSteps />
          </div>
        </div>
      </section>

      <section className="border-t border-border" aria-labelledby="prompts-title">
        <div className={cn(WRAP, "flex flex-col gap-8 py-16 sm:py-20")}>
          <div className="flex flex-col gap-3">
            <h2 id="prompts-title" className={H2}>
              What to ask
            </h2>
            <p className="m-0 max-w-[56ch] text-muted-foreground">Copy any of these into your assistant.</p>
          </div>
          <PromptLibrary />
        </div>
      </section>

      <section className="border-t border-border" aria-labelledby="safety-title">
        <div className={cn(WRAP, "grid gap-8 py-16 sm:py-20 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]")}>
          <h2 id="safety-title" className={H2}>
            You stay in charge
          </h2>
          <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
            <SafetyList />
          </div>
        </div>
      </section>

      <section className="border-t border-border" aria-labelledby="faq-title">
        <div className={cn(WRAP, "flex flex-col gap-6 py-16 sm:py-20")}>
          <h2 id="faq-title" className={H2}>
            Questions
          </h2>
          <div className="grid gap-3">
            {FAQ.map((f) => (
              <details key={f.q} className="group rounded-2xl border border-border bg-card px-5 py-4">
                <summary className="cursor-pointer list-none rounded text-lg font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden [&::-webkit-details-marker]:hidden">
                  {f.q}
                </summary>
                <p className="m-0 mt-3 text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
          <p className="m-0 text-muted-foreground">
            Building something of your own? See{" "}
            <a href="/developers#mcp" className={LINK}>
              AiDwar MCP for developers
            </a>
            .
          </p>
        </div>
      </section>

      <section className="border-t border-border bg-ink text-ink-foreground" aria-labelledby="cta-title">
        <div className={cn(WRAP, "flex flex-col items-start gap-5 py-16 sm:py-20")}>
          <h2 id="cta-title" className={H2}>
            Try it on your own shop
          </h2>
          <p className="m-0 max-w-[52ch] opacity-80">Start free, connect WhatsApp, then add AiDwar to your assistant.</p>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to="/signup">Start free</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="border-ink-foreground/40 bg-transparent text-ink-foreground hover:bg-ink-foreground/10">
              <Link to="/demo">Book a demo</Link>
            </Button>
          </div>
        </div>
      </section>
    </NewSiteShell>
  );
}
