import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Play, RotateCcw } from "lucide-react";
import { DEMO_TEMPLATES } from "@/lib/developer-portal";
import { API_ORIGIN, SEND_PATH } from "@/lib/public-api";
import { CopyButton } from "./code-panel";
import { MessageBubble, PhoneFrame, previewModel, type DeliveryStatus } from "./whatsapp-phone";

/**
 * The portal's signature moment (Batch 38 item 9): a live, editable request
 * on the left, the customer's WhatsApp on the right. Send: the request flies
 * across, "202 Accepted" appears, the bubble lands and its ticks go sent →
 * delivered → read. The phone follows every keystroke. Respects
 * prefers-reduced-motion (no animation, the final state at once); everything
 * that appears has its space reserved, so nothing shifts.
 */

type Phase = "idle" | "flying" | "accepted" | "landed";

const TEMPLATE_KEYS = Object.keys(DEMO_TEMPLATES);

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** An input that looks like a JSON string token and grows with its value. */
function TokenInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <span className="tok-string">
      "
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        spellCheck={false}
        style={{ width: `${Math.max(Array.from(value).length, 1)}ch` }}
        className="rounded-sm border-0 border-b border-dashed border-[oklch(0.82_0.12_150/0.45)] bg-transparent p-0 font-[inherit] text-inherit outline-none transition-colors hover:bg-white/[0.04] focus:border-solid focus:bg-white/[0.06]"
      />
      "
    </span>
  );
}

