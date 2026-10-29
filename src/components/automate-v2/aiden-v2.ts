import type { AidenOrbState } from "@/components/design-v2";
import { outcomeOf } from "@/lib/ai-outcome";
import type { EmployeeRun, KnowledgeSource } from "@/lib/employee-client";

/**
 * Batch 49: what the new Automate > Aiden page says, as plain functions so the
 * words are tested. Nothing here reads or writes; the page passes in what the
 * Employee page's own reads returned (overview, work, gaps).
 */

export type AidenMode = "off" | "draft" | "replying";

/** The three modes, the Employee page's MODES with the new design's words. */
export const AIDEN_MODES: Array<{ key: AidenMode; label: string; meaning: string }> = [
  { key: "off", label: "Off", meaning: "Your team answers every message." },
  { key: "draft", label: "Drafts", meaning: "Aiden writes replies, you read and send them." },
  { key: "replying", label: "Replying", meaning: "Aiden replies to customers and passes anything unsure to you." },
];

export function asMode(mode: string | null | undefined): AidenMode {
  return mode === "draft" || mode === "replying" ? mode : "off";
}

/**
 * The status card's state: the workspace AI switch first (switched off means
 * Off whatever the agent's mode says, as the Employee page shows it), then the
 * default agent's mode.
 */
export function aidenStatus(
  mode: string | null | undefined,
  aiEnabled: boolean,
  name: string,
): { mode: AidenMode; orb: AidenOrbState; title: string; meaning: string } {
  if (!aiEnabled) {
    return {
      mode: "off",
      orb: "off",
      title: `${name} is switched off`,
      meaning: `${name} won't answer, draft or even test until AI is turned on for this workspace.`,
    };
  }
  const m = asMode(mode);
  if (m === "replying") {
    return {
      mode: m,
      orb: "replying",
      title: `${name} is replying to customers`,
      meaning: `${name} answers customers on WhatsApp and passes anything unsure to you.`,
    };
  }
  if (m === "draft") {
    return {
      mode: m,
      orb: "draft",
      title: `${name} writes, you send`,
      meaning: `${name} drafts a reply for each customer. Nothing goes out until someone on your team sends it.`,
    };
  }
  return {
    mode: "off",
    orb: "off",
    title: `${name} is off`,
    meaning: `Your team answers every message. ${name} sends nothing and drafts nothing.`,
  };
}

/** Days since an ISO time, for "read 3 days ago"; null when never. */
export function daysSince(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

export function freshnessText(iso: string | null | undefined, now: number = Date.now()): string {
  const d = daysSince(iso, now);
  if (d === null) return "not read yet";
  if (d === 0) return "updated today";
  if (d === 1) return "updated yesterday";
  return `updated ${d} days ago`;
}

export type KnowsRow = {
  key: "website" | "documents" | "answers" | "catalogue";
  label: string;
  detail: string;
  /** "reading" while a read runs, "problem" when the latest read failed. */
  state: "ok" | "reading" | "problem" | "empty";
};

const DOCUMENT_TYPES = new Set(["pdf", "spreadsheet", "upload", "docx", "image"]);
const count = new Intl.NumberFormat("en-IN");
const plural = (n: number, one: string, many: string) => `${count.format(n)} ${n === 1 ? one : many}`;

/** The newest of the given times. */
function newest(times: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const t of times) if (t && (!best || t > best)) best = t;
  return best;
}

/**
 * "What Aiden knows": the workspace's website, documents and saved answers
 * (overview.sources, deleted websites left out the way the Knowledge tab
 * hides them) and the catalogue's product count and newest change.
 */
export function knowsRows(
  sources: KnowledgeSource[],
  catalogue: { products: number; lastUpdated: string | null } | null,
  now: number = Date.now(),
): KnowsRow[] {
  const live = sources.filter((s) => !s.deleted);
  const sites = live.filter((s) => s.type === "website");
  const docs = live.filter((s) => DOCUMENT_TYPES.has(s.type));
  const answers = live.filter((s) => s.type === "manual_qa");
  const rows: KnowsRow[] = [];

  if (sites.length === 0) {
    rows.push({ key: "website", label: "Website", detail: "Not added yet", state: "empty" });
  } else {
    const site = sites[0]!;
    const reading = sites.some((s) => s.status === "pending" || s.status === "syncing");
    const broken = !reading && sites.some((s) => s.status === "error");
    const pages = sites.reduce((n, s) => n + (s.item_count ?? 0), 0);
    rows.push({
      key: "website",
      label: sites.length === 1 ? site.name : `${site.name} and ${sites.length - 1} more`,
      detail: reading
        ? `Reading now, ${plural(pages, "page", "pages")} so far`
        : broken
          ? "The last read didn't finish"
          : `${plural(pages, "page", "pages")}, ${freshnessText(newest(sites.map((s) => s.last_synced_at)), now)}`,
      state: reading ? "reading" : broken ? "problem" : "ok",
    });
  }

  const docItems = docs.reduce((n, s) => n + (s.item_count ?? 0), 0);
  rows.push(
    docs.length === 0
      ? { key: "documents", label: "Documents", detail: "None uploaded", state: "empty" }
      : {
          key: "documents",
          label: "Documents",
          detail: `${plural(docs.length, "file", "files")}, ${freshnessText(newest(docs.map((s) => s.last_synced_at)), now)}`,
          state: docs.some((s) => s.status === "error")
            ? "problem"
            : docs.some((s) => s.status === "pending" || s.status === "syncing")
              ? "reading"
              : docItems > 0
                ? "ok"
                : "empty",
        },
  );

  const qa = answers.reduce((n, s) => n + (s.item_count ?? 0), 0);
  rows.push({
    key: "answers",
    label: "Your answers",
    detail: qa > 0 ? plural(qa, "answer you wrote", "answers you wrote") : "None written yet",
    state: qa > 0 ? "ok" : "empty",
  });

  if (catalogue) {
    rows.push({
      key: "catalogue",
      label: "Catalogue",
      detail:
        catalogue.products > 0
          ? `${plural(catalogue.products, "product", "products")}, ${freshnessText(catalogue.lastUpdated, now)}`
          : "No products yet",
      state: catalogue.products > 0 ? "ok" : "empty",
    });
  }
  return rows;
}

/**
 * Answers worth a look: customer replies (agent_reply) from the work log that
 * Aiden passed on or didn't give, newest first, one per question.
 */
export function answersToCheck(runs: EmployeeRun[], limit = 3): EmployeeRun[] {
  const seen = new Set<string>();
  const out: EmployeeRun[] = [];
  for (const run of runs) {
    if (run.task !== "agent_reply") continue;
    const key = outcomeOf(run.status, run.escalation_signal).key;
    if (key !== "handed_over" && key !== "not_answered") continue;
    const q = (run.input_summary ?? "").trim().toLowerCase();
    if (!q || seen.has(q)) continue;
    seen.add(q);
    out.push(run);
    if (out.length >= limit) break;
  }
  return out;
}
