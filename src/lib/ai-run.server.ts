/**
 * The single place in this codebase that calls a model.
 *
 * Everything else — inbox suggestions, the agent, the playground, comparison,
 * embedding — comes through here or through /api/internal/ai-run, which is a
 * thin HTTP wrapper around it. That is what makes cost, tool use and refusals
 * countable: there is one door.
 *
 * Two rules hold throughout:
 *  1. Tools are loaded with brokerTools() and executed with invokeTool(). This
 *     file never touches workspace data directly, so a model can never reach
 *     past the permissions of the person it is acting for.
 *  2. Spend is checked against real recorded cost before the call and recorded
 *     after it. Over the cap a run refuses (status 'capped') instead of quietly
 *     degrading to a worse answer.
 */

import { outsideFetch } from "@/lib/outside-call.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  brokerTools,
  invokeTool,
  userPrincipal,
  agentPrincipal,
  type BrokeredTool,
  type ToolContext,
  type ToolPrincipal,
} from "@/lib/ai-tools.server";
import {
  BACKUP_RATES_INR,
  ProviderHttpError,
  ProviderStreamCut,
  anthropicConversation,
  loadPlatformBackup,
  outageOf,
  platformBackupRoutes,
  reportProviderTrouble,
  type BackupConversation,
  type BackupRoute,
  type BackupStep,
  type NeutralTurn,
  type Outage,
} from "@/lib/ai-fallback.server";
import { EARLY_CALL_ID, type EarlySearch } from "@/lib/early-search.server";
import { productFacts, rupees } from "@/lib/product-facts";

const GATEWAY = "https://ai.gateway.lovable.dev/v1";

/**
 * Where each vendor is called directly, when the platform holds that vendor's
 * own key instead of routing through the resale gateway. Every entry speaks
 * the OpenAI-compatible chat-completions shape, so one code path serves all.
 * Adding a future vendor is one line here plus a row in `ai_models`.
 */
const DIRECT_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};

/** The model name a vendor expects when called directly, without its prefix. */
function wireModel(provider: string, modelId: string): string {
  const prefix = `${provider}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}


export type AiTask = "suggest_reply" | "summarise" | "auto_tag" | "agent_reply" | "embedding" | "extract_facts";

export type ResolvedBrain = {
  /** Platform-internal. Never travels to a merchant surface. */
  provider: string;
  /** Platform-internal. Never travels to a merchant surface. */
  model_id: string;
  /** The merchant-facing tier key: "everyday", "careful". */
  tier: string;
  /** The words a merchant sees: "Everyday", "Careful". */
  display_name: string;
  supports_tools: boolean;
  /** Where the choice came from, for the "why this tier" line. */
  origin: "task" | "agent" | "workspace" | "platform";
};

export type RunSource = {
  kind: "knowledge" | "tool";
  label: string;
  ref?: string;
  similarity?: number;
  /** Knowledge only: where the material came from ("manual_qa" = taught). */
  sourceType?: string;
  documentId?: string;
};


export type RunOptions = {
  organizationId: string;
  task: AiTask;
  /** Plain user-visible question or instruction. */
  input: string;
  system?: string;
  /**
   * Only the merchant-authored hand-over rules (ai_instructions.escalation_rules).
   * Never the assembled brief: platform wording in the brief used to match
   * ordinary questions and hold known answers for review.
   */
  handoverRules?: string;
  agentId?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  actorUserId?: string | null;
  actingRole?: string | null;
  /**
   * Whose permissions the tools run under. Omitted means: the acting user, or
   * the workspace's AI role when the agent is acting on its own.
   */
  principal?: ToolPrincipal;
  /** Force a tier instead of resolving one (comparison, playground). */
  tier?: string | null;
  /** Let the model call brokered tools. */
  useTools?: boolean;
  /** Retrieve from the knowledge base before answering. */
  useKnowledge?: boolean;
  comparisonId?: string | null;
  /** Prior turns, oldest first. */
  history?: { role: "user" | "assistant"; content: string }[];
  maxSteps?: number;
  /** Skip writing an ai_runs row (never used by product surfaces). */
  dryRun?: boolean;
  /** Which version of the platform rules produced this answer. */
  promptRulesVersion?: number | null;
  /** The language the customer wrote in, when the webhook could tell. */
  customerLanguage?: string | null;
  /** Earlier questions in this chat where the AI failed or handed over. */
  priorFailedQuestions?: string[];
  /** Where this run came from, e.g. the owner's onboarding chat. */
  metadata?: Record<string, unknown> | null;
  /** The platform pays for this one: nothing is billed to the workspace. */
  billingExempt?: boolean;
  /** Merchant onboarding chats are platform-paid and bypass workspace kill switches. */
  channel?: "onboarding" | null;
  /**
   * Super-admin test from /admin/aiden: nothing is sent, nothing is billed
   * (requires billingExempt), and workspace kill switches don't apply so a
   * paused workspace can still be tested. The platform cap still does.
   */
  preview?: boolean;
  /** A picture to read, as a data URL. Used when a merchant sends a photo. */
  imageDataUrl?: string | null;
  /**
   * The daily ai_usage roll-up is handed here instead of being awaited before
   * the answer returns (the inbound webhook awaits it before it marks the
   * event processed). Omitted: awaited in place, as always.
   */
  deferUsage?: (work: Promise<unknown>) => void;
  /**
   * Called (never awaited) the moment send_products queues products, while
   * the model is still writing its closing words — the reply path uses it to
   * draw the first branded card ahead of time. Must not throw or block.
   */
  onProductsQueued?: (items: ChosenProduct[]) => void;
  /**
   * The material and the early catalogue search, already started by the
   * caller for this same input (startAnswerLookups). Left out, executeRun
   * starts them itself — in parallel with its prelude.
   */
  lookups?: AnswerLookups;
};



/** A product picture the answer can show: catalogue result, never a data copy. */
export type RunMedia = {
  title: string;
  imageUrl: string;
  price: number | null;
  currency: string | null;
  productUrl: string | null;
  /** The id this product carries in the WhatsApp catalogue, when it's in one. */
  retailerId: string | null;
  /** Shelf name, used to group a catalogue list into sections. */
  category: string | null;
  /** True when this exact product is live in the number's catalogue. */
  inCatalog: boolean;
};


/** How many pictures a single answer is allowed to carry. */
export const MAX_PRODUCT_IMAGES = 5;

/** A product the model chose to send (send_products), with the caption it wrote. */
export type ChosenProduct = RunMedia & { productId: string; caption: string; hasPhoto: boolean };

/**
 * A reply in the model's own order: its words and the products it sent,
 * exactly as it placed them (text written with a send_products call goes
 * before those pictures; the closing text after them).
 */
export type ReplyPart = { kind: "text"; text: string } | { kind: "products"; items: ChosenProduct[] };

/** Where a products part sits in the reply while the guards read it (never sent). */
const PRODUCTS_MARK = "\u2063\u2063\u2063";

/**
 * The one answering rule, on every conversation reply — with material or
 * without it. Helpfulness is never the thing we withhold; only hard facts
 * about this particular business are.
 *
 * The last line is the model's own report of whether it was missing business
 * information. It is stripped from the reply before anything is sent and is
 * only ever used to file a silent row under Unanswered.
 */
export const ANSWER_POLICY =
  "Answer as this business. Use the business material when it exists. For anything else — " +
  "general knowledge, product advice, how-to, small talk, comparisons — answer helpfully from " +
  "your own knowledge in the same tone. NEVER state a price, quantity, stock level, delivery " +
  "date, address or policy detail unless it appears in the material; for those say " +
  "\"Let me confirm that for you\" and continue helping with everything else in the message.\n\n" +
  'End every reply with a final line exactly of the form {"needs_owner": true} or ' +
  '{"needs_owner": false} — true when you were missing business information you needed, false ' +
  "otherwise. Write nothing after that line.";

/** The model's self-report line, and the reply with it taken off. */
export function splitNeedsOwner(text: string): { output: string; needsOwner: boolean } {
  const match = text.match(/\{\s*"?needs_owner"?\s*:\s*(true|false)\s*\}\s*$/i);
  if (!match) return { output: text.trim(), needsOwner: false };
  return {
    output: text.slice(0, match.index).trim(),
    needsOwner: match[1]?.toLowerCase() === "true",
  };
}

/** What we say in place of a fact we can't stand behind. */
const CONFIRM_LINE = "Let me confirm that for you.";

/**
 * Take out the sentences carrying a number the material never mentions, keep
 * everything else the model said, and promise to come back on the rest.
 */
export function stripUnsupported(answer: string, tokens: string[]): string {
  let text = dropSentences(answer, (s) => tokens.some((t) => s.includes(t)));
  for (const token of tokens) text = text.split(token).join("").trim();
  text = text.replace(/[ \t]{2,}/g, " ").trim();
  if (!text) return CONFIRM_LINE;
  return `${text}\n\n${CONFIRM_LINE}`;
}

/** Words that make a sentence a claim about this business's commercial terms. */
const POLICY_TOPIC =
  /\b(pric(e|es|ing)|fees?|charge[sd]?|charging|cost(s|ing)?|markup|mark-up|margin|commission|discounts?|offers?|refunds?|returns?|exchanges?|cancell?ations?|deliver(y|ies|ed)|shipping|ships?|dispatch|warrant(y|ies)|guarantee[sd]?|payments?|pay|emi|cod|cash on delivery|upi|billed|billing|rates?|plans?|subscriptions?|trial|maintenance|servicing|repairs?|polishing|resizing|replacements?|buy-?back|lifelong|lifetime)\b/i;

/**
 * Promise words that turn a policy into a stronger one: "free", "no questions
 * asked", "lifelong". Each must sit in the same source sentence as the policy
 * it is attached to — "20-Day Free Returns" does not make maintenance free.
 */
const POLICY_QUALIFIERS: Array<{ key: string; re: RegExp }> = [
  { key: "no questions asked", re: /\bno[- ]questions?[- ]asked\b/i },
  { key: "free", re: /(?<!feel )\bfree\b|\bno (extra )?(charge|cost|fee)s?\b|\bat no cost\b/i },
  { key: "lifelong", re: /\blife-?long\b|\blifetime\b|\bforever\b|\bno time limit\b/i },
  { key: "unlimited", re: /\bunlimited\b/i },
  { key: "guaranteed", re: /\bguarantee[sd]?\b|\b100 ?%/i },
  { key: "hassle-free", re: /\bhassle[- ]free\b/i },
  { key: "any reason", re: /\b(for )?any reason\b|\bwithout (any )?(reason|questions?)\b/i },
  { key: "full value", re: /\bfull (refund|value|amount)\b|\bmoney[- ]back\b/i },
  { key: "instant", re: /\binstant(ly)?\b|\bsame[- ]day\b/i },
];

/** Split source material into sentences / lines (headings count as their own line). */
function sourcePassages(sources: string): string[] {
  return sources
    .split(/(?<=[.!?])\s+|\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** A crude stem so "returns" meets "Returns" and "return". */
const stemOf = (word: string) => word.toLowerCase().replace(/[^a-z]/g, "").slice(0, 5);

/** Lowercase, drop punctuation, collapse spaces — for "is this sentence in the sources". */
function flat(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export type PolicyWordingCheck = {
  /** Sentences the sources state as written (no model check needed). */
  verbatim: string[];
  /** Sentences carrying a promise word the sources never attach to that policy. */
  unsupported: Array<{ sentence: string; qualifiers: string[]; replacement: string | null }>;
  /** Everything else: left to the model check. */
  undecided: string[];
};

/**
 * Deterministic half of policy grounding. A policy sentence that appears in
 * the retrieved material as written is supported. One that adds a promise
 * word ("free", "no questions asked", "lifelong"…) that no source sentence
 * attaches to the same policy is not — and is replaced by the source's own
 * wording for that policy when a short line exists (e.g. "20-Day Free
 * Returns"), so the customer still gets the true answer.
 */
export function checkPolicyWording(sentences: string[], sources: string): PolicyWordingCheck {
  const passages = sourcePassages(sources);
  const flatSources = flat(sources);
  const out: PolicyWordingCheck = { verbatim: [], unsupported: [], undecided: [] };
  for (const sentence of sentences) {
    const f = flat(sentence);
    if (f.length >= 12 && flatSources.includes(f)) {
      out.verbatim.push(sentence);
      continue;
    }
    const qualifiers = POLICY_QUALIFIERS.filter((q) => q.re.test(sentence));
    const qualifierWords = new Set(
      qualifiers.flatMap((q) => (sentence.match(new RegExp(q.re.source, "gi")) ?? []).flatMap((m) => m.toLowerCase().split(/\W+/))),
    );
    const topicWords = (sentence.match(new RegExp(POLICY_TOPIC.source, "gi")) ?? []).filter(
      (w) => !qualifierWords.has(w.toLowerCase()),
    );
    const topics = Array.from(new Set((topicWords.length ? topicWords : sentence.match(new RegExp(POLICY_TOPIC.source, "gi")) ?? []).map(stemOf)));
    if (!qualifiers.length || !topics.length) {
      out.undecided.push(sentence);
      continue;
    }
    const aboutTopic = (p: string) => {
      const words = p.split(/[^\p{L}]+/u).map(stemOf);
      return topics.some((t) => words.includes(t));
    };
    const missing = qualifiers
      .filter((q) => !passages.some((p) => aboutTopic(p) && q.re.test(p)))
      .map((q) => q.key);
    if (!missing.length) {
      out.undecided.push(sentence);
      continue;
    }
    // The source's own (short) line for each policy the sentence is about
    // that has one ("we offer … returns" → the returns line).
    const lines: string[] = [];
    for (const t of topics) {
      const line = passages
        .filter((p) => p.length <= 140 && p.split(/[^\p{L}]+/u).map(stemOf).includes(t))
        .sort((a, b) => a.length - b.length)[0];
      if (line && !lines.includes(line)) lines.push(line);
    }
    out.unsupported.push({
      sentence,
      qualifiers: missing,
      replacement: lines.length ? lines.map((l) => (/[.!?]$/.test(l) ? l : `${l}.`)).join(" ") : null,
    });
  }
  return out;
}

/** Numbered citation markers ([2], [1, 3], 【2】, [2†source]) are for us, never for a customer. */
export function stripCitationMarkers(text: string): string {
  const stripped = text
    .replace(/\s*\((?:source|see|ref)?:?\s*(?:\[\d{1,3}(?:[^\]\n]{0,20})\]\s*)+\)/gi, "")
    .replace(/[ \t]*(?:\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*(?:†[^\]\n]{0,20})?\]|【\d{1,3}(?:†[^】\n]{0,20})?】)/g, "");
  // Only a reply that carried a marker is tidied (the space it left behind).
  return stripped === text ? text : stripped.replace(/[ \t]+$/gm, "").trim();
}

const UUID = /[ \t]*[([]?\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b[)\]]?/gi;

/**
 * The other ways a source reference leaks into a reply: "Item 6." after the
 * answer, "(Item 2)", "Source: FAQ", "(1)" ending a sentence when the
 * material was numbered that far, a bare document id. Only ever removes; a
 * reply without any comes back exactly as it was. Links are never touched.
 */
export function stripReferenceLeaks(text: string, numberedItems = 0): string {
  const links: string[] = [];
  let t = text.replace(/\bhttps?:\/\/\S+/gi, (u) => {
    links.push(u);
    return `\uE001${links.length - 1}\uE001`;
  });
  const before = t;
  const refWord = "(?:items?|sources?|docs?|documents?|chunks?|refs?|references?)";
  const nums = "#?\\d{1,3}(?:\\s*(?:,|and|&|–|-)\\s*\\d{1,3})*";
  t = t
    // "(Source: About us)", then a bare "Source: …" to the end of its line.
    .replace(/[ \t]*[([]\s*(?:sources?|references?|refs?|citations?)\s*:[^)\]\n]*[)\]]/gi, "")
    .replace(/[ \t]*\b(?:sources?|references?|refs?|citations?)\s*:[^\n]*/gi, "")
    // "(Item 6)", "[Items 2, 3]".
    .replace(new RegExp(`[ \\t]*[([]\\s*${refWord}\\s*${nums}\\s*[)\\]]`, "gi"), "")
    // "Item 6." standing alone as the last words of a sentence or line.
    .replace(new RegExp(`(^|[.!?]["”’)]?[ \\t]+|\\n)[ \\t]*${refWord}\\s*${nums}[ \\t]*[.!]?[ \\t]*(?=\\n|$)`, "gim"), "$1")
    // A bare document id.
    .replace(UUID, "");
  if (numberedItems > 0) {
    // "(2)" or "(1, 3)" ending a sentence — only numbers the material used.
    t = t.replace(/[ \t]*\((\d{1,2}(?:\s*,\s*\d{1,2})*)\)(?=[ \t]*(?:[.,;:!?]|\n|$))/g, (whole, list: string) =>
      list.split(",").every((n) => Number(n) >= 1 && Number(n) <= numberedItems) ? "" : whole,
    );
  }
  if (t === before) return text;
  return t
    .replace(/\uE001(\d+)\uE001/g, (_, i: string) => links[Number(i)] ?? "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Every reference a customer must never see: citation markers, then the other leaks. */
export function stripReferences(text: string, numberedItems = 0): string {
  return stripReferenceLeaks(stripCitationMarkers(text), numberedItems);
}

/** Product types a jewellery / retail shelf is browsed by (word-bounded: "earrings" is not "rings"). */
const SHELF_WORDS =
  /\b(rings?|pendants?|earrings?|bracelets?|necklaces?|chains?|bangles?|anklets?|mangalsutras?|tanmaniyas?|nose ?pins?|studs?|jhumkas?)\b/gi;

/**
 * Sentences that offer a kind of product the catalogue search never returned
 * and the customer never asked about ("want to see pendants instead?" when
 * no pendant was found). Only read when catalog_search ran.
 */
export function unsearchedShelfOffers(answer: string, question: string, toolResults: string[]): string[] {
  const seen = flat(`${question} ${toolResults.join(" ")}`).split(" ");
  const known = (w: string) => {
    const base = w.toLowerCase().replace(/\s+/g, " ").replace(/s$/, "");
    return seen.includes(base) || seen.includes(`${base}s`);
  };
  // Only a sentence about unsearched kinds alone: one that also names what
  // was found ("our rings … pair well with chains") still carries the answer.
  return sentencesOf(answer).filter((s) => {
    const kinds = s.match(SHELF_WORDS) ?? [];
    return kinds.length > 0 && kinds.every((w) => !known(w));
  });
}

/** Split a reply into sentences, keeping the original text of each. */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?\n])\s+/).map((p) => p.trim()).filter(Boolean);
}

