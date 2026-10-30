import { CONNECT_CLIENTS, EXAMPLE_PROMPTS, MCP_LIMITS, MCP_PROMISE, MCP_URL } from "@/lib/mcp-connect";
import { CodePanel, CopyButton } from "./code-panel";
import { Heading } from "./docs-ui";

/**
 * Batch 52: /developers#mcp — AiDwar MCP. The address, the connect steps for
 * Claude, ChatGPT, Codex and Cursor (from src/lib/mcp-connect.ts, each with
 * the client's own docs linked) and prompts to try. Product names as text
 * only, no third-party logos.
 */
export function McpSection() {
  return (
    <section id="mcp" className="scroll-mt-24 space-y-8 border-t border-[var(--d-border)] py-14" aria-labelledby="mcp-title">
      <div className="max-w-[46rem] space-y-4">
        <Heading id="mcp-title" level={2}>
          AiDwar MCP: use AiDwar from your AI assistant
        </Heading>
        <p className="text-[17px] leading-relaxed text-[var(--d-muted)]">
          Connect Claude, ChatGPT, Codex or Cursor to your AiDwar workspace. Ask it how your last campaign did, have it
          draft the next one or build a chat flow. Every plan includes it, trial too. Your AI assistant signs in as you
          (OAuth), so you approve the connection once and can remove it any time in Settings, Connected AI apps.
        </p>
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--d-border)] bg-[var(--d-surface)] px-4 py-3">
          <span className="text-[14px] font-medium text-[var(--d-muted)]">Server URL</span>
          <code className="min-w-0 flex-1 font-mono text-[15px] font-semibold text-[var(--d-fg)] [overflow-wrap:anywhere]">{MCP_URL}</code>
          <CopyButton value={MCP_URL} label="Copy the server URL" showText className="text-[var(--d-accent-strong)] hover:bg-[var(--d-accent-soft)]" />
        </div>
        <ul className="m-0 grid list-none gap-2 p-0 text-[15.5px] text-[var(--d-fg)]">
          {MCP_PROMISE.map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden="true" className="text-[var(--d-accent-strong)]">✓</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <p className="text-[15px] text-[var(--d-muted)]">{MCP_LIMITS}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {CONNECT_CLIENTS.map((c) => (
          <article key={c.key} id={`mcp-${c.key}`} className="docs-card scroll-mt-24 space-y-3 p-5" aria-labelledby={`mcp-${c.key}-title`}>
            <h3 id={`mcp-${c.key}-title`} className="text-[18px] font-semibold text-[var(--d-fg)]">
              {c.name}
            </h3>
            <p className="text-[14px] text-[var(--d-muted)]">{c.availability}</p>
            <ol className="m-0 list-decimal space-y-1.5 pl-5 text-[15px] text-[var(--d-fg)]">
              {c.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {c.code ? (
              <CodePanel group={{ title: c.code.label, samples: [{ lang: c.code.language === "toml" ? "text" : c.code.language, label: c.code.label, code: c.code.text }] }} maxHeight="none" />
            ) : null}
            <p className="text-[13.5px] text-[var(--d-muted)]">
              Steps from{" "}
              <a href={c.source} rel="noopener noreferrer" target="_blank" className="font-medium text-[var(--d-accent-strong)] hover:underline">
                {c.name.split(" (")[0]}'s documentation
              </a>
              .
            </p>
          </article>
        ))}
      </div>

      <div className="space-y-3">
        <h3 id="mcp-prompts" className="text-[18px] font-semibold text-[var(--d-fg)]">
          Try asking
        </h3>
        <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">
          {EXAMPLE_PROMPTS.map((p) => (
            <li key={p} className="rounded-xl border border-[var(--d-border)] bg-[var(--d-surface)] px-4 py-3 text-[15px] text-[var(--d-fg)]">
              “{p}”
            </li>
          ))}
        </ul>
        <p className="text-[14.5px] text-[var(--d-muted)]">
          When your assistant drafts a campaign, AiDwar answers with who it reaches (opted-in customers only), what it
          costs and your wallet balance, and a confirm code. It sends only after you say yes.
        </p>
      </div>
    </section>
  );
}
