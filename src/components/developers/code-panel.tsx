import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, Copy } from "lucide-react";
import { highlight } from "@/lib/code-highlight";
import type { CodeGroup, Sample } from "@/lib/developer-portal";

/**
 * The developer portal's dark code panel: language tabs (the choice is
 * remembered across pages and synced across every panel on the page), a
 * copy button with a check, light syntax colours. Batch 38 item 9.
 */

const LANG_KEY = "aidwar-docs-lang";
const REQUEST_LANGS = new Set(["curl", "node", "python", "php"]);
const listeners = new Set<() => void>();
let current: string | null = null;

function readLang(): string {
  if (current) return current;
  try {
    current = window.localStorage.getItem(LANG_KEY) || "curl";
  } catch {
    current = "curl";
  }
  return current;
}

export function setDocsLanguage(lang: string): void {
  current = lang;
  try {
    window.localStorage.setItem(LANG_KEY, lang);
  } catch {
    // private mode: remembered for this page only
  }
  for (const l of listeners) l();
}

/** The reader's language (cURL until they pick another). */
export function useDocsLanguage(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      const onStorage = (e: StorageEvent) => {
        if (e.key === LANG_KEY) {
          current = e.newValue;
          cb();
        }
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    readLang,
    () => "curl",
  );
}

export function CopyButton({
  value,
  label = "Copy",
  className = "",
  showText = false,
}: {
  value: string;
  label?: string;
  className?: string;
  showText?: boolean;
}) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1600);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      aria-label={done ? "Copied" : label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => setDone(true),
          () => setDone(false),
        );
      }}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${done ? "docs-copy-done" : ""} ${className}`}
    >
      {done ? (
        <Check className="docs-copy-icon h-3.5 w-3.5 text-[var(--d-accent)]" aria-hidden="true" />
      ) : (
        <Copy className="docs-copy-icon h-3.5 w-3.5" aria-hidden="true" />
      )}
      {showText ? <span>{done ? "Copied" : label}</span> : null}
      <span className="sr-only" aria-live="polite">
        {done ? "Copied to the clipboard" : ""}
      </span>
    </button>
  );
}

export function Highlighted({ sample }: { sample: Sample }) {
  const tokens = highlight(sample.lang, sample.code);
  return (
    <code>
      {tokens.map((t, i) =>
        t.t === "plain" ? (
          <span key={i}>{t.v}</span>
        ) : (
          <span key={i} className={`tok-${t.t}`}>
            {t.v}
          </span>
        ),
      )}
    </code>
  );
}

function statusTone(status?: number): string {
  if (!status) return "";
  if (status < 300) return "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30";
  if (status < 500) return "bg-amber-400/15 text-amber-200 ring-amber-400/30";
  return "bg-rose-400/15 text-rose-200 ring-rose-400/30";
}

/** One group of samples: tabs when there is more than one. */
export function CodePanel({
  group,
  className = "",
  maxHeight = "min(70vh, 640px)",
  fade = false,
}: {
  group: CodeGroup;
  className?: string;
  maxHeight?: string;
  fade?: boolean;
}) {
  const preferred = useDocsLanguage();
  const samples = group.samples;
  const isRequest = samples.some((s) => REQUEST_LANGS.has(s.lang));
  const [local, setLocal] = useState(0);
  const fromPreferred = samples.findIndex((s) => s.lang === preferred);
  const index =
    isRequest && fromPreferred >= 0 ? fromPreferred : Math.min(local, samples.length - 1);
  const sample = samples[index]!;
  return (
    <div className={`docs-code ${fade ? "docs-code-fade" : ""} ${className}`}>
      <div className="docs-code-head flex items-center gap-2 px-3 py-2">
        <span className="mr-auto flex min-w-0 items-center gap-2 truncate text-xs font-medium text-[var(--c-muted)]">
          {group.status ? (
            <span
              className={`rounded-full px-2 py-0.5 font-mono text-[11px] ring-1 ${statusTone(group.status)}`}
            >
              {group.status}
            </span>
          ) : null}
          <span className="truncate">{group.title}</span>
        </span>
        {samples.length > 1 ? (
          <div role="tablist" aria-label="Language" className="flex flex-wrap gap-0.5">
            {samples.map((s, i) => (
              <button
                key={`${s.lang}-${i}`}
                type="button"
                role="tab"
                aria-selected={i === index}
                onClick={() => {
                  if (REQUEST_LANGS.has(s.lang)) setDocsLanguage(s.lang);
                  setLocal(i);
                }}
                className="docs-tab rounded-md px-2 py-1 text-xs font-medium"
              >
                {s.label}
              </button>
            ))}
          </div>
        ) : null}
        <CopyButton
          value={sample.code}
          label={`Copy ${sample.label}`}
          className="text-[var(--c-muted)] hover:text-[var(--c-fg)]"
        />
      </div>
      {/* Every tab is in the page (crawlers and readers without scripts get all of them); one shows. */}
      {samples.map((s, i) => (
        <pre
          key={`${s.lang}-${i}`}
          hidden={i !== index}
          className="overflow-auto p-4"
          style={{ maxHeight }}
          tabIndex={i === index ? 0 : -1}
          aria-label={`${group.title} — ${s.label}`}
        >
          <Highlighted sample={s} />
        </pre>
      ))}
    </div>
  );
}