/**
 * The text without the sentences `drop` picks, every other sentence and line
 * break exactly where the model put it (a line left empty goes with it).
 */
export function dropSentences(text: string, drop: (sentence: string) => boolean): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const sentences = sentencesOf(line);
    const kept = sentences.filter((s) => !drop(s));
    if (kept.length === sentences.length) {
      out.push(line.replace(/[ \t]+$/, ""));
      continue;
    }
    if (kept.length) out.push(kept.join(" "));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Sentences that talk about pricing, fees, refunds, delivery, warranty or payment. */
export function policyClaimSentences(answer: string): string[] {
  return sentencesOf(answer).filter(
    (s) =>
      POLICY_TOPIC.test(s) &&
      !/let me confirm/i.test(s) &&
      !s.trim().endsWith("?") &&
      // Saying the detail is missing is the honest answer, not a claim.
      !/\b(don'?t|do not|doesn'?t|haven'?t|not) (have|see|find|know|yet|in my|listed|mentioned|covered)\b/i.test(s),
  );
}

/**
 * The reply without any "let me confirm…" sentence (added by the guards or
 * written by the model), line breaks kept. Empty when nothing else was said.
 */
export function withoutConfirmLine(answer: string): string {
  return answer
    .split("\n")
    .map((line) =>
      sentencesOf(line)
        .filter((s) => !/let me confirm/i.test(s))
        .join(" "),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove exact sentences, keep the rest, promise to come back once. */
export function stripSentences(answer: string, drop: string[]): string {
  const set = new Set(drop.map((d) => d.trim()));
  const text = dropSentences(answer, (s) => set.has(s)).replace(/[ \t]{2,}/g, " ").trim();
  if (!text) return CONFIRM_LINE;
  if (text.includes(CONFIRM_LINE)) return text;
  return `${text}\n\n${CONFIRM_LINE}`;
}

/**
 * One small model call judging every candidate sentence against this run's
 * material. Any failure keeps the reply as it is — the check never blocks.
 */
type PolicyCheckWho = {
  organizationId: string;
  agentId: string | null;
  conversationId: string | null;
  actorUserId: string | null;
  actingRole: string | null;
  channel?: RunOptions["channel"];
};

/** The policy check's own run settings, shared by its prelude and the run. */
function policyCheckRun(args: PolicyCheckWho) {
  return {
    organizationId: args.organizationId,
    task: "summarise" as const,
    agentId: args.agentId,
    conversationId: args.conversationId,
    actorUserId: args.actorUserId,
    actingRole: args.actingRole,
    tier: "everyday",
    useKnowledge: false,
    useTools: false,
    billingExempt: true,
    ...(args.channel ? { channel: args.channel } : {}),
    metadata: { purpose: "policy_claim_check" },
  };
}

async function unsupportedPolicyClaims(
  supabase: SupabaseClient,
  args: PolicyCheckWho & {
    sentences: string[];
    sources: string;
    /** The check's reads, started while the answer was being written (speed). */
    prelude?: Promise<RunPrelude>;
    deferUsage?: RunOptions["deferUsage"];
  },
): Promise<string[]> {
  if (!args.sources.trim()) return args.sentences;
  if (!args.sentences.length) return [];
  const numbered = args.sentences.map((s, i) => `${i + 1}. ${s}`).join("\n");
  try {
    const run = await executeRun(supabase, {
      ...policyCheckRun(args),
      ...(args.prelude ? { prelude: args.prelude } : {}),
      ...(args.deferUsage ? { deferUsage: args.deferUsage } : {}),
      system: [
        "You check whether sentences are directly supported by the sources.",
        "A sentence is supported only if the sources state the same thing. Paraphrase is fine; a stronger, different or invented claim (e.g. 'zero markup' when sources say 'a small margin') is NOT supported.",
        'Answer with JSON only: {"answers": ["yes"|"no", ...]} — one entry per numbered sentence, in order.',
      ].join("\n"),
      input: `SOURCES:\n${args.sources.slice(0, 24000)}\n\nSENTENCES:\n${numbered}\n\nIs each sentence directly supported by these sources? yes/no`,
    });
    if (run.status !== "ok" || !run.output.trim()) throw new Error(`check run ${run.status}: ${run.error ?? "empty"}`);
    const raw = run.output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { answers?: unknown[] };
    const answers = Array.isArray(parsed.answers) ? parsed.answers : [];
    return args.sentences.filter((_, i) => String(answers[i] ?? "yes").toLowerCase().startsWith("n"));
  } catch (error) {
    console.log("[policy-grounding] check skipped", error instanceof Error ? error.message : "unknown");
    return [];
  }
}

/**
 * Batch 16: when the policy check finds a claim the material doesn't support,
 * the model is asked once to say the reply again without it — instead of
 * code cutting the sentence out ("20-day no-questions returns hai" went and
 * the reply began "Lekin…"). The reply's text parts (split at the product
 * markers) are rewritten together, in one call, and come back in the same
 * number. Null on any failure: the caller falls back to stripping.
 */
async function rewriteWithoutClaims(
  supabase: SupabaseClient,
  args: PolicyCheckWho & {
    parts: string[];
    claims: string[];
    sources: string;
    question: string;
    prelude?: Promise<RunPrelude>;
    deferUsage?: RunOptions["deferUsage"];
  },
): Promise<string[] | null> {
  try {
    const run = await executeRun(supabase, {
      ...policyCheckRun(args),
      metadata: { purpose: "policy_rewrite" },
      ...(args.prelude ? { prelude: args.prelude } : {}),
      ...(args.deferUsage ? { deferUsage: args.deferUsage } : {}),
      system: [
        "You edit a shop assistant's WhatsApp reply to a customer before it is sent.",
        "Some claims in it are not supported by the shop's material. Rewrite the reply so it no longer makes those claims — not even in other words.",
        "Where a removed claim answered the customer's question, say plainly that you don't have that detail right now. Keep everything else: the same language and script, tone, products, links and length. Never add a new fact, number, price, date or policy.",
        'The reply is given as numbered parts. Answer with JSON only: {"parts": ["...", ...]} — the same number of parts, in order.',
      ].join("\n"),
      input:
        `SHOP MATERIAL:\n${args.sources.slice(0, 16000)}\n\nCUSTOMER ASKED:\n${args.question.slice(0, 500)}\n\n` +
        `UNSUPPORTED CLAIMS:\n${args.claims.map((c) => `- ${c}`).join("\n")}\n\n` +
        `REPLY PARTS:\n${JSON.stringify(args.parts)}`,
    });
    if (run.status !== "ok" || !run.output.trim()) return null;
    const raw = run.output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { parts?: unknown[] };
    const parts = Array.isArray(parsed.parts) ? parsed.parts.map((p) => (typeof p === "string" ? p.trim() : null)) : [];
    if (parts.length !== args.parts.length || parts.some((p) => p === null)) return null;
    // A part that had words must still have words.
    if (parts.some((p, i) => !p && args.parts[i]!.trim())) return null;
    return parts as string[];
  } catch (error) {
    console.log("[policy-grounding] rewrite skipped", error instanceof Error ? error.message : "unknown");
    return null;
  }
}

export type RunResult = {
  runId: string | null;
  status: "ok" | "refused" | "escalated" | "capped" | "error";
  output: string;
  sources: RunSource[];
  toolCalls: {
    tool: string;
    ok: boolean;
    error?: string;
    latencyMs?: number;
    activityLogId?: string | null;
    /** The arguments the model supplied, for debugging tool behaviour. */
    args?: Record<string, unknown>;
    /** Row count and up to five identifiers. Never a data copy. */
    resultSummary?: Record<string, unknown>;
  }[];
  /** Pictures of the products this answer talks about, in the order shown. */
  media: RunMedia[];
  /**
   * Set when the model sent products (send_products): its words and its
   * products, in the order it chose. Absent: the reply is `output` alone.
   */
  parts?: ReplyPart[];

  escalationSignal: string | null;
  /**
   * The answer went out, but something in it needed the owner: a hard fact
   * that isn't in the material, or the model saying so itself. Files a silent
   * row under Unanswered — never a message to the owner.
   */
  needsOwner: boolean;
  /** What the provider charges the platform. Platform-internal, never shown. */
  costAmount: number | null;
  costCurrency: string | null;
  /** What the merchant pays: cost x markup. The only money a merchant sees. */
  billedAmount: number | null;
  billedCurrency: string | null;
  markupMultiplier: number | null;
  costKnown: boolean;
  latencyMs: number;
  /** Platform-internal. */
  provider: string;
  /** Platform-internal. */
  model: string;
  tier: string;
  brainName: string;
  inputTokens: number | null;
  outputTokens: number | null;
  error?: string;
};

// ------------------------------------------------------------------- tiers

/**
 * Merchants pick a tier; the platform decides which model sits behind it.
 * Embeddings are never merchant-visible, so they keep a fixed model.
 */
const DEFAULT_TIER: Record<AiTask, string> = {
  auto_tag: "everyday",
  summarise: "everyday",
  suggest_reply: "everyday",
  agent_reply: "careful",
  embedding: "everyday",
  // Reading only: no answer policy, price/policy guards or escalation.
  extract_facts: "everyday",
};

const EMBEDDING_FALLBACK = { provider: "lovable", model_id: "openai/text-embedding-3-small" };
const TIER_FALLBACK: Record<string, { provider: string; model_id: string; display_name: string }> = {
  everyday: { provider: "lovable", model_id: "google/gemini-3.6-flash", display_name: "Everyday" },
  careful: { provider: "lovable", model_id: "openai/gpt-5.4", display_name: "Careful" },
};

export const EMBEDDING_MODEL = EMBEDDING_FALLBACK.model_id;

type TierRow = {
  key: string;
  display_name: string;
  provider: string;
  model_id: string;
  is_active: boolean;
};

async function loadTier(supabase: SupabaseClient, key: string): Promise<TierRow | null> {
  const { data } = await supabase
    .from("ai_tiers")
    .select("key, display_name, provider, model_id, is_active")
    .eq("key", key)
    .maybeSingle();
  const row = data as TierRow | null;
  return row && row.is_active ? row : null;
}

/** per-task tier -> per-agent tier -> platform default tier, then BYOA override. */
export async function resolveBrain(
  supabase: SupabaseClient,
  organizationId: string,
  task: AiTask,
  agentId?: string | null,
  forcedTier?: string | null,
): Promise<ResolvedBrain> {
  if (task === "embedding") {
    return {
      ...EMBEDDING_FALLBACK,
      tier: "everyday",
      display_name: "Everyday",
      supports_tools: false,
      origin: "platform",
    };
  }

  let tierKey = forcedTier ?? null;
  let origin: ResolvedBrain["origin"] = forcedTier ? "task" : "platform";

  if (!tierKey) {
    const { data: settings } = await supabase
      .from("organization_ai_settings")
      .select("brain_choice")
      .eq("organization_id", organizationId)
      .maybeSingle();
    const manual = (settings as { brain_choice?: string } | null)?.brain_choice === "manual";

    if (manual) {
      const { data: rows } = await supabase
        .from("ai_task_models")
        .select("tier, agent_id")
        .eq("organization_id", organizationId)
        .eq("task", task);
      const list = (rows ?? []) as Array<{ tier: string; agent_id: string | null }>;
      const forAgent = agentId ? list.find((r) => r.agent_id === agentId) : undefined;
      const forOrg = list.find((r) => r.agent_id === null);
      if (forAgent) {
        tierKey = forAgent.tier;
        origin = "task";
      } else if (forOrg) {
        tierKey = forOrg.tier;
        origin = "agent";
      }
    }
  }

  if (!tierKey) {
    tierKey = DEFAULT_TIER[task];
    origin = "platform";
  }

  const tier = (await loadTier(supabase, tierKey)) ?? (await loadTier(supabase, DEFAULT_TIER[task]));
  const resolvedKey = tier?.key ?? DEFAULT_TIER[task];
  const fallback = TIER_FALLBACK[resolvedKey] ?? TIER_FALLBACK["everyday"]!;

  let provider = tier?.provider ?? fallback.provider;
  let modelId = tier?.model_id ?? fallback.model_id;

  // Enterprise bring-your-own-account: an active org provider wins over the
  // platform's model for that vendor. Invisible to ordinary merchants.
  const { data: byoa } = await supabase
    .from("ai_providers")
    .select("provider, model")
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .eq("status", "active")
    .maybeSingle();
  const own = byoa as { provider: string; model: string | null } | null;
  if (own?.model) {
    provider = own.provider;
    modelId = own.model;
    origin = "workspace";
  }

  const { data: model } = await supabase
    .from("ai_models")
    .select("supports_tools, is_available, is_deprecated")
    .eq("provider", provider)
    .eq("model_id", modelId)
    .maybeSingle();
  const m = model as
    | { supports_tools: boolean; is_available: boolean; is_deprecated: boolean }
    | null;

  // A retired or unknown model never reaches the gateway.
  if (!m || !m.is_available || m.is_deprecated) {
    return {
      provider: fallback.provider,
      model_id: fallback.model_id,
      tier: resolvedKey,
      display_name: tier?.display_name ?? fallback.display_name,
      supports_tools: true,
      origin: "platform",
    };
  }

  return {
    provider,
    model_id: modelId,
    tier: resolvedKey,
    display_name: tier?.display_name ?? fallback.display_name,
    supports_tools: m.supports_tools,
    origin,
  };
}

// ------------------------------------------------------------------- money

/** The multiplier this workspace's bills are computed with. */
export async function resolveMarkup(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<number> {
  const { data: org } = await supabase
    .from("organization_ai_settings")
    .select("ai_markup_multiplier")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const negotiated = (org as { ai_markup_multiplier?: number | null } | null)?.ai_markup_multiplier;
  if (typeof negotiated === "number" && negotiated >= 1) return negotiated;

  const { data: platform } = await supabase
    .from("platform_settings")
    .select("ai_markup_multiplier")
    .eq("id", true)
    .maybeSingle();
  const rate = (platform as { ai_markup_multiplier?: number } | null)?.ai_markup_multiplier;
  return typeof rate === "number" && rate >= 1 ? rate : 3;
}

/** What the merchant pays for a run that cost the platform `cost`. */
export function billedFromCost(cost: number | null, markup: number): number | null {
  if (cost === null || Number.isNaN(cost)) return null;
  return Math.round(cost * markup * 1e6) / 1e6;
}

// -------------------------------------------------------------------- keys

/**
 * The gateway key for a provider. Workspace-supplied keys live in Supabase
 * Vault and are read here, server side, by name only — the name is all that is
 * ever stored in a readable table.
 */
async function readVaultSecret(
  supabase: SupabaseClient,
  name: string | null | undefined,
): Promise<string | null> {
  if (!name) return null;
  // The vault schema is not exposed over the data API, so the read goes
  // through a security-definer function in public rather than a table select.
  const { data, error } = await supabase.rpc("read_vault_secret", { p_name: name });
  if (error) {
    console.error("[ai] vault read failed", name, error.message);
    return null;
  }
  return typeof data === "string" && data.length > 0 ? data : null;
}

/**
 * Keys belong to the platform. An organisation only supplies its own when it
 * is on an enterprise bring-your-own-account deal, and that override wins.
 */
async function resolveApiKey(
  supabase: SupabaseClient,
  organizationId: string,
  provider: string,
): Promise<{ key: string | null; base: string; direct: boolean; owner?: "workspace" }> {
  const directBase = DIRECT_ENDPOINTS[provider];
  const vendor = (key: string) =>
    directBase ? { key, base: directBase, direct: true } : { key, base: GATEWAY, direct: false };

  // 1. Organisation override, if this workspace brought its own account.
  const { data: own } = await supabase
    .from("ai_providers")
    .select("vault_secret_name")
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .eq("status", "active")
    .maybeSingle();
  const ownKey = await readVaultSecret(
    supabase,
    (own as { vault_secret_name?: string } | null)?.vault_secret_name,
  );
  // The workspace's own account never falls back onto the platform's backup.
  if (ownKey) return { ...vendor(ownKey), owner: "workspace" as const };

  // 2. Platform credentials, held once for everyone.
  const { data: platform } = await supabase
    .from("platform_ai_providers")
    .select("vault_secret_name, is_active")
    .eq("provider", provider)
    .maybeSingle();
  const row = platform as { vault_secret_name?: string; is_active?: boolean } | null;
  if (row?.is_active !== false) {
    const platformKey = await readVaultSecret(supabase, row?.vault_secret_name);
    if (platformKey) return vendor(platformKey);
  }

  // 3. The platform's own gateway credential.
  if (provider === "lovable") {
    return { key: process.env["LOVABLE_API_KEY"] ?? null, base: GATEWAY, direct: false };
  }
  return { key: null, base: GATEWAY, direct: false };
}

/** The same credential the chat runs use, for non-chat calls (transcription). */
export async function providerCredential(
  supabase: SupabaseClient,
  organizationId: string,
  provider: string,
): Promise<{ key: string | null; base: string; direct: boolean }> {
  return resolveApiKey(supabase, organizationId, provider);
}



// ----------------------------------------------------------------- pricing

async function priceRun(
  supabase: SupabaseClient,
  provider: string,
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): Promise<{ amount: number | null; currency: string | null; source: "rate_card" | "unknown" }> {
  if (inputTokens === null && outputTokens === null) {
    return { amount: null, currency: null, source: "unknown" };
  }
  const { data } = await supabase
    .from("ai_rates")
    .select("input_rate, output_rate, currency")
    .eq("provider", provider)
    .eq("model", model)
    .lte("effective_from", new Date().toISOString().slice(0, 10))
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  const rate = data as { input_rate: number; output_rate: number; currency: string } | null;
  if (!rate) return { amount: null, currency: null, source: "unknown" };
  const amount =
    ((inputTokens ?? 0) * Number(rate.input_rate) + (outputTokens ?? 0) * Number(rate.output_rate)) /
    1_000_000;
  return { amount: Number(amount.toFixed(6)), currency: rate.currency, source: "rate_card" };
}

/**
 * A ceiling that is missing, zero or negative is a misconfiguration, not
 * permission to spend without limit. Both caps below fail closed on it.
 */
export function capIsValid(cap: unknown): boolean {
  const value = Number(cap);
  return Number.isFinite(value) && value > 0;
}

async function overCap(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ over: boolean; cap: number; spent: number; currency: string; misconfigured: boolean }> {
  const { data: settings } = await supabase
    .from("organization_ai_settings")
    .select("ai_monthly_cap_amount, currency")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const s = settings as { ai_monthly_cap_amount: number; currency: string } | null;
  const cap = Number(s?.ai_monthly_cap_amount ?? 0);
  const currency = s?.currency ?? "INR";
  if (!capIsValid(cap)) {
    return { over: true, cap: 0, spent: 0, currency, misconfigured: true };
  }
  const { data: spend } = await supabase.rpc("ai_month_spend", { p_org: organizationId });
  const spent = Number(spend ?? 0);
  return { over: spent >= cap, cap, spent, currency, misconfigured: false };
}

/**
 * Total platform exposure. Per-merchant caps bound each workspace; this bounds
 * the sum of them. There is no "unlimited" setting: an unset or invalid
 * ceiling stops every run until a Super Admin sets a real one.
 */
export async function platformCapState(
  supabase: SupabaseClient,
): Promise<{
  over: boolean;
  warn: boolean;
  cap: number;
  spent: number;
  currency: string;
  misconfigured: boolean;
}> {
  const { data: settings } = await supabase
    .from("platform_settings")
    .select("ai_monthly_cap_amount, ai_cap_currency")
    .eq("id", true)
    .maybeSingle();
  const s = settings as { ai_monthly_cap_amount: number; ai_cap_currency: string } | null;
  const cap = Number(s?.ai_monthly_cap_amount ?? 0);
  const currency = s?.ai_cap_currency ?? "INR";
  const { data: spend } = await supabase.rpc("platform_ai_month_spend");
  const spent = Number(spend ?? 0);
  if (!capIsValid(cap)) {
    return { over: true, warn: true, cap: 0, spent, currency, misconfigured: true };
  }
  return {
    over: spent >= cap,
    warn: spent >= cap * 0.8,
    cap,
    spent,
    currency,
    misconfigured: false,
  };
}

/** Whether a provider is called on the platform's own key or via the gateway. */
export function providerRoute(provider: string): "direct" | "gateway" {
  return DIRECT_ENDPOINTS[provider] ? "direct" : "gateway";
}

const overPlatformCap = platformCapState;

// -------------------------------------------------------------- gateway I/O

type ChatMessage = { role: string; content: unknown; [k: string]: unknown };

type GatewayCall = {
  text: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  inputTokens: number | null;
  outputTokens: number | null;
  raw: unknown;
};

/**
 * Auth headers. The resale gateway wants its own header; a vendor called
 * directly with the platform's own key wants a bearer token.
 */
function gatewayHeaders(key: string, direct = false): Record<string, string> {
  if (direct) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      // Anthropic's OpenAI-compatible endpoint also accepts its native header.
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    };
  }
  return {
    "Content-Type": "application/json",
    "Lovable-API-Key": key,
    "X-Lovable-AIG-SDK": "fetch",
  };
}


/** Human words for a gateway failure. Only 429/5xx are worth retrying. */
export function gatewayErrorMessage(status: number, body: string): string {
  if (status === 402) return "This workspace has run out of AI credit.";
  if (status === 403) {
    // The gateway's 403 is a platform credit limit, not the workspace's AI switch.
    if (/credit_limit|credit limit/i.test(body)) return "The platform's AI credit limit has been reached.";
    return "The AI service refused this request.";
  }
  if (status === 401) return "The AI connection isn't set up correctly.";
  if (status === 429) return "Too many AI requests right now. Try again in a moment.";
  if (status >= 500) return "The AI service is having trouble. Try again in a moment.";
  return body.slice(0, 200) || "The AI couldn't complete that.";
}

/** Chat-completions path — every vendor, gateway or direct. */
async function callChatCompletions(
  base: string,
  key: string,
  model: string,
  messages: ChatMessage[],
  tools: BrokeredTool[],
  direct = false,
): Promise<GatewayCall> {
  const body: Record<string, unknown> = { model, messages };
  // Anthropic's compatible endpoint insists on an explicit output cap.
  if (direct && base.includes("anthropic")) body["max_tokens"] = 4096;
  if (tools.length > 0) {
    body["tools"] = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  const res = await outsideFetch("ai", `${base}/chat/completions`, {
    method: "POST",
    headers: gatewayHeaders(key, direct),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new ProviderHttpError(gatewayErrorMessage(res.status, text), res.status, text);
  }
  const json = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = json.choices?.[0]?.message;
  return {
    text: message?.content ?? "",
    toolCalls: (message?.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      args: safeJson(c.function.arguments),
    })),
    inputTokens: json.usage?.prompt_tokens ?? null,
    outputTokens: json.usage?.completion_tokens ?? null,
    raw: message ?? null,
  };
}

/**
 * Responses path — OpenAI models. Always streamed: these models think for
 * minutes and a buffered request is severed by the platform long before it
 * finishes, while still being billed.
 */
async function callResponses(
  base: string,
  key: string,
  model: string,
  input: unknown[],
  tools: BrokeredTool[],
  direct = false,
): Promise<GatewayCall & { items: unknown[] }> {
  const body: Record<string, unknown> = { model, input, stream: true, store: false };
  if (tools.length > 0) {
    body["tools"] = tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: strictSchema(t.parameters),
      strict: false,
    }));
  }
  // Silence (not total time) is what gives up here: these models think for minutes.
  const res = await outsideFetch(
    "ai_stream",
    `${base}/responses`,
    { method: "POST", headers: gatewayHeaders(key, direct), body: JSON.stringify(body) },
    { idle: true },
  );
  if (!res.ok || !res.body) {
    const text = res.ok ? "" : await res.text();
    throw new ProviderHttpError(gatewayErrorMessage(res.status, text), res.status, text);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: Record<string, unknown> | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload) as Record<string, unknown>;
          if (evt["type"] === "response.completed") {
            completed = evt["response"] as Record<string, unknown>;
          }
        } catch {
          // a partial frame — the next chunk completes it
        }
      }
    }
  }

  if (!completed) throw new ProviderStreamCut();

  const output = (completed["output"] ?? []) as Array<Record<string, unknown>>;
  const text = output
    .filter((i) => i["type"] === "message")
    .flatMap((i) => ((i["content"] ?? []) as Array<Record<string, unknown>>))
    .filter((c) => c["type"] === "output_text")
    .map((c) => String(c["text"] ?? ""))
    .join("")
    .trim();
  const toolCalls = output
    .filter((i) => i["type"] === "function_call")
    .map((i) => ({
      id: String(i["call_id"] ?? i["id"] ?? ""),
      name: String(i["name"] ?? ""),
      args: safeJson(String(i["arguments"] ?? "{}")),
    }));
  const usage = (completed["usage"] ?? {}) as Record<string, number>;

  return {
    text,
    toolCalls,
    inputTokens: usage["input_tokens"] ?? null,
    outputTokens: usage["output_tokens"] ?? null,
    raw: completed,
    items: output,
  };
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The Responses API shape. Only the tool's own required arguments are marked
 * required (tools are sent with strict: false, so nothing forces more): every
 * property marked required made the model fill optional filters it was never
 * asked for — catalog_search went out with gender "female" for "earrings
 * dikhao" and found nothing (Zoori, 6 Oct).
 */