/** The hero: `intro` (headline, words, buttons) and the request on the left, the phone on the right. */
export function HeroPlayground({ intro }: { intro?: ReactNode }) {
  const [templateKey, setTemplateKey] = useState("invoice_document");
  const template = DEMO_TEMPLATES[templateKey]!;
  const [to, setTo] = useState("+91 98123 45678");
  const [params, setParams] = useState<string[]>(template.params);
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<DeliveryStatus>("pending");
  const timers = useRef<number[]>([]);

  const clear = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  };

  const play = useCallback(() => {
    clear();
    if (reducedMotion()) {
      setPhase("landed");
      setStatus("read");
      return;
    }
    setPhase("idle");
    setStatus("pending");
    const at = (ms: number, f: () => void) => timers.current.push(window.setTimeout(f, ms));
    at(60, () => setPhase("flying"));
    at(660, () => setPhase("accepted"));
    at(980, () => setPhase("landed"));
    at(1500, () => setStatus("sent"));
    at(2300, () => setStatus("delivered"));
    at(3400, () => setStatus("read"));
  }, []);

  useEffect(() => {
    const t = window.setTimeout(play, 500);
    return () => {
      window.clearTimeout(t);
      clear();
    };
  }, [play]);

  const pick = (key: string) => {
    setTemplateKey(key);
    setParams(DEMO_TEMPLATES[key]!.params);
  };

  const body: Record<string, unknown> = {
    to,
    template_name: templateKey,
    ...(templateKey === "invoice_document"
      ? {
          document: {
            url: "https://billing.example.com/INV-1001.pdf",
            filename: template.fileName,
          },
        }
      : {}),
    body_params: params,
  };
  const curl = `curl -X POST ${API_ORIGIN}${SEND_PATH} \\\n  -H "Authorization: Bearer $AIDWAR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'`;
  const accepted = phase === "accepted" || phase === "landed";

  return (
    <div className="relative grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-14">
      <div className="min-w-0">
        {intro}
        <div className="docs-code relative mt-10 min-w-0">
          <div className="docs-code-head flex items-center gap-2 px-4 py-2.5">
            <span className="docs-method docs-method-POST">POST</span>
            <span className="docs-mono min-w-0 truncate text-[12.5px] text-[var(--c-muted)]">
              {SEND_PATH}
            </span>
            <span
              className={`docs-chip ml-auto shrink-0 whitespace-nowrap rounded-full bg-emerald-400/15 px-2.5 py-0.5 font-mono text-[11.5px] font-semibold text-emerald-300 ring-1 ring-emerald-400/30 ${accepted ? "" : "docs-chip-hidden"}`}
              role="status"
              aria-live="polite"
            >
              {accepted ? "202 Accepted" : " "}
            </span>
            <CopyButton
              value={curl}
              label="Copy as cURL"
              className="text-[var(--c-muted)] hover:text-[var(--c-fg)]"
            />
          </div>
          <pre className="docs-mono overflow-x-auto p-5 text-[13px] leading-[1.9]">
            <code>
              <span className="tok-punct">{"{"}</span>
              {"\n  "}
              <span className="tok-key">"to"</span>
              <span className="tok-punct">: </span>
              <TokenInput value={to} onChange={setTo} label="Customer's phone" />
              <span className="tok-punct">,</span>
              {"\n  "}
              <span className="tok-key">"template_name"</span>
              <span className="tok-punct">: </span>
              <span className="tok-string">
                "
                <select
                  value={templateKey}
                  onChange={(e) => pick(e.target.value)}
                  aria-label="Template"
                  className="cursor-pointer appearance-none rounded-sm border-0 border-b border-dashed border-[oklch(0.82_0.12_150/0.45)] bg-transparent p-0 font-[inherit] text-inherit outline-none focus:border-solid"
                >
                  {TEMPLATE_KEYS.map((k) => (
                    <option key={k} value={k} className="bg-[var(--c-bg)] text-[var(--c-fg)]">
                      {k}
                    </option>
                  ))}
                </select>
                "
              </span>
              <span className="tok-punct">,</span>
              {templateKey === "invoice_document" ? (
                <>
                  {"\n  "}
                  <span className="tok-key">"document"</span>
                  <span className="tok-punct">: {"{ "}</span>
                  <span className="tok-key">"url"</span>
                  <span className="tok-punct">: </span>
                  <span className="tok-string">"https://…/INV-1001.pdf"</span>
                  <span className="tok-punct">{" },"}</span>
                </>
              ) : null}
              {"\n  "}
              <span className="tok-key">"body_params"</span>
              <span className="tok-punct">: [</span>
              {params.map((p, i) => (
                <span key={i}>
                  <TokenInput
                    value={p}
                    onChange={(v) => setParams((all) => all.map((x, j) => (j === i ? v : x)))}
                    label={`Value {{${i + 1}}}`}
                  />
                  {i < params.length - 1 ? <span className="tok-punct">, </span> : null}
                </span>
              ))}
              <span className="tok-punct">]</span>
              {"\n"}
              <span className="tok-punct">{"}"}</span>
            </code>
          </pre>
          <div className="flex items-center justify-between gap-3 border-t border-[var(--c-border)] px-4 py-3">
            <p className="text-[12.5px] text-[var(--c-muted)]">
              Edit any value — the phone follows.
            </p>
            <button
              type="button"
              onClick={play}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-[oklch(0.72_0.15_162)] px-3.5 py-1.5 text-[13px] font-semibold text-[oklch(0.18_0.03_255)] transition-transform hover:scale-[1.03] active:scale-[0.98]"
            >
              {phase === "landed" ? (
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Send request
            </button>
          </div>
          {/* The request in flight, toward the phone. */}
          <span
            aria-hidden="true"
            className={`docs-flight hidden lg:block ${phase === "flying" ? "docs-flight-go" : ""}`}
            style={{ left: "100%", ["--flight" as string]: "56px" }}
          />
        </div>
      </div>

      <div className="flex justify-center">
        <PhoneFrame>
          <div className={`wa-landing ${phase === "landed" ? "wa-landed" : ""}`}>
            <MessageBubble
              model={previewModel({
                kind: "template",
                components: template.components,
                params,
                ...(template.fileName ? { fileName: template.fileName } : {}),
              })}
              status={phase === "landed" ? status : "pending"}
            />
          </div>
        </PhoneFrame>
      </div>
    </div>
  );
}
