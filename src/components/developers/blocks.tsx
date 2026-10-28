import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  FileText,
  Info,
  MessagesSquare,
  TriangleAlert,
  Users,
  Webhook,
  Zap,
} from "lucide-react";
import { API_ENDPOINTS, WEBHOOK_EVENTS, errorRow } from "@/lib/public-api-spec";
import {
  errorCodes,
  errorMeaning,
  payloadRows,
  previewFor,
  whatToDo,
  type Block,
} from "@/lib/developer-portal";
import { CodePanel } from "./code-panel";

const GENERIC_400 = whatToDo("400", "");
import { DocLink, Heading, InlineText, MethodBadge } from "./docs-ui";
import { WhatsAppPhone } from "./whatsapp-phone";

/** One docs block, as the page shows it (Batch 38 item 9). */

const ICONS = {
  invoice: FileText,
  chat: MessagesSquare,
  users: Users,
  book: BookOpen,
  bolt: Zap,
  webhook: Webhook,
};

function Table({ head, rows, label }: { head: string[]; rows: string[][]; label: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--d-border)] bg-[var(--d-surface)]">
      <table className="w-full text-left text-[14px]" aria-label={label}>
        <thead>
          <tr className="border-b border-[var(--d-border)] bg-[var(--d-subtle)]">
            {head.map((h) => (
              <th
                key={h}
                scope="col"
                className="whitespace-nowrap px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--d-muted)]"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-[var(--d-border)] last:border-0 align-top">
              {r.map((c, j) => (
                <td
                  key={j}
                  className={`px-4 py-3 leading-relaxed ${j === 0 ? "whitespace-nowrap" : ""}`}
                >
                  <InlineText text={c} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ParamsTable({ endpointId }: { endpointId: string }) {
  const e = API_ENDPOINTS.find((x) => x.id === endpointId)!;
  const fields = e.fields ?? [];
  if (!fields.length)
    return <p className="text-[var(--d-muted)]">This endpoint takes no parameters.</p>;
  const groups: Array<["path" | "query" | "body", string]> = [
    ["path", "Path"],
    ["query", "Query"],
    ["body", "Body (JSON)"],
  ];
  return (
    <div className="space-y-6">
      {groups.map(([where, label]) => {
        const list = fields.filter((f) => f.in === where);
        if (!list.length) return null;
        return (
          <div key={where}>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-[var(--d-muted)]">
              {label}
            </h3>
            <ul className="divide-y divide-[var(--d-border)] rounded-xl border border-[var(--d-border)] bg-[var(--d-surface)]">
              {list.map((f) => (
                <li key={f.name} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <code className="docs-mono text-[14px] font-semibold text-[var(--d-fg)]">
                      {f.name}
                    </code>
                    <span className="docs-mono text-[12px] text-[var(--d-muted)]">{f.type}</span>
                    {f.required ? (
                      <span className="rounded-full bg-[var(--d-accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--d-accent-strong)]">
                        required
                      </span>
                    ) : (
                      <span className="text-[11px] text-[var(--d-faint)]">optional</span>
                    )}
                  </div>
                  <p className="mt-1 text-[14.5px] leading-relaxed text-[var(--d-muted)]">
                    <InlineText text={f.description} />
                    {f.example ? (
                      <>
                        {" "}
                        Example: <code className="docs-inline">{f.example}</code>
                      </>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function ErrorsTable({ endpointId, status }: { endpointId?: string; status?: string }) {
  const codes = errorCodes({
    ...(endpointId ? { endpointId } : {}),
    ...(status ? { status } : {}),
  });
  return (
    <ul
      aria-label="Errors"
      className="divide-y divide-[var(--d-border)] overflow-hidden rounded-xl border border-[var(--d-border)] bg-[var(--d-surface)]"
    >
      {codes.map((c) => {
        const st = errorRow(c)?.status ?? "";
        return (
          <li
            key={c}
            id={`error-${c}`}
            className="grid scroll-mt-24 gap-x-5 gap-y-1.5 px-4 py-3.5 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]"
          >
            <div className="flex min-w-0 items-start gap-2">
              <span className={`docs-status docs-status-${st.charAt(0)} shrink-0`}>{st}</span>
              <code className="docs-mono min-w-0 break-all pt-px text-[13.5px] font-semibold text-[var(--d-fg)]">
                {c}
              </code>
            </div>
            <div className="text-[14.5px] leading-relaxed">
              <p className="text-[var(--d-fg)]">
                <InlineText text={errorMeaning(c)} />
              </p>
              {/* On the Errors page each status says its common "what to do" once, above its list. */}
              {status && st === "400" && whatToDo(st, c) === GENERIC_400 ? null : (
                <p className="mt-0.5 text-[var(--d-muted)]">
                  <InlineText text={whatToDo(st, c)} />
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PayloadTable({ event }: { event: string }) {
  const ev = WEBHOOK_EVENTS.find((x) => x.name === event)!;
  return (
    <Table
      label={`${event} payload`}
      head={["Field", "Type", "Example"]}
      rows={payloadRows(ev.example).map(([n, t, x]) => [`\`${n}\``, t, x ? `\`${x}\`` : ""])}
    />
  );
}

/** The 24-hour window, drawn. */
export function WindowDiagram() {
  return (
    <figure className="docs-card p-5" aria-label="The 24-hour window">
      <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--d-muted)]">
        <MessagesSquare className="h-4 w-4 text-[var(--d-accent)]" aria-hidden="true" />
        The customer writes to you
      </div>
      <div className="mt-3 grid grid-cols-[2fr_1fr] gap-2">
        <div className="docs-window-open rounded-lg px-3 py-3">
          <p className="text-[13px] font-semibold text-[var(--d-fg)]">Window open — 24 hours</p>
          <p className="mt-0.5 text-[12.5px] text-[var(--d-muted)]">
            Reply in your own words (session messages) or send any template.
          </p>
        </div>
        <div className="docs-window-closed rounded-lg px-3 py-3">
          <p className="text-[13px] font-semibold text-[var(--d-fg)]">Closed</p>
          <p className="mt-0.5 text-[12.5px] text-[var(--d-muted)]">Approved templates only.</p>
        </div>
      </div>
      <div className="mt-2 flex justify-between text-[11.5px] tabular-nums text-[var(--d-faint)]">
        <span>0 h</span>
        <span>24 h</span>
        <span>later</span>
      </div>
      <figcaption className="mt-3 text-[13px] text-[var(--d-muted)]">
        Each new message from the customer starts a fresh 24 hours.
      </figcaption>
    </figure>
  );
}

export function PreviewBlock({ endpointId }: { endpointId: string }) {
  const e = API_ENDPOINTS.find((x) => x.id === endpointId)!;
  const p = previewFor(e);
  if (!p) return null;
  return (
    <figure className="docs-card docs-preview overflow-hidden">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[var(--d-border)] px-5 py-3">
        <span className="text-[13px] font-semibold text-[var(--d-fg)]">
          What your customer sees
        </span>
        <span className="text-[12.5px] text-[var(--d-muted)]">
          The example request, drawn from the template's own parts
        </span>
      </figcaption>
      <div className="docs-preview-stage flex justify-center px-4 py-8">
        <WhatsAppPhone
          compact
          message={
            p.kind === "text"
              ? { kind: "text", text: p.text }
              : { kind: "template", components: p.components, params: p.params }
          }
        />
      </div>
    </figure>
  );
}

export function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "p":
      return (
        <p>
          <InlineText text={block.text} />
        </p>
      );
    case "h3":
      return (
        <Heading id={block.id} level={3}>
          {block.text}
        </Heading>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          className={`space-y-2 pl-5 ${block.ordered ? "list-decimal" : "list-disc"} marker:text-[var(--d-faint)]`}
        >
          {block.items.map((x, i) => (
            <li key={i} className="pl-1">
              <InlineText text={x} />
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return <Table head={block.head} rows={block.rows} label={block.head.join(", ")} />;
    case "callout": {
      const Icon =
        block.tone === "warn" ? TriangleAlert : block.tone === "success" ? CheckCircle2 : Info;
      return (
        <aside
          className={`flex gap-3 rounded-xl border p-4 text-[15px] ${
            block.tone === "warn"
              ? "border-amber-500/30 bg-amber-500/[0.07]"
              : "border-[color-mix(in_oklab,var(--d-accent)_35%,transparent)] bg-[var(--d-accent-soft)]"
          }`}
        >
          <Icon
            className={`mt-0.5 h-5 w-5 shrink-0 ${block.tone === "warn" ? "text-amber-600" : "text-[var(--d-accent-strong)]"}`}
            aria-hidden="true"
          />
          <div>
            <p className="font-semibold text-[var(--d-fg)]">{block.title}</p>
            <p className="mt-0.5 text-[var(--d-muted)]">
              <InlineText text={block.text} />
            </p>
          </div>
        </aside>
      );
    }
    case "code":
      return <CodePanel group={block.group} />;
    case "cards":
      return (
        <div className="not-prose grid gap-4 sm:grid-cols-3">
          {block.cards.map((c) => {
            const Icon = ICONS[c.icon];
            return (
              <DocLink
                key={c.title}
                href={c.href}
                className="docs-card docs-plain group flex flex-col p-5"
              >
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--d-accent-soft)] text-[var(--d-accent-strong)]">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="mt-4 text-[16px] font-semibold text-[var(--d-fg)]">{c.title}</span>
                <span className="mt-1.5 flex-1 text-[14.5px] leading-relaxed text-[var(--d-muted)]">
                  {c.text}
                </span>
                <span className="mt-4 inline-flex items-center gap-1 text-[13.5px] font-semibold text-[var(--d-accent-strong)]">
                  Read the guide
                  <ArrowRight
                    className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
              </DocLink>
            );
          })}
        </div>
      );
    case "steps":
      return (
        <ol className="space-y-4">
          {block.steps.map((s, i) => (
            <li key={i} className="docs-card p-5">
              <p className="font-semibold text-[var(--d-fg)]">
                <InlineText text={s.title} />
              </p>
              <p className="mt-2 text-[15.5px] text-[var(--d-muted)]">
                <InlineText text={s.text} />
              </p>
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-[var(--d-accent-soft)] px-3 py-2 text-[14.5px] text-[var(--d-fg)]">
                <CheckCircle2
                  className="mt-0.5 h-4 w-4 shrink-0 text-[var(--d-accent-strong)]"
                  aria-hidden="true"
                />
                <span>
                  <span className="font-semibold">Success: </span>
                  <InlineText text={s.success} />
                </span>
              </p>
            </li>
          ))}
        </ol>
      );
    case "window":
      return <WindowDiagram />;
    case "params":
      return <ParamsTable endpointId={block.endpointId} />;
    case "errors":
      return (
        <ErrorsTable
          {...(block.endpointId ? { endpointId: block.endpointId } : {})}
          {...(block.status ? { status: block.status } : {})}
        />
      );
    case "payload":
      return <PayloadTable event={block.event} />;
    case "preview":
      return <PreviewBlock endpointId={block.endpointId} />;
    case "links":
      return (
        <ul className="divide-y divide-[var(--d-border)] overflow-hidden rounded-xl border border-[var(--d-border)] bg-[var(--d-surface)]">
          {block.items.map((l) => (
            <li key={l.href}>
              <DocLink
                href={l.href}
                className="docs-plain group flex items-center gap-3 px-4 py-3 text-[15px] transition-colors hover:bg-[var(--d-subtle)]"
              >
                {l.method ? (
                  <MethodBadge short method={l.method} className="w-12 text-center" />
                ) : null}
                <span className="flex-1 font-medium text-[var(--d-fg)]">{l.label}</span>
                <ArrowRight
                  className="h-4 w-4 text-[var(--d-faint)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--d-accent)]"
                  aria-hidden="true"
                />
              </DocLink>
            </li>
          ))}
        </ul>
      );
  }
}