export function strictSchema(schema: BrokeredTool["parameters"]): Record<string, unknown> {
  return {
    type: "object",
    properties: schema.properties ?? {},
    required: schema.required ?? [],
    additionalProperties: false,
  };
}

const isOpenAiModel = (model: string) => model.startsWith("openai/");

/** The Responses API input for a conversation: system, prior turns, then the question. */
function responsesInput(
  system: string,
  history: { role: "user" | "assistant"; content: string }[],
  input: string,
  imageDataUrl: string | null,
): unknown[] {
  const items: unknown[] = [];
  if (system) items.push({ role: "system", content: [{ type: "input_text", text: system }] });
  for (const turn of history) {
    items.push({
      role: turn.role,
      content: [
        turn.role === "assistant"
          ? { type: "output_text", text: turn.content }
          : { type: "input_text", text: turn.content },
      ],
    });
  }
  items.push({
    role: "user",
    content: imageDataUrl
      ? [
          { type: "input_text", text: input },
          { type: "input_image", image_url: imageDataUrl },
        ]
      : [{ type: "input_text", text: input }],
  });
  return items;
}

// ------------------------------------------------------------ backup I/O

/**
 * The same conversation on OpenAI directly (the backup OpenAI key), streamed through
 * the Responses path the platform already uses for OpenAI. Turns taken on the
 * primary are replayed as function_call / function_call_output items.
 */
function openAiBackupConversation(
  route: BackupRoute,
  req: {
    system: string;
    history: { role: "user" | "assistant"; content: string }[];
    input: string;
    imageDataUrl: string | null;
    turns: NeutralTurn[];
    tools: BrokeredTool[];
  },
): BackupConversation {
  const items = responsesInput(req.system, req.history, req.input, req.imageDataUrl);
  for (const turn of req.turns) {
    if (turn.text.trim()) items.push({ role: "assistant", content: [{ type: "output_text", text: turn.text }] });
    for (const c of turn.calls) {
      items.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
    }
    for (const o of turn.outputs) items.push({ type: "function_call_output", call_id: o.id, output: o.output });
  }
  return {
    async step(): Promise<BackupStep> {
      const call = await callResponses(DIRECT_ENDPOINTS["openai"]!, route.key, route.model, items, req.tools, true);
      items.push(...call.items);
      return {
        text: call.text,
        toolCalls: call.toolCalls,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        model: route.model,
      };
    },
    addToolResults(outputs) {
      for (const o of outputs) items.push({ type: "function_call_output", call_id: o.id, output: o.output });
    },
  };
}

/**
 * Cost of a run a backup finished: the primary's tokens (if it got that far)
 * at the primary's rate, plus the backup's at the backup's rate — the rate
 * card first, then the backup list prices. Both amounts go on the run's
 * metadata so the split stays visible.
 */
async function priceWithBackup(
  supabase: SupabaseClient,
  brain: ResolvedBrain,
  primary: { inputTokens: number; outputTokens: number },
  served: { route: BackupRoute; model: string; inputTokens: number; outputTokens: number },
  runMeta: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof priceRun>>> {
  const first =
    primary.inputTokens || primary.outputTokens
      ? await priceRun(supabase, brain.provider, brain.model_id, primary.inputTokens, primary.outputTokens)
      : { amount: 0, currency: null, source: "rate_card" as const };
  let second = await priceRun(supabase, served.route.provider, served.model, served.inputTokens, served.outputTokens);
  let rateSource = "rate_card";
  if (second.source === "unknown" && (served.inputTokens || served.outputTokens)) {
    const rate =
      BACKUP_RATES_INR[`${served.route.provider}:${served.model}`] ??
      BACKUP_RATES_INR[`${served.route.provider}:${served.route.model}`];
    if (rate) {
      const amount = (served.inputTokens * rate.input + served.outputTokens * rate.output) / 1_000_000;
      second = { amount: Number(amount.toFixed(6)), currency: "INR", source: "rate_card" };
      rateSource = "backup_list_price";
    }
  }
  const fallback = (runMeta["fallback"] ?? {}) as Record<string, unknown>;
  runMeta["fallback"] = {
    ...fallback,
    cost_by_provider: { [brain.provider]: first.amount, [served.route.provider]: second.amount },
    backup_rate_source: rateSource,
  };
  const amount =
    first.amount === null && second.amount === null
      ? null
      : Number(((first.amount ?? 0) + (second.amount ?? 0)).toFixed(6));
  return {
    amount,
    currency: second.currency ?? first.currency,
    source: first.source === "rate_card" && second.source === "rate_card" ? "rate_card" : "unknown",
  };
}

// -------------------------------------------------------------- embeddings

/** Rupees per million embedding tokens. Platform-internal. */
const EMBED_RUPEES_PER_M = 2;

/**
 * Add one piece of work to a workspace's running total for the day. Used by
 * the paths that don't create a run record of their own — reading a website,
 * and turning text into numbers for search.
 */
export async function meterAiUsage(
  supabase: SupabaseClient,
  organizationId: string,
  task: string,
  amounts: { costAmount?: number; inputTokens?: number; outputTokens?: number; runs?: number },
): Promise<void> {
  const usageDate = new Date().toISOString().slice(0, 10);
  // Added in the database in one statement (ai_usage_add, migration
  // 20261027): read-add-write lost one of two concurrent additions, so the
  // caps under-counted. Until it is applied, the old way below.
  if (Date.now() >= aiUsageAddMissingUntil) {
    const { error } = await supabase.rpc("ai_usage_add", {
      p_org: organizationId,
      p_usage_date: usageDate,
      p_task: task,
      p_runs: amounts.runs ?? 1,
      p_input_tokens: amounts.inputTokens ?? 0,
      p_output_tokens: amounts.outputTokens ?? 0,
      p_cost_amount: amounts.costAmount ?? 0,
    });
    if (!error) return;
    const code = String((error as { code?: string }).code ?? "");
    if (code === "PGRST202" || code === "42883") aiUsageAddMissingUntil = Date.now() + 10 * 60_000;
    else console.warn(JSON.stringify({ scope: "ai_usage_add", task, error: error.message }));
  }
  const { data } = await supabase
    .from("ai_usage")
    .select("id, runs, input_tokens, output_tokens, cost_amount")
    .eq("organization_id", organizationId)
    .eq("usage_date", usageDate)
    .eq("task", task)
    .maybeSingle();
  const prior = data as {
    id: string;
    runs: number;
    input_tokens: number;
    output_tokens: number;
    cost_amount: number;
  } | null;

  const row = {
    organization_id: organizationId,
    usage_date: usageDate,
    task,
    runs: Number(prior?.runs ?? 0) + (amounts.runs ?? 1),
    input_tokens: Number(prior?.input_tokens ?? 0) + (amounts.inputTokens ?? 0),
    output_tokens: Number(prior?.output_tokens ?? 0) + (amounts.outputTokens ?? 0),
    cost_amount: Number(prior?.cost_amount ?? 0) + (amounts.costAmount ?? 0),
    updated_at: new Date().toISOString(),
  };

  if (prior) await supabase.from("ai_usage").update(row).eq("id", prior.id);
  else await supabase.from("ai_usage").insert(row);
}
/** Set while ai_usage_add() isn't in the database yet; looked for again after 10 minutes. */
let aiUsageAddMissingUntil = 0;

/**
 * The OpenAI key for the embeddings backup: the platform's OpenAI key from the
 * vault (Platform providers), else OPENAI_API_KEY. Read only when the gateway
 * can't serve, never on a healthy call; null when neither exists.
 */
async function embeddingBackupKey(supabase?: SupabaseClient): Promise<string | null> {
  try {
    const client = supabase ?? (await import("@/lib/whatsapp-webhook.server")).getServiceClient();
    const platform = await loadPlatformBackup(client);
    if (platform.openaiKey) return platform.openaiKey;
  } catch {
    // No service client here (tests, scripts): the env key still applies.
  }
  return process.env["OPENAI_API_KEY"] || null;
}

/**
 * One embedding request: the gateway first, exactly as before. Only when it
 * is out of credit, over quota, failing or unreachable — and a backup OpenAI
 * key exists — is the same model asked directly. Throws the gateway's error otherwise.
 */
async function embedBatch(
  key: string | null,
  backupKey: () => Promise<string | null>,
  batch: string[],
): Promise<Response> {
  let openAiKey: string | null = null;
  let failure: unknown = null;
  if (key) {
    try {
      const res = await outsideFetch("embeddings", `${GATEWAY}/embeddings`, {
        method: "POST",
        headers: gatewayHeaders(key),
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
      });
      if (res.ok) return res;
      const text = await res.text();
      failure = new ProviderHttpError(gatewayErrorMessage(res.status, text), res.status, text);
    } catch (error) {
      failure = error;
    }
    if (!outageOf(failure)) throw failure;
    openAiKey = await backupKey();
    if (!openAiKey) throw failure;
    console.error("[ai] embeddings: gateway unavailable, using OpenAI directly", failure instanceof Error ? failure.message : "");
  } else {
    openAiKey = await backupKey();
  }
  const res = await outsideFetch("embeddings", `${DIRECT_ENDPOINTS["openai"]}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${openAiKey}` },
    body: JSON.stringify({ model: wireModel("openai", EMBEDDING_MODEL), input: batch }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ProviderHttpError(gatewayErrorMessage(res.status, text), res.status, text);
  }
  return res;
}

/** The only embedding call in the codebase. Returns one vector per input. */
export async function embedTexts(
  texts: string[],
  meter?: { supabase: SupabaseClient; organizationId: string },
): Promise<number[][]> {
  const key = process.env["LOVABLE_API_KEY"];
  // The only embedding backup is OpenAI's own text-embedding-3-small: the
  // model the gateway serves, so vectors stay comparable with the stored ones.
  // Anthropic has no embeddings, so with only an Anthropic backup key,
  // embeddings stay on the gateway. The backup key is looked up once, and
  // only if the gateway can't serve.
  let backup: Promise<string | null> | null = null;
  const backupKey = () => (backup ??= embeddingBackupKey(meter?.supabase));
  if (!key && !(await backupKey())) throw new Error("AI isn't connected on this deployment.");
  const out: number[][] = [];
  // The gateway caps batch size; 64 keeps every request comfortably inside it.
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const res = await embedBatch(key ?? null, backupKey, batch);
    const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    for (const row of json.data ?? []) out.push(row.embedding);

    if (meter) {
      const tokens = Math.ceil(batch.reduce((sum, t) => sum + t.length, 0) / 4);
      await meterAiUsage(meter.supabase, meter.organizationId, "embedding", {
        inputTokens: tokens,
        costAmount: (tokens / 1_000_000) * EMBED_RUPEES_PER_M,
      });
    }
  }
  return out;
}


// --------------------------------------------------------------- the run

/** Kill switches that apply to this run (workspace AI switch and spending cap). */
function workspaceGatesApply(options: Pick<RunOptions, "channel" | "preview" | "billingExempt" | "metadata">): boolean {
  // Merchant onboarding chats are paid by the platform, so workspace AI kill
  // switches (ai_enabled, per-org cap) do not apply. The platform cap still does.
  const isMerchantOnboarding = options.channel === "onboarding";
  const isAdminPreview = options.preview === true && options.billingExempt === true;
  // Reading the merchant's own material (page facts, pictures) is platform-paid
  // and must work whatever the workspace's AI mode is: off / draft / replying.
  const purpose = String((options.metadata as Record<string, unknown> | undefined)?.["purpose"] ?? "");
  const isKnowledgeReading =
    options.billingExempt === true &&
    (purpose.startsWith("knowledge_") || purpose === "policy_claim_check" || purpose === "policy_rewrite");
  return !isMerchantOnboarding && !isAdminPreview && !isKnowledgeReading;
}

/**
 * Everything a run reads before it may think: brain, markup, kill switches,
 * spending caps, the key, the shelf and the tools. None of these reads needs
 * another (only the key needs the brain), so they are read together — they
 * used to be about twenty round trips in a row. Read-only; executeRun still
 * applies every check in the same order before anything is spent. The inbound
 * webhook starts this during the burst wait (see ai-agent.server.ts).
 */
export type RunPrelude = {
  brain: ResolvedBrain;
  markup: number;
  /** null when the workspace switches don't apply to this run. */
  aiEnabled: boolean | null;
  cap: Awaited<ReturnType<typeof overCap>> | null;
  platformCap: Awaited<ReturnType<typeof platformCapState>>;
  api: Awaited<ReturnType<typeof resolveApiKey>>;
  productCount: number;
  tools: BrokeredTool[];
};

/**
 * The prelude, plus two of its reads on their own: the tools this run may
 * call and the visible product count. The early catalogue search starts on
 * them while the rest of the prelude (brain, key, caps) is still being read.
 */
export type PreludeRead = Promise<RunPrelude> & {
  toolsReady?: Promise<BrokeredTool[]>;
  productsReady?: Promise<number>;
};

export function prepareRun(
  supabase: SupabaseClient,
  options: Pick<
    RunOptions,
    "organizationId" | "task" | "agentId" | "tier" | "useTools" | "principal" | "actorUserId" | "channel" | "preview" | "billingExempt" | "metadata"
  >,
): PreludeRead {
  const { organizationId, task } = options;
  const gates = workspaceGatesApply(options);
  const principal: ToolPrincipal =
    options.principal ?? (options.actorUserId ? userPrincipal(options.actorUserId) : agentPrincipal);
  const brain = resolveBrain(supabase, organizationId, task, options.agentId ?? null, options.tier ?? null);
  const productCount: Promise<number> =
    task === "agent_reply"
      ? Promise.resolve(
          supabase
            .from("products")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", organizationId)
            .eq("is_visible", true),
        ).then(({ count }) => count ?? 0)
      : Promise.resolve(0);
  const tools: Promise<BrokeredTool[]> = options.useTools
    ? brokerTools(supabase, organizationId, principal)
    : Promise.resolve([] as BrokeredTool[]);
  productCount.catch(() => {});
  tools.catch(() => {});
  const prelude = Promise.all([
    brain,
    resolveMarkup(supabase, organizationId),
    gates
      ? Promise.resolve(
          supabase.from("organization_ai_settings").select("ai_enabled").eq("organization_id", organizationId).maybeSingle(),
        ).then(({ data }) => Boolean((data as { ai_enabled?: boolean } | null)?.ai_enabled))
      : null,
    gates ? overCap(supabase, organizationId) : null,
    overPlatformCap(supabase),
    brain.then((b) => resolveApiKey(supabase, organizationId, b.provider)),
    productCount,
    tools,
  ]).then(([b, markup, aiEnabled, cap, platformCap, api, productCount, tools]) => ({
    brain: b,
    markup,
    aiEnabled,
    cap,
    platformCap,
    api,
    productCount,
    tools,
  }));
  // Awaited by executeRun; a failure surfaces there, never as an unhandled rejection.
  prelude.catch(() => {});
  return Object.assign(prelude, { toolsReady: tools, productsReady: productCount });
}

const ESCALATION_TOPICS = [
  "refund",
  "return money",
  "chargeback",
  "complaint",
  "cancel my order",
  "cancel order",
  "legal",
  "police",
  "fraud",
];

function topicNeedsHuman(question: string, extraRules: string): string | null {
  const q = question.toLowerCase();
  for (const topic of ESCALATION_TOPICS) {
    if (q.includes(topic)) return "sensitive_topic";
  }
  const rules = extraRules
    .toLowerCase()
    .split(/[\n,]/)
    .map((r) => r.trim())
    .filter((r) => r.length > 2);
  for (const rule of rules) {
    if (q.includes(rule)) return "merchant_rule";
  }
  return null;
}

/** One matched piece of the business's material, as match_knowledge_chunks returns it. */
export type KnowledgeRow = {
  document_id: string;
  source_type: string;
  source_name: string;
  source_ref: string;
  title: string;
  text: string;
  similarity: number;
};

/** The question's matches, and a way to look again with the same vector. */
export type KnowledgeMatch = { rows: KnowledgeRow[]; again: () => Promise<KnowledgeRow[]> };

/**
 * Embeds the question and matches it against the business's material —
 * reads only (the embedding is never metered to the workspace). Null when
 * there is no vector. The on-demand page read when nothing matched stays in
 * executeRun, after the run's gates.
 */
export function matchKnowledge(
  supabase: SupabaseClient,
  args: { organizationId: string; agentId: string | null; input: string; merchantChannel: boolean },
): Promise<KnowledgeMatch | null> {
  const read = embedTexts([args.input]).then(async ([vector]) => {
    if (!vector) return null;
    // The owner's own chat asks broad questions ("what is the price?")
    // against a small, fresh crawl, so it reaches a little further down.
    const again = async () => {
      const { data } = await supabase.rpc("match_knowledge_chunks", {
        p_org: args.organizationId,
        p_embedding: JSON.stringify(vector),
        p_embedding_model: EMBEDDING_MODEL,
        p_agent: args.agentId,
        p_limit: 6,
        p_min_similarity: args.merchantChannel ? 0.25 : 0.35,
      });
      return (data ?? []) as KnowledgeRow[];
    };
    return { rows: await again(), again };
  });
  read.catch(() => {});
  return read;
}

/**
 * What an answer reads besides the prelude — the business's material and the
 * early catalogue search — started together, never one after the other.
 * The inbound webhook starts them once the gate passed (ai-agent.server.ts);
 * any other run starts them at the top of executeRun.
 */
export type AnswerLookups = {
  knowledge?: Promise<KnowledgeMatch | null> | null;
  early?: Promise<EarlySearch | null> | null;
};

export function startAnswerLookups(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    agentId: string | null;
    input: string;
    prelude: PreludeRead;
    conversationId?: string | null;
    contactId?: string | null;
    /** Whose permissions the search runs under (the run's own); the agent when left out. */
    principal?: ToolPrincipal;
    actorUserId?: string | null;
    knowledge: boolean;
    early: boolean;
  },
): AnswerLookups {
  const early = args.early
    ? import("@/lib/early-search.server").then(({ earlyCatalogSearch }) =>
        earlyCatalogSearch(supabase, {
          organizationId: args.organizationId,
          input: args.input,
          tools: args.prelude.toolsReady ?? args.prelude.then((p) => p.tools),
          visibleProducts: args.prelude.productsReady ?? args.prelude.then((p) => p.productCount),
          subject: toolSubject({ conversationId: args.conversationId ?? null, contactId: args.contactId ?? null }),
          principal: args.principal ?? agentPrincipal,
          actorUserId: args.actorUserId ?? null,
          smallTalk: isSmallTalk(args.input),
        }),
      )
    : null;
  early?.catch(() => {});
  return {
    knowledge: args.knowledge
      ? matchKnowledge(supabase, {
          organizationId: args.organizationId,
          agentId: args.agentId,
          input: args.input,
          merchantChannel: false,
        })
      : null,
    early,
  };
}

/** A request the provider refused as malformed (not an outage). */
function refusedRequest(error: unknown): boolean {
  return error instanceof ProviderHttpError && (error.status === 400 || error.status === 422);
}

export async function executeRun(
  supabase: SupabaseClient,
  options: RunOptions & { prelude?: PreludeRead },
): Promise<RunResult> {
  const started = Date.now();
  const {
    organizationId,
    task,
    input,
    agentId = null,
    conversationId = null,
    contactId = null,
    actorUserId = null,
    actingRole = null,
    comparisonId = null,
    useTools = false,
    useKnowledge = false,
    history = [],
    maxSteps = 4,
  } = options;

  const preludeRead = options.prelude ?? prepareRun(supabase, options);
  // The material and the early catalogue search run alongside the prelude
  // (and alongside each other), never after it. A live customer answer only:
  // the owner's chat, a picture being read and page reading never search early.
  const earlyWanted =
    task === "agent_reply" &&
    useTools &&
    options.channel !== "onboarding" &&
    !options.imageDataUrl &&
    !String((options.metadata as Record<string, unknown> | undefined)?.["purpose"] ?? "").startsWith("knowledge_");
  const lookups: AnswerLookups = {
    knowledge: useKnowledge
      ? (options.lookups?.knowledge ??
        matchKnowledge(supabase, {
          organizationId,
          agentId,
          input,
          merchantChannel: options.channel === "onboarding",
        }))
      : null,
    early: earlyWanted
      ? (options.lookups?.early ??
        startAnswerLookups(supabase, {
          organizationId,
          agentId,
          input,
          prelude: preludeRead,
          conversationId,
          contactId,
          principal: options.principal ?? (actorUserId ? userPrincipal(actorUserId) : agentPrincipal),
          actorUserId,
          knowledge: false,
          early: true,
        }).early ??
        null)
      : null,
  };
  let knowledgeSettled = false;
  lookups.knowledge?.then(
    () => (knowledgeSettled = true),
    () => (knowledgeSettled = true),
  );
  const prelude = await preludeRead;
  const { brain, markup } = prelude;
  // Where the time went, kept on the ai_runs row (metadata.timing_ms).
  const timing: Record<string, number> = { prelude: Date.now() - started };

  const base: RunResult = {
    runId: null,
    status: "ok",
    output: "",
    sources: [],
    toolCalls: [],
    media: [],
    escalationSignal: null,
    needsOwner: false,
    costAmount: null,
    costCurrency: null,
    billedAmount: null,
    billedCurrency: null,
    markupMultiplier: markup,
    costKnown: false,
    latencyMs: 0,
    provider: brain.provider,
    model: brain.model_id,
    tier: brain.tier,
    brainName: brain.display_name,
    inputTokens: null,
    outputTokens: null,
  };

  // Extra review data written alongside the caller's metadata.
  // metadata.provider: who actually answered (a backup overrides it below).
  const runMeta: Record<string, unknown> = { timing_ms: timing, provider: brain.provider };
  const finish = async (result: RunResult): Promise<RunResult> => {
    result.latencyMs = Date.now() - started;
    // Platform-paid runs (the owner's onboarding chat) must never reach the
    // wallet: the billing trigger fires on billed_amount, so zero means free.
    if (options.billingExempt) result.billedAmount = 0;
    if (options.dryRun) return result;

    const { data } = await supabase
      .from("ai_runs")
      .insert({
        organization_id: organizationId,
        agent_id: agentId,
        conversation_id: conversationId,
        contact_id: contactId,
        user_id: actorUserId,
        acting_role: actingRole,
        provider: result.provider,
        model: result.model,
        tier: result.tier,
        task,
        input_summary: input.slice(0, 500),
        output: result.output.slice(0, 8000),
        escalation_signal: result.escalationSignal,
        sources: result.sources,
        tool_call_count: result.toolCalls.length,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_amount: result.costAmount,
        cost_currency: result.costCurrency,
        cost_source: result.costKnown ? "rate_card" : "unknown",
        billed_amount: result.billedAmount,
        billed_currency: result.billedCurrency,
        markup_multiplier: result.markupMultiplier,
        latency_ms: result.latencyMs,
        status: result.status,
        error: result.error ?? null,
        comparison_id: comparisonId,
        metadata: {
          ...(options.metadata ?? {}),
          ...runMeta,
          ...(result.toolCalls.length ? { tools: runToolsMeta(result.toolCalls) } : {}),
        },

        prompt_rules_version: options.promptRulesVersion ?? null,

      })
      .select("id")
      .maybeSingle();
    result.runId = (data as { id?: string } | null)?.id ?? null;
    if (result.runId) {
      // One row per tool invocation, written through a strict database function.
      // A run must never claim tool usage without the matching trace rows.
      if (result.toolCalls.length) {
        const traces = result.toolCalls.map((call) => ({
          tool_name: call.tool,
          ok: call.ok,
          error: call.error ?? null,
          latency_ms: call.latencyMs ?? null,
          activity_log_id: call.activityLogId ?? null,
          arguments: call.args ?? {},
          result_summary: call.resultSummary ?? {},
        }));
        const { data: written, error: traceError } = await supabase.rpc("record_ai_tool_calls", {
          p_run_id: result.runId,
          p_organization_id: organizationId,
          p_calls: traces,
        });
        if (traceError || Number(written) !== traces.length) {
          throw new Error(
            `I used ${traces.length} tool${traces.length === 1 ? "" : "s"}, but I couldn't save the work record. Please retry this request.`,
          );
        }
      }
      const usage = rollUpUsage(supabase, organizationId, task, result);
      if (options.deferUsage) options.deferUsage(usage);
      else await usage;
    }
    return result;
  };

  // ------------------------------------------------------------ kill switch
  // (see workspaceGatesApply: onboarding chats, admin previews and reading the
  // merchant's own material skip the workspace switches; the platform cap never).
  const purpose = String((options.metadata as Record<string, unknown> | undefined)?.["purpose"] ?? "");
  if (workspaceGatesApply(options)) {
    if (!prelude.aiEnabled) {
      return finish({
        ...base,
        status: "refused",
        output: "",
        error: "AI is switched off for this workspace.",
      });
    }

    const cap = prelude.cap ?? (await overCap(supabase, organizationId));
    if (cap.over) {
      return finish({
        ...base,
        status: "capped",
        output: "",
        error: cap.misconfigured
          ? "This workspace has no valid monthly spending limit set, so I've stopped rather than spend without one. Set a limit above zero and I'll carry on."
          : `This month's AI spending limit (${cap.currency} ${cap.cap}) has been reached.`,
      });
    }
  }

  // Every workspace can be inside its own limit while the platform as a whole
  // is not. The ceiling below is the platform's, set by the Super Admin.
  const platformCap = prelude.platformCap;
  if (platformCap.over) {
    return finish({
      ...base,
      status: "capped",
      output: "",
      error: platformCap.misconfigured
        ? "I've hit this month's limit. The platform has no valid monthly ceiling set, so nothing runs until the platform team sets one."
        : `This month's AI spending limit (${platformCap.currency} ${platformCap.cap}) has been reached.`,
    });
  }

  const { key, base: apiBase, direct } = prelude.api;
  const wire = direct ? wireModel(brain.provider, brain.model_id) : brain.model_id;

  // No key and no backup: stop before anything is read or spent, as before.
  if (!key && (prelude.api.owner === "workspace" || (await platformBackupRoutes(supabase, brain.tier)).length === 0)) {
    return finish({
      ...base,
      status: "error",
      error: `My "${brain.display_name}" setup has no working connection behind it, so I couldn't think at all. This isn't a bad answer — it's a broken connection. Ask the platform team to check the key for this setup.`,
    });
  }

  // ---------------------------------------------------- early catalogue
  // Started with the prelude; usually done by now. Its results reach the
  // model only when they fit the customer's words (early-search.server.ts)
  // and this run really offers catalog_search on a catalogue with products.
  const earlyWaitStarted = Date.now();
  const early = lookups.early ? await lookups.early.catch(() => null) : null;
  if (lookups.early) timing["early_search"] = Date.now() - earlyWaitStarted;
  const earlyFits = Boolean(
    early?.usable &&
      early.result &&
      prelude.productCount > 0 &&
      prelude.tools.some((t) => t.name === "catalog_search"),
  );
  // A pure product browse: products found for the customer's own words, and
  // no question about a figure (price, time, how much) or a policy. Only then
  // may the website's material be left out when it isn't ready yet.
  const pureBrowse =
    earlyFits && !input.includes("?") && !POLICY_TOPIC.test(input) && !asksForFigure(input);

  // ------------------------------------------------------------- knowledge
  const retrievalStarted = Date.now();
  const sources: RunSource[] = [];
  let knowledgeBlock = "";
  if (useKnowledge && lookups.knowledge) {
    try {
      const isMerchantChannel = options.channel === "onboarding";
      let rows: KnowledgeRow[] = [];
      if (pureBrowse && !knowledgeSettled) {
        // Still being read: a browse answer doesn't wait for it.
        runMeta["retrieval"] = "skipped_browse";
      } else {
        runMeta["retrieval"] = knowledgeSettled ? "ready" : "waited";
        const matched = await lookups.knowledge;
        if (matched) {
          rows = matched.rows;
          // Nothing known: read one matching unread page of the site, then
          // look again (never for a browse the catalogue already answered).
          if (!rows.length && !pureBrowse && !isMerchantChannel && conversationId && options.billingExempt !== true) {
            const { readOnDemand } = await import("@/lib/knowledge.server");
            if (await readOnDemand(supabase, organizationId, conversationId, input)) rows = await matched.again();
          }
        }
      }
      if (isMerchantChannel) {
        console.log(
          "[merchant-retrieval]",
          organizationId,
          JSON.stringify(input).slice(0, 120),
          rows
            .slice(0, 6)
            .map((r) => `${(r.title || r.source_name || "?").slice(0, 40)}=${Number(r.similarity).toFixed(3)}`)
            .join(" | ") || "no candidates above 0.25",
        );
      }
      for (const row of rows) {
        sources.push({
          kind: "knowledge",
          label: row.title || row.source_name,
          ref: row.source_ref,
          similarity: Number(row.similarity),
          sourceType: row.source_type,
          documentId: row.document_id,
        });
      }
      knowledgeBlock = rows
        .map((r, i) => {
          const url = /^https?:\/\//i.test(r.source_ref ?? "") ? `${r.source_ref}\n` : "";
          return `[${i + 1}] ${r.title || r.source_name}\n${url}${r.text}`;
        })
        .join("\n\n");

      // Something the merchant wrote themselves counts as used, so they can
      // see their corrections doing work.
      const taught = rows
        .filter((r) => r.source_type === "manual_qa")
        .map((r) => r.document_id);
      if (taught.length) {
        // Awaited: on the merchant channel the handler finishes before a
        // fire-and-forget request leaves the worker, so the count never moved.
        await supabase.rpc("record_knowledge_use", {
          p_org: organizationId,
          p_document_ids: taught,
        });
      }
    } catch {
      // Retrieval failing is itself a reason to hand over, handled below.
    }
  }

  timing["retrieval"] = Date.now() - retrievalStarted;

  // -------------------------------------------------------------- messages
  const systemParts = [options.system ?? ""];
  if (knowledgeBlock) {
    // The owner's own chat reads better with a plain-words source line. A
    // customer never sees where an answer came from: no numbers, no sources.
    const citation =
      options.channel === "onboarding"
        ? "After the answer, add one short line in plain words saying which page it came from, using the page title (e.g. 'From your Features page'). Never output [n] markers."
        : "The items are numbered for you only: never mention an item number, a source, a page title as a source, or brackets in your reply.";
    // A shopper wants the product page; a policy or blog page linked in every
    // reply is just noise.
    const linkRule =
      "Some items show a URL on the line under their title. If the item you used is a product page " +
      "(its URL contains /products/), end your answer with that URL on its own last line, copied " +
      "character for character, and nothing after it. For any other kind of page, do not output a URL at all.";
    systemParts.push(
      `Material from this business follows. Prefer it over anything else you know. ${citation} ${linkRule}\n\n` +
        knowledgeBlock,
    );

  }
  // The house rule: always be useful, never invent a hard fact. Applies with
  // or without material, so a question with no match still gets an answer.
  if (task === "agent_reply") {
    // A shop with a real shelf must be browsed, not guessed at.
    if (prelude.productCount > 0) {
      systemParts.push(
        "This business has a product catalogue; for any browse/choose request call catalog_search before answering. " +
          "When the customer names or asks about a particular product, look it up with catalog_search (query = its name) and use its fields (category, metal, stones, weight, price, link).",
      );
    }
    if (options.channel !== "onboarding" && prelude.tools.some((t) => t.name === "send_products")) {
      systemParts.push(
        "Product pictures: nothing is attached for you. A product reaches the customer only when you call send_products with its product_id and the caption you want under its picture — write captions the way this business's instructions ask. " +
          "Text you write in the same turn as send_products goes before the pictures; your final reply goes after them. Quote prices exactly as the search gives them (whole rupees).",
      );
    }
    systemParts.push(ANSWER_POLICY);
  }
  const system = systemParts.filter(Boolean).join("\n\n");

  const principal: ToolPrincipal =
    options.principal ?? (actorUserId ? userPrincipal(actorUserId) : agentPrincipal);
  const subject = toolSubject({ channel: options.channel, conversationId, contactId });

  // Pictures only reach a customer from a live answer; the owner's own chat
  // and a teammate's draft carry words alone, so they never offer them.
  const tools =
    task === "agent_reply" && options.channel !== "onboarding"
      ? prelude.tools
      : prelude.tools.filter((t) => t.name !== "send_products");
  const modelStarted = Date.now();
  // A customer answer may need the policy-claim check afterwards; its own
  // reads (brain, key, caps) run while this answer is being written instead
  // of after it. Reads only — unused when the answer makes no policy claim.
  const policyCheckWho: PolicyCheckWho = {
    organizationId,
    agentId,
    conversationId,
    actorUserId,
    actingRole,
    ...(options.channel ? { channel: options.channel } : {}),
  };
  const policyCheckPrelude =
    task === "agent_reply" && !options.imageDataUrl && !options.dryRun && !purpose.startsWith("knowledge_")
      ? prepareRun(supabase, policyCheckRun(policyCheckWho))
      : undefined;

  const toolCalls: RunResult["toolCalls"] = [];
  const foundMedia: RunMedia[] = [];
  /** Everything a tool actually returned this run — used by the number guard. */
  const toolResultTexts: string[] = [];
  let anyToolFailed = false;

  let inputTokens = 0;
  let outputTokens = 0;
  let answer = "";
  /** The model's words and products in its own order, once it sends products. */
  const segments: Array<{ kind: "text"; text: string } | { kind: "products"; items: ChosenProduct[] }> = [];
  /** The text of the model's last turn that called no tool (what follows the pictures). */
  let closingText = "";
  /** Each chosen product's facts, the support its caption's numbers are checked against. */
  const chosenFacts: string[] = [];

  /**
   * Runs one turn's tool calls in order; returns what the model sees of each.
   * A turn that sends products keeps its own words, just before them.
   */
  /** Records one tool call and its result; returns what the model sees of it. */
  const recordToolCall = (
    tc: { id: string; name: string; args: Record<string, unknown> },
    result: Awaited<ReturnType<typeof runTool>>,
    chosen: Array<ChosenProduct & { facts: unknown }>,
  ): string => {
    // A product id the model got wrong is answered to the model (it can
    // try again); it is not a broken tool.
    if (!result.ok && tc.name !== "send_products") anyToolFailed = true;
    toolCalls.push({
      tool: tc.name,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(typeof result.latencyMs === "number" ? { latencyMs: result.latencyMs } : {}),
      activityLogId: result.activityLogId ?? null,
      args: result.arguments ?? {},
      resultSummary: result.resultSummary ?? {},
    });
    sources.push({ kind: "tool", label: tc.name });
    collectProductMedia(tc.name, result, foundMedia);
    const picked = tc.name === "send_products" ? chosenProducts(result) : [];
    chosen.push(...picked);
    chosenFacts.push(...picked.map((p) => JSON.stringify(p.facts)));
    const view = toolView(tc.name, result);
    // A caption the model wrote is not support for anything it says.
    if (tc.name !== "send_products") toolResultTexts.push(view);
    return view;
  };

  /**
   * Runs one turn's tool calls in order; returns what the model sees of each.
   * A turn that sends products keeps its own words, just before them. When
   * the turn only sent products (all of them real) and gave its closing
   * words with them, `closing` is those words: the reply is complete and the
   * model is not asked again.
   */
  const runToolCalls = async (
    calls: { id: string; name: string; args: Record<string, unknown> }[],
    turnText = "",
  ): Promise<{ views: string[]; closing: string | null }> => {
    const views: string[] = [];
    const chosen: Array<ChosenProduct & { facts: unknown }> = [];
    let complete = calls.length > 0;
    for (const tc of calls) {
      const result = await runTool(
        supabase,
        organizationId,
        actorUserId,
        principal,
        tc.name,
        tc.args,
        subject,
        tools,
      );
      views.push(recordToolCall(tc, result, chosen));
      const skipped = (result.data as { skipped?: unknown[] } | undefined)?.skipped;
      if (tc.name !== "send_products" || !result.ok || (Array.isArray(skipped) && skipped.length > 0)) complete = false;
    }
    if (chosen.length > 0) {
      if (turnText.trim()) segments.push({ kind: "text", text: turnText });
      const items = chosen.map(({ facts: _facts, ...item }) => item);
      segments.push({ kind: "products", items });
      try {
        options.onProductsQueued?.(items);
      } catch {
        // a head start only; never the run's problem
      }
    }
    const closing = complete
      ? (calls.map((c) => c.args["closing"]).find((c): c is string => typeof c === "string" && c.trim().length > 0) ?? null)
      : null;
    return { views, closing };
  };

  // ------------------------------------------------- early search, given
  // The early search, as if the model had called catalog_search with the
  // customer's own words: the call and its result open the conversation, so
  // the first model call can already send products and close. It is only
  // counted (trace, sources, number guard) once the provider accepted it.
  const earlyCall =
    earlyFits && early?.result
      ? { id: EARLY_CALL_ID, name: "catalog_search", args: early.args, result: early.result }
      : null;
  const earlyView = earlyCall ? toolView("catalog_search", earlyCall.result) : "";
  let earlyGiven = false;
  let earlyRefused = false;
  const giveEarly = () => {
    if (!earlyCall || earlyGiven || earlyRefused) return;
    earlyGiven = true;
    recordToolCall(earlyCall, earlyCall.result as Awaited<ReturnType<typeof runTool>>, []);
    turns.push({ text: "", calls: [{ id: earlyCall.id, name: earlyCall.name, args: earlyCall.args }], outputs: [{ id: earlyCall.id, output: earlyView }] });
  };
  let modelCalls = 0;
  let closedInCall = false;

  // The finished turns, in a vendor-neutral shape, so a backup provider can
  // pick the conversation up where the primary dropped it (tools already run
  // are never run twice).
  const turns: NeutralTurn[] = [];
  const noteTurn = (call: { text: string; toolCalls: NeutralTurn["calls"] }, views: string[]) =>
    turns.push({
      text: call.text,
      calls: call.toolCalls,
      outputs: call.toolCalls.map((tc, i) => ({ id: tc.id, output: views[i] ?? "" })),
    });

  // The platform's backups (keys from Platform providers in the vault, else
  // ANTHROPIC_API_KEY / OPENAI_API_KEY). Read only once the primary has
  // actually failed, so a healthy run makes no extra reads. None configured,
  // or a workspace on its own account: none are tried.
  let backups: BackupRoute[] = [];

  let modelError: unknown = null;
  if (key) {
    try {
      if (isOpenAiModel(brain.model_id) || (direct && brain.provider === "openai")) {
        const items = responsesInput(system, history, input, options.imageDataUrl ?? null);
        const earlyAt = items.length;
        if (earlyCall) {
          items.push(
            { type: "function_call", call_id: earlyCall.id, name: earlyCall.name, arguments: JSON.stringify(earlyCall.args) },
            { type: "function_call_output", call_id: earlyCall.id, output: earlyView },
          );
        }

        for (let step = 0; step < maxSteps; step += 1) {
          let call: Awaited<ReturnType<typeof callResponses>>;
          try {
            modelCalls += 1;
            call = await callResponses(apiBase, key, wire, items, tools, direct);
          } catch (error) {
            // The provider refused the conversation with the early search in
            // it: the same question again without it, exactly as before.
            if (step !== 0 || !earlyCall || earlyGiven || !refusedRequest(error)) throw error;
            earlyRefused = true;
            items.splice(earlyAt, 2);
            modelCalls += 1;
            call = await callResponses(apiBase, key, wire, items, tools, direct);
          }
          giveEarly();
          inputTokens += call.inputTokens ?? 0;
          outputTokens += call.outputTokens ?? 0;
          answer = call.text || answer;
          if (call.toolCalls.length === 0) {
            closingText = call.text;
            break;
          }
          // The function_call items must travel with their outputs.
          items.push(...call.items);
          const { views, closing } = await runToolCalls(call.toolCalls, call.text);
          call.toolCalls.forEach((tc, i) =>
            items.push({
              type: "function_call_output",
              call_id: tc.id,
              output: views[i],
            }),
          );
          noteTurn(call, views);
          if (closing !== null) {
            closingText = closing;
            closedInCall = true;
            break;
          }
        }
      } else {
        const messages: ChatMessage[] = [];
        if (system) messages.push({ role: "system", content: system });
        for (const turn of history) messages.push({ role: turn.role, content: turn.content });
        messages.push({
          role: "user",
          content: options.imageDataUrl
            ? [
                { type: "text", text: input },
                { type: "image_url", image_url: { url: options.imageDataUrl } },
              ]
            : input,
        });
        const earlyAt = messages.length;
        if (earlyCall) {
          messages.push(
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: earlyCall.id,
                  type: "function",
                  function: { name: earlyCall.name, arguments: JSON.stringify(earlyCall.args) },
                  // Gemini asks every replayed call for its thought signature;
                  // a call it didn't make carries the documented stand-in.
                  ...(brain.model_id.startsWith("google/") || (direct && brain.provider === "google")
                    ? { extra_content: { google: { thought_signature: "skip_thought_signature_validator" } } }
                    : {}),
                },
              ],
            },
            { role: "tool", tool_call_id: earlyCall.id, content: earlyView },
          );
        }

        for (let step = 0; step < maxSteps; step += 1) {
          let call: GatewayCall;
          try {
            modelCalls += 1;
            call = await callChatCompletions(apiBase, key, wire, messages, tools, direct);
          } catch (error) {
            if (step !== 0 || !earlyCall || earlyGiven || !refusedRequest(error)) throw error;
            earlyRefused = true;
            messages.splice(earlyAt, 2);
            modelCalls += 1;
            call = await callChatCompletions(apiBase, key, wire, messages, tools, direct);
          }
          giveEarly();
          inputTokens += call.inputTokens ?? 0;
          outputTokens += call.outputTokens ?? 0;
          answer = call.text || answer;
          if (call.toolCalls.length === 0) {
            closingText = call.text;
            break;
          }
          messages.push(call.raw as ChatMessage);
          const { views, closing } = await runToolCalls(call.toolCalls, call.text);
          call.toolCalls.forEach((tc, i) =>
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: views[i],
            }),
          );
          noteTurn(call, views);
          if (closing !== null) {
            closingText = closing;
            closedInCall = true;
            break;
          }
        }
      }
    } catch (error) {
      modelError = error;
    }
  }

  // ---------------------------------------------------------------- backup
  // The primary is out of credit, over quota, failing or unreachable (or has
  // no key): the same conversation continues on a backup, from the turn it
  // stopped at. Any other failure (a bad request) is returned as before.
  const outage: Outage | null = !key ? { kind: "no_key", status: null } : modelError ? outageOf(modelError) : null;
  if (outage && prelude.api.owner !== "workspace") {
    backups = (await platformBackupRoutes(supabase, brain.tier)).filter(
      (r) => !(direct && r.provider === brain.provider),
    );
  }
  let served: { route: BackupRoute; model: string; inputTokens: number; outputTokens: number } | null = null;
  if (outage && backups.length > 0) {
    // The backup picks the conversation up with the early search in it too
    // (it is a finished turn, not a model step).
    giveEarly();
    const earlyTurns = earlyGiven ? 1 : 0;
    const attempts: Array<Record<string, unknown>> = [];
    for (const route of backups) {
      const used = { inputTokens: 0, outputTokens: 0, model: route.model };
      try {
        const convo: BackupConversation =
          route.provider === "anthropic"
            ? anthropicConversation(route, {
                system,
                history,
                input,
                imageDataUrl: options.imageDataUrl ?? null,
                turns: turns.slice(),
                tools,
                tier: brain.tier,
              })
            : openAiBackupConversation(route, { system, history, input, imageDataUrl: options.imageDataUrl ?? null, turns: turns.slice(), tools });
        for (let step = turns.length - earlyTurns; step < maxSteps; step += 1) {
          modelCalls += 1;
          const call = await convo.step();
          used.inputTokens += call.inputTokens ?? 0;
          used.outputTokens += call.outputTokens ?? 0;
          used.model = call.model;
          answer = call.text || answer;
          if (call.toolCalls.length === 0) {
            closingText = call.text;
            break;
          }
          const { views, closing } = await runToolCalls(call.toolCalls, call.text);
          convo.addToolResults(call.toolCalls.map((tc, i) => ({ id: tc.id, output: views[i] ?? "" })));
          noteTurn(call, views);
          if (closing !== null) {
            closingText = closing;
            closedInCall = true;
            break;
          }
        }
        served = { route, model: used.model, inputTokens: used.inputTokens, outputTokens: used.outputTokens };
        attempts.push({ provider: route.provider, model: used.model, ok: true });
        modelError = null;
        break;
      } catch (error) {
        const again = outageOf(error);
        attempts.push({ provider: route.provider, model: route.model, ok: false, kind: again?.kind ?? "error" });
        // A backup that is itself down passes to the next; any other error stops here.
        modelError = error;
        // Tokens a failed backup spent are still owed.
        inputTokens += used.inputTokens;
        outputTokens += used.outputTokens;
        if (!again) break;
      }
    }
    runMeta["fallback"] = {
      from_provider: brain.provider,
      from_model: brain.model_id,
      reason: outage.kind,
      status: outage.status,
      attempts,
    };
  }
  if (outage) {
    const report = reportProviderTrouble(supabase, {
      provider: brain.provider,
      model: brain.model_id,
      outage,
      servedBy: served ? served.route.provider : null,
      backupConfigured: backups.length > 0,
      task,
      organizationId,
      error: modelError instanceof Error ? modelError.message : outage.kind,
    }).catch(() => false);
    if (options.deferUsage) options.deferUsage(report);
    else await report;
  }

  // Whether the early search ran and was given to the model (and why not),
  // how many model calls the answer took, and whether it closed in the
  // same call that sent its products.
  if (early) {
    const own = toolCalls.filter((c, i) => c.tool === "catalog_search" && !(earlyGiven && i === 0)).length;
    runMeta["early_search"] = {
      ran: Boolean(early.result),
      used: earlyGiven,
      reason: earlyGiven ? "used" : earlyRefused ? "provider_refused" : early.usable && !earlyFits ? "no_catalogue" : early.reason,
      rows: Array.isArray(early.result?.data) ? (early.result.data as unknown[]).length : 0,
      ms: early.ms,
      ...(early.missing?.length ? { missing: early.missing } : {}),
      model_searched: own,
    };
  }
  if (modelCalls > 0) runMeta["model_calls"] = modelCalls;
  if (closedInCall) runMeta["closed_in_call"] = true;

  if (!key && !served) {
    return finish({
      ...base,
      status: "error",
      error: `My "${brain.display_name}" setup has no working connection behind it, so I couldn't think at all. This isn't a bad answer — it's a broken connection. Ask the platform team to check the key for this setup.`,
    });
  }

  if (modelError) {
    const error = modelError;
    const message = error instanceof Error ? error.message : "The AI couldn't complete that.";
    const priced = await priceRun(supabase, brain.provider, brain.model_id, inputTokens, outputTokens);
    return finish({
      ...base,
      status: "error",
      error: message,
      sources,
      toolCalls,
      media: [],
      inputTokens: inputTokens || null,
      outputTokens: outputTokens || null,
      costAmount: priced.amount,
      costCurrency: priced.currency,
      billedAmount: billedFromCost(priced.amount, markup),
      billedCurrency: priced.currency,
      costKnown: priced.source === "rate_card",
    });
  }

  timing["model"] = Date.now() - modelStarted;
  const checksStarted = Date.now();
  const priced = served
    ? await priceWithBackup(supabase, brain, { inputTokens, outputTokens }, served, runMeta)
    : await priceRun(supabase, brain.provider, brain.model_id, inputTokens, outputTokens);
  if (served) {
    base.provider = served.route.provider;
    base.model = served.model;
    runMeta["provider"] = served.route.provider;
    inputTokens += served.inputTokens;
    outputTokens += served.outputTokens;
  }


  // The model's own "was I missing business information?" line comes off
  // before anything else reads the answer. Once it sent products, its reply
  // is its words in its order, with a mark where each set of pictures goes.
  let reported: { output: string; needsOwner: boolean };
  if (segments.length > 0) {
    const pieces = [...segments, ...(closingText.trim() ? [{ kind: "text" as const, text: closingText }] : [])];
    let needsOwner = false;
    const words = pieces.map((piece) => {
      if (piece.kind === "products") return PRODUCTS_MARK;
      const split = task === "agent_reply" ? splitNeedsOwner(piece.text) : { output: piece.text.trim(), needsOwner: false };
      needsOwner ||= split.needsOwner;
      return split.output;
    });
    reported = { output: words.filter(Boolean).join("\n\n"), needsOwner };
  } else {
    reported = task === "agent_reply" ? splitNeedsOwner(answer) : { output: answer.trim(), needsOwner: false };
  }
  // Replies (sent to a customer, or drafted for a teammate to send) never
  // carry a source reference. The owner's own chat keeps its plain-words
  // source line; only [n] markers come off there.
  const numberedItems = sources.filter((s) => s.kind === "knowledge").length;
  const customerFacing = options.channel !== "onboarding";
  const cleanRefs = (text: string) => (customerFacing ? stripReferences(text, numberedItems) : stripCitationMarkers(text));
  if (task === "agent_reply" || task === "suggest_reply") {
    reported.output = cleanRefs(reported.output);
    for (const segment of segments) {
      if (segment.kind === "products") for (const item of segment.items) item.caption = cleanRefs(item.caption);
    }
  }
  const sendsProducts = tools.some((t) => t.name === "send_products");
  const chosenMedia = segments.flatMap((s) => (s.kind === "products" ? s.items : []));

  const result: RunResult = {
    ...base,
    output: reported.output,
    // Zero material plus the model saying it was short of business facts.
    needsOwner: reported.needsOwner && sources.length === 0,
    sources,
    toolCalls,
    // With send_products offered, the pictures are only the ones the model
    // sent; otherwise (no catalogue tool) the answer's products, as before.
    media: sendsProducts ? chosenMedia : pickMediaForAnswer(foundMedia, reported.output),
    inputTokens: inputTokens || null,
    outputTokens: outputTokens || null,
    costAmount: priced.amount,
    costCurrency: priced.currency,
    billedAmount: billedFromCost(priced.amount, markup),
    billedCurrency: priced.currency,
    costKnown: priced.source === "rate_card",
  };

  // -------------------------------------------------- numeric grounding
  // A number the material never mentions is a guess, and a guess about a
  // price or a date is worse than no answer at all. Reading a picture is
  // the exception: the picture *is* the material, so its numbers are sourced.
  const isVisionRead = Boolean(options.imageDataUrl);
  let numbersStripped = false;
  if (task === "agent_reply" && result.output && !isVisionRead) {
    // Times, days and durations: the same rule, but the customer's own
    // question is not support for them.
    const material = [knowledgeBlock, options.system ?? "", ...toolResultTexts, ...chosenFacts];
    const unsupported = [
      ...unsupportedNumbers(result.output, [knowledgeBlock, options.system ?? "", input, ...toolResultTexts]),
      ...unsupportedTimeFacts(result.output, material),
    ];
    if (unsupported.length > 0) {
      numbersStripped = true;
      console.log(
        "[grounding] unsupported",
        organizationId,
        JSON.stringify(unsupported),
        JSON.stringify(input).slice(0, 120),
      );
      // The guess goes; everything else the model said stays, with a promise
      // to come back on the part we can't stand behind.
      result.output = stripUnsupported(result.output, unsupported);
      result.needsOwner = true;
    }
    // The same rule for every caption the model wrote, against the same
    // material plus the product's own record. A caption never gets a promise
    // line: the number's sentence just goes.
    for (const item of chosenMedia) {
      const guessed = [
        ...unsupportedNumbers(item.caption, [knowledgeBlock, options.system ?? "", input, ...toolResultTexts, ...chosenFacts]),
        ...unsupportedTimeFacts(item.caption, material),
      ];
      if (guessed.length === 0) continue;
      numbersStripped = true;
      result.needsOwner = true;
      runMeta["caption_numbers_removed"] = [...((runMeta["caption_numbers_removed"] as string[] | undefined) ?? []), ...guessed];
      let caption = dropSentences(item.caption, (sentence) => guessed.some((t) => sentence.includes(t)));
      for (const token of guessed) caption = caption.split(token).join("").trim();
      item.caption = caption;
    }
  }

  // ------------------------------------------------- policy-claim grounding
  // A claim about this business's pricing, fees, refunds, delivery, warranty
  // or payment terms must come from the material. The cheap check only runs
  // when such a sentence is present; the numeric guard above is untouched.
  // Replies only (owner chat + customer) — never reading, chunking or page summaries.
  let policyStripped = false;
  if (task === "agent_reply" && result.output && !isVisionRead && !purpose.startsWith("knowledge_")) {
    // The reply's policy sentences and the captions' are judged together, in one check.
    const replyClaims = policyClaimSentences(result.output);
    const captionClaims = chosenMedia.flatMap((item) => policyClaimSentences(item.caption));
    const candidates = Array.from(new Set([...replyClaims, ...captionClaims]));
    if (candidates.length > 0) {
      const sourceText = [knowledgeBlock, options.system ?? "", ...toolResultTexts, ...chosenFacts].join("\n\n");
      // Wording first, deterministically: stated as written → supported; a
      // promise word the sources never attach to that policy → not
      // supported, and it goes (the source's own line is kept on the run
      // for review; code never writes it into the reply). Only the rest
      // needs the model check.
      const wording = sourceText.trim()
        ? checkPolicyWording(candidates, sourceText)
        : { verbatim: [], unsupported: [], undecided: candidates };
      if (wording.unsupported.length > 0) runMeta["policy_wording_unsupported"] = wording.unsupported;
      const unsupported = [
        ...wording.unsupported.map((u) => u.sentence),
        ...(await unsupportedPolicyClaims(supabase, {
          ...policyCheckWho,
          sentences: wording.undecided,
          sources: sourceText,
          ...(policyCheckPrelude ? { prelude: policyCheckPrelude } : {}),
          ...(options.deferUsage ? { deferUsage: options.deferUsage } : {}),
        })),
      ];
      if (unsupported.length > 0) {
        result.needsOwner = true;
        // Batch 16: the reply's own unsupported claims — ask the model once
        // to say it again without them; the rewrite passes the same checks
        // (numbers, times, policy) or today's stripping applies.
        const replyUnsupported = unsupported.filter((u) => replyClaims.includes(u));
        let rewritten = false;
        if (replyUnsupported.length > 0) {
          const textParts = result.output.split(PRODUCTS_MARK);
          const attempt = await rewriteWithoutClaims(supabase, {
            ...policyCheckWho,
            parts: textParts,
            claims: replyUnsupported,
            sources: sourceText,
            question: input,
            ...(policyCheckPrelude ? { prelude: policyCheckPrelude } : {}),
            ...(options.deferUsage ? { deferUsage: options.deferUsage } : {}),
          });
          let outcome = "failed";
          if (attempt) {
            const candidate = attempt.join(PRODUCTS_MARK);
            const support = [knowledgeBlock, options.system ?? "", ...toolResultTexts, ...chosenFacts];
            const guessed = [
              ...unsupportedNumbers(candidate, [knowledgeBlock, options.system ?? "", input, ...toolResultTexts]),
              ...unsupportedTimeFacts(candidate, support),
            ];
            const again = policyClaimSentences(candidate);
            const wordingAgain = again.length ? checkPolicyWording(again, sourceText) : { verbatim: [], unsupported: [], undecided: [] };
            const stillUnsupported = [
              ...wordingAgain.unsupported.map((u) => u.sentence),
              ...(wordingAgain.undecided.length
                ? await unsupportedPolicyClaims(supabase, {
                    ...policyCheckWho,
                    sentences: wordingAgain.undecided,
                    sources: sourceText,
                    ...(policyCheckPrelude ? { prelude: policyCheckPrelude } : {}),
                    ...(options.deferUsage ? { deferUsage: options.deferUsage } : {}),
                  })
                : []),
            ];
            if (guessed.length === 0 && stillUnsupported.length === 0 && candidate.replace(PRODUCTS_MARK, "").trim()) {
              result.output = candidate;
              rewritten = true;
              outcome = "rewritten";
            } else {
              outcome = "still_unsupported";
            }
          }
          runMeta["policy_rewrite"] = { outcome, claims: replyUnsupported };
          console.log("[policy-grounding] rewrite", organizationId, outcome);
        }
        console.log("[policy-grounding] stripped", organizationId, unsupported.length);
        runMeta["policy_claims_stripped"] = unsupported;
        if (!rewritten && replyUnsupported.length > 0) result.output = stripSentences(result.output, unsupported);
        for (const item of chosenMedia) item.caption = dropSentences(item.caption, (sentence) => unsupported.includes(sentence));
        policyStripped = !rewritten || unsupported.length > replyUnsupported.length;
      }
    }
  }

  // ------------------------------------------- only offer what search found
  // A browse answer may only offer kinds of product the catalogue search
  // returned (or the customer asked about); "want pendants instead?" when no
  // pendant was found invents stock.
  const searchedCatalog = toolCalls.some((c) => c.tool === "catalog_search" && c.ok);
  if (task === "agent_reply" && searchedCatalog && result.output) {
    const offers = unsearchedShelfOffers(result.output, input, toolResultTexts);
    const kept = dropSentences(result.output, (s) => offers.includes(s));
    if (offers.length > 0 && kept.replace(PRODUCTS_MARK, "").trim()) {
      runMeta["unsearched_offers_removed"] = offers;
      result.output = kept;
    }
    // Grounded in the search (nothing stripped as unsupported, not a policy
    // question): a stand-alone "let me confirm" line promises a check nobody
    // needs to make, so it goes.
    const confirmOnly = /(^|\n|(?<=[.!?])\s+)let me confirm that for you\.?\s*$/i;
    if (!numbersStripped && !policyStripped && !POLICY_TOPIC.test(input) && confirmOnly.test(result.output)) {
      const rest = result.output.replace(confirmOnly, "").trim();
      if (rest) result.output = rest;
    }
  }

  // "Let me confirm that for you" is the model telling us it hit a fact it
  // couldn't source. That belongs under Unanswered, silently.
  if (task === "agent_reply" && /let me confirm/i.test(result.output)) {
    result.needsOwner = true;
  }



  // ------------------------------------------------- signal-based hand-over
  // Only for conversation work. A summary or a tag never escalates.
  if (task === "agent_reply" && result.status === "ok" && !isVisionRead) {
    const signal = decideEscalation({
      question: input,
      answer: result.output,
      knowledgeMatched: sources.some((s) => s.kind === "knowledge"),
      toolUsed: toolCalls.length > 0,
      toolsBrokered: !useTools || tools.length > 0,
      anyToolFailed,
      history,
      merchantRules: options.handoverRules ?? "",
      priorFailedQuestions: options.priorFailedQuestions ?? [],
      customerLanguage: options.customerLanguage ?? null,
    });
    // Not knowing is never a reason to go quiet (Batch 16): the answer
    // stands and the question is filed for the merchant ("Aiden's questions
    // for you"). Only a customer asking for a person, the merchant's own
    // hand-over rule or a sensitive topic hands the thread to a person.
    if (signal && isHandOffSignal(signal)) {
      result.status = "escalated";
      result.escalationSignal = signal;
    } else if (signal) {
      result.needsOwner = true;
      runMeta["kept_talking"] = signal;
    }
  }

  // ------------------------------------------------- "let me confirm"
  // "Let me confirm that for you" promises that someone will come back. It
  // is added by the guards above (a stripped number or policy line) and by
  // the model itself. Next to anything else it goes; the question is still
  // filed for the merchant (needsOwner, set above). A reply that was nothing
  // but the promise goes as it is: the question is filed, and the merchant's
  // answer to it reaches this customer — the thread is never handed over
  // (and Aiden never silenced) for not knowing.
  if (task === "agent_reply" && result.status === "ok" && /let me confirm/i.test(result.output)) {
    const rest = withoutConfirmLine(result.output);
    if (rest) {
      runMeta["confirm_line_removed"] = true;
      result.output = rest;
    } else {
      result.needsOwner = true;
      runMeta["kept_talking"] = numbersStripped ? "unsupported_number" : "no_source";
    }
  }

  // The reply as it goes out: the model's words and its products, in its
  // order. The output everyone else reads is the words alone.
  if (segments.length > 0) {
    const texts = result.output.split(PRODUCTS_MARK).map((t) => t.trim());
    const productSets = segments.filter((s): s is { kind: "products"; items: ChosenProduct[] } => s.kind === "products");
    const parts: ReplyPart[] = [];
    texts.forEach((text, i) => {
      if (text) parts.push({ kind: "text", text });
      const set = productSets[i];
      if (set && set.items.length > 0) parts.push({ kind: "products", items: set.items });
    });
    result.parts = parts;
    result.output = texts.filter(Boolean).join("\n\n");
    if (parts.some((p) => p.kind === "products")) runMeta["reply_parts"] = parts.map((p) => (p.kind === "text" ? "text" : `products:${p.items.length}`));
  }

  if (!result.output && !result.parts?.some((p) => p.kind === "products") && result.status === "ok") {
    result.status = "refused";
    result.error = "The AI had nothing to say.";
  }

  timing["checks"] = Date.now() - checksStarted;
  return finish(result);
}

/**
 * What each tool call did, kept on the run (metadata.tools) so a run explains
 * itself: the same arguments and result summary the ai_tool_calls trace rows
 * carry (invokeTool's summarise), never the data itself.
 */
export function runToolsMeta(calls: RunResult["toolCalls"]): Array<Record<string, unknown>> {
  return calls.map((c) => {
    const summary = c.resultSummary ?? {};
    return {
      tool: c.tool,
      args: c.args ?? {},
      ok: c.ok,
      rows: typeof summary["row_count"] === "number" ? summary["row_count"] : null,
      found: Array.isArray(summary["identifiers"]) ? summary["identifiers"] : [],
      ...(summary["found"] === false ? { nothing_found: true } : {}),
      ...(c.error ? { error: c.error.slice(0, 200) } : {}),
    };
  });
}

/** The products a send_products call queued, as the reply path sends them. */
export function chosenProducts(result: { ok?: boolean; data?: unknown }): Array<ChosenProduct & { facts: unknown }> {
  if (result.ok === false) return [];
  const list = (result.data as { products?: unknown[] } | undefined)?.products;
  if (!Array.isArray(list)) return [];
  const out: Array<ChosenProduct & { facts: unknown }> = [];
  for (const raw of list) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const send = (p["send"] ?? {}) as Record<string, unknown>;
    const id = typeof p["product_id"] === "string" ? p["product_id"] : "";
    const title = typeof p["title"] === "string" ? p["title"] : "";
    if (!id || !title) continue;
    const imageUrl = typeof send["imageUrl"] === "string" ? send["imageUrl"] : "";
    out.push({
      productId: id,
      title,
      caption: typeof p["caption"] === "string" ? p["caption"] : "",
      hasPhoto: Boolean(imageUrl),
      imageUrl,
      price: typeof send["price"] === "number" && Number.isFinite(send["price"]) ? send["price"] : null,
      currency: typeof send["currency"] === "string" ? send["currency"] : null,
      productUrl: typeof send["productUrl"] === "string" ? send["productUrl"] : null,
      retailerId: typeof send["retailerId"] === "string" ? send["retailerId"] : null,
      category: typeof send["category"] === "string" ? send["category"] : null,
      inCatalog: send["inCatalog"] === true,
      facts: p["facts"] ?? null,
    });
  }
  return out;
}

const CLOSEST_NOTE =
  "Nothing matched that exactly. closest_above lists the nearest real products, cheapest first; lowest_price is where they start. " +
  "Say so plainly and offer only products a search returned — search another type before suggesting it.";

/**
 * What the model reads of a product tool: every product as productFacts
 * (whole-rupee prices, readable names, no picture addresses), and for
 * send_products only what was queued and the caption that will go out.
 * Other tools are untouched.
 */
export function productToolView<T extends { ok: boolean; found?: boolean; data?: unknown; error?: string }>(name: string, result: T): T {
  if (!result.ok || result.data === undefined || result.data === null) return result;
  if (name === "catalog_search" || name === "search_products") {
    if (Array.isArray(result.data)) {
      return { ...result, data: (result.data as Array<Record<string, unknown>>).map(productFacts) };
    }
    const data = result.data as Record<string, unknown>;
    if (Array.isArray(data["closest_above"])) {
      const closest = (data["closest_above"] as Array<Record<string, unknown>>).map(productFacts);
      const prices = (data["closest_above"] as Array<Record<string, unknown>>)
        .map((r) => Number(r["price"]))
        .filter((p) => Number.isFinite(p) && p > 0);
      const { reply_hint: _hint, lowest_price: _lowest, ...rest } = data;
      return {
        ...result,
        data: {
          ...rest,
          ...(prices.length ? { lowest_price: rupees(Math.min(...prices)) } : {}),
          closest_above: closest,
          note: CLOSEST_NOTE,
        },
      };
    }
    return result;
  }
  if (name === "send_products") {
    const data = result.data as { products?: Array<Record<string, unknown>>; skipped?: unknown };
    return {
      ...result,
      data: {
        queued: true,
        products: (data.products ?? []).map((p) => ({
          product_id: p["product_id"],
          title: p["title"],
          caption: p["caption"],
          has_photo: p["has_photo"],
          ...(p["caption_changes"] ? { caption_changes: p["caption_changes"] } : {}),
        })),
        ...(data.skipped ? { skipped: data.skipped, skipped_note: "These ids are not this business's products and will not be sent." } : {}),
        note: "These go out exactly as shown, in this order. Do not repeat the captions in your reply.",
      },
    };
  }
  return result;
}

/**
 * Small talk in the languages our customers actually write in: greetings,
 * thanks, acknowledgements, sign-offs. Never stripped to a-z — Devanagari,
 * Tamil, Bengali and the rest survive intact.
 */
const SMALL_TALK_TOKENS = new Set([
  // English
  "hi", "hii", "hiii", "hey", "heya", "hello", "helo", "yo", "hola", "there",
  "sir", "madam", "good", "morning", "afternoon", "evening", "night", "day",
  "thanks", "thank", "thankyou", "thx", "ty", "you", "ok", "okay", "okey", "k",
  "kk", "cool", "great", "nice", "sure", "fine", "yes", "no", "yep", "bye",
  "welcome", "please", "got", "it", "perfect", "super", "hmm", "hm",
  // Hinglish in Latin script
  "namaste", "namaskar", "namaskaram", "nomoshkar", "vanakkam", "salaam",
  "salam", "assalamualaikum", "adaab", "ram", "sat", "sri", "akal", "kem",
  "cho", "kaise", "kaisi", "kaise", "ho", "hain", "kya", "haal", "hal", "hai",
  "aap", "tum", "bhai", "ji", "haan", "han", "hn", "nahi", "nahin", "theek",
  "thik", "achha", "acha", "accha", "shukriya", "dhanyavaad", "dhanyavad",
  "bhaiya", "didi", "sab", "badhiya",
  // Devanagari (Hindi, Marathi)
  "नमस्ते", "नमस्कार", "हाय", "हैलो", "धन्यवाद", "शुक्रिया", "ठीक", "है", "हाँ",
  "हां", "नहीं", "कैसे", "कैसा", "हो", "आप", "क्या", "हाल", "जी", "अच्छा",
  // Other Indian scripts
  "வணக்கம்", "நன்றி", "নমস্কার", "ধন্যবাদ", "કેમ", "છો", "આભાર", "నమస్కారం",
  "ధన్యవాదాలు", "ನಮಸ್ಕಾರ", "ಧನ್ಯವಾದ",
]);

const SMALL_TALK_PHRASES = [
  "kaise ho", "kaise hain", "kaisi ho", "kya haal", "kya haal hai", "kya hal hai",
  "sat sri akal", "ram ram", "kem cho", "good morning", "good afternoon",
  "good evening", "good night", "thank you", "thanks a lot", "how are you",
  "how r u", "all good", "no problem", "got it", "ok thanks", "theek hai",
  "thik hai", "kaise ho aap", "aap kaise ho", "कैसे हो", "क्या हाल है",
];

/**
 * "heya", "kaise ho", "नमस्ते", "நன்றி" — an opening or a courtesy, not a
 * question. Answerable without a single source or lookup.
 */
export function isSmallTalk(question: string, _language?: string | null): boolean {
  const q = question
    .toLowerCase()
    .replace(/[!?.,;:'"()\u0964]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!q) return true;
  if (SMALL_TALK_PHRASES.some((p) => q === p)) return true;
  const words = q.split(" ");
  if (words.length > 5) return false;
  if (words.every((w) => SMALL_TALK_TOKENS.has(w))) return true;
  // "hi kaise ho", "namaste ji thanks" — phrase plus courtesy tokens.
  const phrase = SMALL_TALK_PHRASES.find((p) => q.includes(p));
  if (!phrase) return false;
  return q
    .replace(phrase, " ")
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => SMALL_TALK_TOKENS.has(w));
}

/** Kept for older call sites; small talk is the wider, correct test. */
export const isGreeting = isSmallTalk;

/**
 * Words that mean the customer wants a fact we'd have to look up or read.
 * Anything outside this — thanks, confirmations, clarifications — is
 * answerable from the brief alone and must never be called "no source".
 */
const LOOKUP_WORDS = new Set([
  "order", "orders", "parcel", "shipment", "tracking", "track", "delivery",
  "deliver", "delivered", "ship", "shipping", "dispatch", "price", "prices",
  "cost", "rate", "discount", "offer", "coupon", "stock", "available",
  "availability", "size", "sizes", "color", "colour", "product", "products",
  "item", "items", "catalogue", "catalog", "refund", "return", "exchange",
  "warranty", "invoice", "receipt", "payment", "paid", "cod", "address",
  "kitna", "kitne", "kimat", "keemat", "daam", "dam", "kab", "kahan", "kaunsa",
  "kaun", "kyun", "kyu", "milega", "milegi", "bhejo", "bheja", "order",
  "when", "where", "which", "how", "what", "why", "who", "do", "does", "can",
  "is", "are", "will", "have", "any",
]);

function looksLikeLookup(question: string): boolean {
  if (question.includes("?")) return true;
  const words = question
    .toLowerCase()
    .replace(/[!?.,;:'"()\u0964]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.some((w) => LOOKUP_WORDS.has(w));
}

/** Same question, ignoring case, spacing and trailing punctuation. */
function normaliseQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?!.,;:\u0964]+$/g, "")
    .trim();
}

// ------------------------------------------------------- numeric grounding

/** Every number-looking run of characters, with currency and percent signs. */
const NUMBER_PATTERN = /(?:₹|Rs\.?\s?)?\d[\d,]*(?:\.\d+)?\s?%?/g;

/** ₹, Rs, commas and spaces carry no meaning for a comparison. */
function stripNumericNoise(text: string): string {
  return text.replace(/₹|Rs\.?/gi, "").replace(/[,\s]/g, "");
}

/**
 * Questions whose only honest answer contains a figure: a price, a time, a
 * count. English and the everyday Hinglish equivalents.
 */
const FIGURE_WORDS =
  /\b(price|prices|pricing|cost|costs|how much|rate|rates|charge|charges|fee|fees|timing|timings|hours|when|how many|how long|kitna|kitne|kitni|kab)\b/i;

export function asksForFigure(question: string): boolean {
  return FIGURE_WORDS.test(question);
}



/**
 * The numbers in an answer that nothing behind the answer actually says.
 *
 * Small bare counts ("2 sizes") are ignored: they are ordinary language, not
 * a claim about price, date or quantity. Anything with a currency mark, a
 * decimal, a percent sign or three digits or more must be there in writing.
 */
export function unsupportedNumbers(answer: string, support: string[]): string[] {
  const haystack = stripNumericNoise(support.join("\n"));
  // Digits inside a link (…premix-coffee-132g) are part of an address, not a
  // claim about price or quantity. Drop links before looking for numbers.
  const claims = answer.replace(/https?:\/\/\S+/gi, " ");
  const found = claims.match(NUMBER_PATTERN) ?? [];
  const out: string[] = [];
  for (const raw of found) {
    const token = raw.trim();
    const value = stripNumericNoise(token);
    if (!value) continue;
    const bare = value.replace(/%$/, "");
    const trivial =
      !/[₹%]|Rs/i.test(token) && !bare.includes(".") && bare.replace(/\D/g, "").length <= 2;
    if (trivial) continue;
    if (haystack.includes(value)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

// ------------------------------------------------ time, day, duration guard

const TIME_RE =
  /\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi;
/** Day words: full names any case; the short forms only capitalised ("Sun", not "sun"). */
const DAY_NAMES: Array<[RegExp, RegExp | null, string]> = [
  [/\bmondays?\b|\bsomvaa?r\b/gi, /\bMon\b/g, "mon"],
  [/\btuesdays?\b|\bmangalvaa?r\b/gi, /\bTues?\b/g, "tue"],
  [/\bwednesdays?\b|\bbudhvaa?r\b/gi, /\bWed\b/g, "wed"],
  [/\bthursdays?\b|\bguruvaa?r\b/gi, /\bThu(?:rs)?\b/g, "thu"],
  [/\bfridays?\b|\bshukravaa?r\b/gi, /\bFri\b/g, "fri"],
  [/\bsaturdays?\b|\bshanivaa?r\b/gi, /\bSat\b/g, "sat"],
  [/\bsundays?\b|\bravivaa?r\b|\bitvaa?r\b/gi, /\bSun\b/g, "sun"],
  [/\bweekdays?\b/gi, null, "weekdays"],
  [/\bweekends?\b/gi, null, "weekends"],
  [/\b(?:all|7|seven) days(?: a| of the)? week\b|\ball days\b/gi, null, "alldays"],
];
const DURATION_RE =
  /\b(\d{1,3})(?:\s*(?:-|–|—|to)\s*(\d{1,3}))?[\s-]*(?:working\s+|business\s+)?(minutes?|mins?|hours?|hrs?|ghante|days?|din|weeks?|hafte|months?)\b/gi;
const PHRASE_RE = /\bsame[\s-]day\b|\bnext[\s-]day\b|\bovernight\b|\bwithin (?:a|an|one) (?:day|hour|week)\b/gi;
/** A source line that says something is NOT so supports nothing ("Never promise same-day delivery"). */
const NEGATION = /\b(never|not|don'?t|do not|cannot|can'?t|won'?t|nahi|nahin|mat)\b/i;

function minutesOf(m: RegExpMatchArray): number | null {
  if (m[3]) {
    const h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12 || min > 59) return null;
    const pm = /^p/i.test(m[3]);
    return ((h % 12) + (pm ? 12 : 0)) * 60 + min;
  }
  return Number(m[4]) * 60 + Number(m[5]);
}

function unitOf(raw: string): string {
  const u = raw.toLowerCase();
  if (/^(min|minute)/.test(u)) return "minute";
  if (/^(h|ghante)/.test(u)) return "hour";
  if (/^(day|din)/.test(u)) return "day";
  if (/^(week|hafte)/.test(u)) return "week";
  return "month";
}

type TimeFact = { token: string; key: string };

/** Every clock time, day and duration a text states, each with a comparable key. */
function timeFacts(text: string): TimeFact[] {
  const out: TimeFact[] = [];
  const plain = text.replace(/https?:\/\/\S+/gi, " ");
  for (const m of plain.matchAll(TIME_RE)) {
    const mins = minutesOf(m);
    if (mins !== null) out.push({ token: m[0].trim(), key: `t${mins}` });
  }
  for (const [full, short, day] of DAY_NAMES) {
    for (const re of short ? [full, short] : [full]) for (const m of plain.matchAll(re)) out.push({ token: m[0].trim(), key: `d${day}` });
  }
  for (const m of plain.matchAll(DURATION_RE)) {
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    out.push({ token: m[0].trim(), key: `p${Math.min(lo, hi)}-${Math.max(lo, hi)}${unitOf(m[3]!)}` });
  }
  for (const m of plain.matchAll(PHRASE_RE)) out.push({ token: m[0].trim(), key: `x${m[0].toLowerCase().replace(/[\s-]+/g, " ")}` });
  return out;
}

/**
 * The clock times ("10:30 AM", "10 am–8 pm"), opening days ("Monday to
 * Saturday", "weekends") and durations ("3–5 days", "24 hours", "same day")
 * an answer states that nothing behind it states — the number guard's rule
 * for facts it couldn't see as numbers. "10 am" and "10:00" are the same
 * time. A line of the material that says something is not so ("Never
 * promise same-day delivery") supports nothing. The customer's own question
 * is not support: a day they ask about is not a day the shop is open.
 */
export function unsupportedTimeFacts(answer: string, support: string[]): string[] {
  const facts = timeFacts(answer);
  if (!facts.length) return [];
  const known = new Set<string>();
  for (const text of support) {
    for (const line of text.split(/(?<=[.!?])\s+|\n+/)) {
      if (NEGATION.test(line)) continue;
      for (const f of timeFacts(line)) known.add(f.key);
    }
  }
  const out: string[] = [];
  for (const f of facts) if (!known.has(f.key) && !out.includes(f.token)) out.push(f.token);
  return out;
}

/**
 * The only signals that hand a thread to a person (and so silence Aiden on
 * it): the customer asked for one, the merchant's own hand-over rule, or a
 * sensitive topic. A flow's Assign step hands over on its own (flow engine).
 * Every other signal — nothing to answer from, a repeat, a failed lookup —
 * keeps Aiden talking and files the question for the merchant.
 */
const HAND_OFF_SIGNALS = new Set(["asked_for_person", "merchant_rule", "sensitive_topic"]);

export function isHandOffSignal(signal: string | null | undefined): boolean {
  return Boolean(signal && HAND_OFF_SIGNALS.has(signal));
}

/**
 * The customer asks to talk to a person (any business): "speak to a human",
 * "can someone call me", "agent please", "kisi se baat karni hai". Asking
 * whether a product suits a person is not asking for one.
 */
const PERSON_ASK = [
  /\b(speak|talk|chat)(ing)?\s+(to|with)\s+(a\s+|an\s+|the\s+|some\s+|your\s+)?(human|person|real person|someone|somebody|agent|representative|executive|staff|team|owner|manager|support|customer care)\b/i,
  /\b(human|real person|live agent|customer care|customer support|representative)\s*(please|pls|plz)?\s*$/i,
  /\b(agent|human|person|executive)\s+(please|pls|plz)\b/i,
  /\b(connect|transfer|put)\s+me\s+(to|with|through)\b/i,
  /\b(can|could|will)\s+(someone|somebody|anyone|you)\s+(please\s+)?call\s+me\b/i,
  /\bcall\s+me\s+(back|please|pls|asap|now)\b/i,
  /\b(kisi|insaan|aadmi|owner|manager|staff)\s+se\s+baat\b/i,
  /\bbaat\s+(karni|karna|karao|karwao|karwa\s+do|kara\s+do)\b/i,
  /\b(mujhe\s+)?call\s+(karo|kariye|karna|kar\s+do|karein)\b/i,
];

export function asksForPerson(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  return PERSON_ASK.some((re) => re.test(q));
}

/** Observable signals only — never the model's own opinion of its certainty. */
export function decideEscalation(input: {
  question: string;
  answer: string;
  knowledgeMatched: boolean;
  toolUsed: boolean;
  /** False when the run asked for tools and the broker handed it none. */
  toolsBrokered?: boolean;
  anyToolFailed: boolean;
  history: { role: "user" | "assistant"; content: string }[];
  merchantRules: string;
  /** Questions this customer already asked where the AI failed or handed over. */
  priorFailedQuestions?: string[];
  /** What language they wrote in, when the webhook could tell. */
  customerLanguage?: string | null;
}): string | null {
  // Small talk is answerable on its own. Nothing below applies to "heya".
  if (isSmallTalk(input.question, input.customerLanguage ?? null)) return null;

  // A customer who asks for a person gets one, whatever else happened.
  if (asksForPerson(input.question)) return "asked_for_person";

  if (input.anyToolFailed) return "tool_failed";

  // A starved agent and an unanswerable question must never look the same.
  if (input.toolsBrokered === false) return "no_tools";

  const topic = topicNeedsHuman(input.question, input.merchantRules);
  if (topic) return topic;

  // Only a repeat of something we already got wrong is worth a person's time.
  const now = normaliseQuestion(input.question);
  const failedBefore = (input.priorFailedQuestions ?? []).map(normaliseQuestion);
  if (now && failedBefore.includes(now)) return "question_repeated";

  const frustration = ["not helpful", "useless", "speak to a human", "agent please", "this is ridiculous", "worst"];
  if (frustration.some((f) => now.includes(f))) return "customer_frustrated";

  // Only when the question genuinely needed a source or a lookup.
  if (!input.knowledgeMatched && !input.toolUsed && looksLikeLookup(input.question)) {
    return "no_source";
  }

  return null;
}


/** Trace fields are ours, not the model's — keep them out of the prompt. */
/** Pull product pictures out of a catalogue lookup. Nothing else is kept. */
export function collectProductMedia(
  toolName: string,
  result: { ok?: boolean; data?: unknown },
  into: RunMedia[],
): void {
  if (toolName !== "catalog_search" && toolName !== "search_products") return;
  if (result.ok === false || !Array.isArray(result.data)) return;
  for (const row of result.data as Array<Record<string, unknown>>) {
    const imageUrl = typeof row["image_url"] === "string" ? row["image_url"].trim() : "";
    const title = typeof row["title"] === "string" ? row["title"].trim() : "";
    if (!imageUrl || !/^https?:\/\//i.test(imageUrl) || !title) continue;
    if (into.some((m) => m.imageUrl === imageUrl)) continue;
    const price = row["price"];
    const str = (key: string) =>
      typeof row[key] === "string" && (row[key] as string).trim()
        ? (row[key] as string).trim()
        : null;
    // The catalogue knows a product by the same id the sync pushed, and only
    // a product that was actually pushed (or read back from a linked
    // catalogue) can be sent as a card.
    const retailerId = str("external_id") ?? str("sku") ?? str("id");
    const source = str("source");
    into.push({
      title,
      imageUrl,
      price: typeof price === "number" ? price : price === null || price === undefined ? null : Number(price) || null,
      currency: typeof row["currency"] === "string" ? row["currency"] : null,
      productUrl: typeof row["product_url"] === "string" ? row["product_url"] : null,
      retailerId,
      category: str("category"),
      inCatalog: Boolean(retailerId) && (Boolean(str("meta_synced_at")) || source === "meta_catalog"),
    });

  }
}

/**
 * Show pictures for the products the answer actually names. If the wording
 * doesn't match any title, fall back to the first few results so a browse
 * question still gets pictures.
 */
export function pickMediaForAnswer(found: RunMedia[], answer: string): RunMedia[] {
  if (found.length === 0) return [];
  const text = answer.toLowerCase();
  const named = found.filter((m) => m.title.length > 2 && text.includes(m.title.toLowerCase()));
  return (named.length > 0 ? named : found).slice(0, MAX_PRODUCT_IMAGES);
}

/** A tool result as the model reads it (one string, cut at 6,000 characters). */
function toolView(name: string, result: { ok: boolean; found?: boolean; data?: unknown; error?: string }): string {
  return JSON.stringify(modelView(productToolView(name, result))).slice(0, 6000);
}

function modelView(result: { ok: boolean; found?: boolean; data?: unknown; error?: string }) {
  return {
    ok: result.ok,
    ...(result.found === false
      ? { found: false, note: "This ran fine and found nothing. Say so plainly; do not treat it as a failure." }
      : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * A run tied to one customer chat only ever reads that customer. The owner's
 * onboarding chat and runs with no chat (playground) keep workspace scope.
 */
export function toolSubject(options: {
  channel?: "onboarding" | null | undefined;
  conversationId?: string | null | undefined;
  contactId?: string | null | undefined;
}): ToolContext["subject"] {
  if (options.channel === "onboarding") return undefined;
  if (!options.conversationId && !options.contactId) return undefined;
  return { contactId: options.contactId ?? null, conversationId: options.conversationId ?? null };
}

async function runTool(
  supabase: SupabaseClient,
  organizationId: string,
  actorUserId: string | null,
  principal: ToolPrincipal,
  name: string,
  args: Record<string, unknown>,
  subject: ToolContext["subject"],
  /** The tools this run offered, brokered for this principal at its start. */
  brokered: BrokeredTool[],
) {
  return invokeTool(
    {
      supabase,
      organizationId,
      actorUserId,
      principal,
      initiatedBy: "ai",
      ...(subject ? { subject } : {}),
    },
    name,
    args,
    { brokered },
  );
}

export async function rollUpUsage(
  supabase: SupabaseClient,
  organizationId: string,
  task: string,
  result: RunResult,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  // One statement in the database (ai_usage_add, as meterAiUsage): two runs
  // finishing at once each lost the other's addition, so the monthly cap
  // (billed_amount) under-counted. Until it is applied, the old way below.
  if (Date.now() >= aiUsageAddMissingUntil) {
    const { error } = await supabase.rpc("ai_usage_add", {
      p_org: organizationId,
      p_usage_date: today,
      p_task: task,
      p_runs: 1,
      p_input_tokens: result.inputTokens ?? 0,
      p_output_tokens: result.outputTokens ?? 0,
      p_cost_amount: result.costAmount ?? 0,
      p_billed_amount: result.billedAmount ?? 0,
      p_currency: result.costCurrency ?? "INR",
    });
    if (!error) return;
    const code = String((error as { code?: string }).code ?? "");
    if (code === "PGRST202" || code === "42883") aiUsageAddMissingUntil = Date.now() + 10 * 60_000;
    else console.warn(JSON.stringify({ scope: "ai_usage_add", task, error: error.message }));
  }
  const { data: existing } = await supabase
    .from("ai_usage")
    .select("id, runs, input_tokens, output_tokens, cost_amount, billed_amount")
    .eq("organization_id", organizationId)
    .eq("usage_date", today)
    .eq("task", task)
    .maybeSingle();
  const row = existing as
    | {
        id: string;
        runs: number;
        input_tokens: number;
        output_tokens: number;
        cost_amount: number;
        billed_amount: number;
      }
    | null;
  if (row) {
    await supabase
      .from("ai_usage")
      .update({
        runs: row.runs + 1,
        input_tokens: Number(row.input_tokens) + (result.inputTokens ?? 0),
        output_tokens: Number(row.output_tokens) + (result.outputTokens ?? 0),
        cost_amount: Number(row.cost_amount) + (result.costAmount ?? 0),
        billed_amount: Number(row.billed_amount ?? 0) + (result.billedAmount ?? 0),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
  } else {
    await supabase.from("ai_usage").insert({
      organization_id: organizationId,
      usage_date: today,
      task,
      runs: 1,
      input_tokens: result.inputTokens ?? 0,
      output_tokens: result.outputTokens ?? 0,
      cost_amount: result.costAmount ?? 0,
      billed_amount: result.billedAmount ?? 0,
      currency: result.costCurrency ?? "INR",
    });
  }
}
