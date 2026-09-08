/**
 * What the AI employee knows.
 *
 * One connector interface: a source type returns documents. Chunking,
 * embedding, retrieval, the agent and the screens know nothing about where a
 * document came from, so a new origin is one new function in CONNECTORS and no
 * other change anywhere.
 *
 * Live facts — orders, stock, price, availability — are never stored here.
 * They are looked up at question time through the tool broker.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { embedTexts, EMBEDDING_MODEL } from "@/lib/ai-run.server";
import {
  READER_COST,
  fetchWithTimeout,
  readPage,
  readerKey,
  stripHtml,
} from "@/lib/web-reader.server";

export type SourceType =
  | "website"
  | "pdf"
  | "spreadsheet"
  | "manual_qa"
  | "image"
  | "docx"
  /** Everything an owner sent on the merchant channel — one per workspace. */
  | "upload";

/** One normalised item, whatever its origin. */
export type KnowledgeDocument = {
  /** Stable within the source: a URL, a row number, a page number. */
  sourceRef: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type ConnectorContext = {
  supabase: SupabaseClient;
  organizationId: string;
  sourceId: string;
  config: Record<string, unknown>;
  onStage?: (stage: CrawlStage) => void;
};

export type Connector = (ctx: ConnectorContext) => Promise<KnowledgeDocument[]>;

export type CrawlStage =
  | "discover"
  | "sitemap"
  | "fetch"
  | "reader"
  | "extract"
  | "facts"
  | "embed"
  | "finish";

// ------------------------------------------------------------------ helpers

const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;
const DEFAULT_PAGE_CAP = 200;
const RUN_PAGE_CAP = 500;

/** Very small robots.txt reader: honours Disallow for User-agent: *. */
async function disallowedPaths(origin: string): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(`${origin}/robots.txt`, 8000);
    if (!res || !res.ok) return [];
    const body = await res.text();
    const rules: string[] = [];
    let applies = false;
    for (const raw of body.split("\n")) {
      const line = raw.split("#")[0]?.trim() ?? "";
      if (/^user-agent:/i.test(line)) applies = line.split(":")[1]?.trim() === "*";
      else if (applies && /^disallow:/i.test(line)) {
        const path = line.slice(line.indexOf(":") + 1).trim();
        if (path) rules.push(path);
      }
    }
    return rules;
  } catch {
    return [];
  }
}

export function chunkText(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= CHUNK_CHARS) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_CHARS, clean.length);
    if (end < clean.length) {
      const boundary = clean.lastIndexOf(". ", end);
      if (boundary > start + CHUNK_CHARS / 2) end = boundary + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks.filter(Boolean);
}

// --------------------------------------------------------------- connectors

/** Tidy one candidate address: same site, no hash, no campaign tags. */
function normalizeUrl(href: string, base: string, origin: string): string | null {
  try {
    const url = new URL(href, base);
    if (url.origin !== origin) return null;
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^utm_|^gclid$|^fbclid$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Which pages matter to a customer. A shop's shipping page is worth more than
 * its blog archive, so the useful pages are read first and a small budget
 * still learns the important things.
 */
function scoreUrl(url: string, origin: string): number {
  const path = url.slice(origin.length).toLowerCase() || "/";
  if (/\b(blog|tag|category|cart|checkout|account|login|search|wp-json|feed)\b/.test(path)) return -10;
  if (/\/page\/\d+/.test(path)) return -10;
  if (/\.(jpg|jpeg|png|gif|svg|pdf|xml|css|js)$/.test(path)) return -10;
  if (path === "/" || path === "") return 10;
  if (/(about|contact|faq|help|shipping|delivery|return|refund|pricing|price|plans|policy|terms)/.test(path))
    return 8;
  if (/(products|collections|shop|menu|services|catalog)/.test(path)) return 6;
  return 2;
}

/** Addresses the site itself publishes, sitemap indexes included. */
async function sitemapUrls(origin: string): Promise<string[]> {
  const found: string[] = [];
  const queue = [`${origin}/sitemap.xml`];
  let files = 0;
  while (queue.length > 0 && files < 4) {
    const next = queue.shift()!;
    files += 1;
    const res = await fetchWithTimeout(next, 8000);
    if (!res || !res.ok) continue;
    const xml = await res.text().catch(() => "");
    const locs = Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m: RegExpMatchArray) => m[1] ?? "");
    const isIndex = /<sitemapindex/i.test(xml);
    for (const loc of locs) {
      if (isIndex) {
        if (queue.length < 3) queue.push(loc);
      } else {
        found.push(loc);
      }
    }
  }
  return found;
}

/** How many pages this workspace's plan allows us to read. */
async function planPageCap(supabase: SupabaseClient, organizationId: string): Promise<number> {
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("plan_version_id")
    .eq("organization_id", organizationId)
    .in("status", ["active", "trialing", "past_due"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const versionId = (sub as { plan_version_id?: string } | null)?.plan_version_id;
  if (!versionId) return DEFAULT_PAGE_CAP;
  const { data: version } = await supabase
    .from("plan_versions")
    .select("limits")
    .eq("id", versionId)
    .maybeSingle();
  const limits = (version as { limits?: Record<string, unknown> } | null)?.limits ?? {};
  const pages = Number(limits["pages"] ?? 0);
  return pages > 0 ? pages : DEFAULT_PAGE_CAP;
}

/**
 * Shops publish their whole catalogue as plain data. When we can see one, we
 * read it directly rather than scraping product pages one by one.
 */
async function commerceDocuments(
  origin: string,
  homepageHtml: string,
  cap: number,
): Promise<KnowledgeDocument[]> {
  const docs: KnowledgeDocument[] = [];

  const push = (
    ref: string,
    title: string,
    content: string,
    metadata: Record<string, unknown>,
  ) => {
    if (docs.length >= cap || content.trim().length < 20) return;
    docs.push({ sourceRef: ref, title: title.slice(0, 200), content: content.slice(0, 20000), metadata });
  };

  if (/cdn\.shopify\.com/i.test(homepageHtml)) {
    for (let page = 1; page <= 10 && docs.length < cap; page += 1) {
      const res = await fetchWithTimeout(`${origin}/products.json?limit=250&page=${page}`, 8000);
      if (!res || !res.ok) break;
      const json = (await res.json().catch(() => ({}))) as { products?: Array<Record<string, unknown>> };
      const products = json.products ?? [];
      if (products.length === 0) break;
      for (const product of products) {
        const handle = String(product["handle"] ?? "");
        const title = String(product["title"] ?? handle);
        const body = stripHtml(String(product["body_html"] ?? "")).text;
        const variants = (product["variants"] as Array<Record<string, unknown>> | undefined) ?? [];
        const lines = variants.map(
          (v) =>
            `${String(v["title"] ?? "Default")}: ${String(v["price"] ?? "")} ${
              v["available"] === false ? "(out of stock)" : "(available)"
            }`,
        );
        const price = variants[0]?.["price"] ?? null;
        push(
          `${origin}/products/${handle}`,
          title,
          `${title}\n${body}\n${lines.join("\n")}\n${origin}/products/${handle}`,
          {
            kind: "product",
            price,
            available: variants.some((v) => v["available"] !== false),
            url: `${origin}/products/${handle}`,
          },
        );
      }
      if (products.length < 250) break;
    }

    for (const path of ["refund-policy", "shipping-policy", "privacy-policy", "terms-of-service"]) {
      if (docs.length >= cap) break;
      const res = await fetchWithTimeout(`${origin}/policies/${path}`, 8000);
      if (!res || !res.ok) continue;
      const { title, text } = stripHtml(await res.text().catch(() => ""));
      push(`${origin}/policies/${path}`, title || path, text, { url: `${origin}/policies/${path}` });
    }
    return docs;
  }

  if (/wp-content/i.test(homepageHtml)) {
    for (let page = 1; page <= 10 && docs.length < cap; page += 1) {
      const res = await fetchWithTimeout(
        `${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`,
        8000,
      );
      if (!res || !res.ok) break;
      const products = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
      if (!Array.isArray(products) || products.length === 0) break;
      for (const product of products) {
        const title = String(product["name"] ?? "");
        const body = stripHtml(String(product["description"] ?? "")).text;
        const prices = (product["prices"] as Record<string, unknown> | undefined) ?? {};
        const price = prices["price"] ?? null;
        const link = String(product["permalink"] ?? `${origin}/?p=${String(product["id"] ?? "")}`);
        push(link, title, `${title}\n${body}\nPrice: ${String(price ?? "")}\n${link}`, {
          kind: "product",
          price,
          available: product["is_in_stock"] !== false,
          url: link,
        });
      }
      if (products.length < 100) break;
    }
  }

  return docs;
}

/**
 * Turn one long page into plain facts, keeping every number exactly as it was
 * written. Chunks made from facts retrieve far better than chunks made from
 * navigation menus and cookie notices.
 */
async function factsPass(
  supabase: SupabaseClient,
  organizationId: string,
  docs: KnowledgeDocument[],
): Promise<number> {
  const { executeRun } = await import("@/lib/ai-run.server");
  let cost = 0;
  for (const doc of docs) {
    if ((doc.metadata as Record<string, unknown> | undefined)?.["kind"] === "product") continue;
    if (doc.content.length <= 1500) continue;
    try {
      const run = await executeRun(supabase, {
        organizationId,
        task: "agent_reply",
        tier: "everyday",
        input: doc.content.slice(0, 16000),
        system:
          "Rewrite this page as 5–15 plain factual sentences about the business, keeping every number, " +
          "price, date, place and product name exactly as written. Skip navigation and legal boilerplate.",
        metadata: { purpose: "knowledge_facts" },
        billingExempt: true,
      });
      const output = (run.output ?? "").trim();
      if (output.length > 80) {
        doc.metadata = { ...(doc.metadata ?? {}), raw_excerpt: doc.content.slice(0, 2000) };
        doc.content = output;
      }
      cost += run.costAmount ?? 0;
      const { meterAiUsage } = await import("@/lib/ai-run.server");
      await meterAiUsage(supabase, organizationId, "knowledge_facts", {
        costAmount: run.costAmount ?? 0,
        inputTokens: run.inputTokens ?? 0,
        outputTokens: run.outputTokens ?? 0,
      });
    } catch {
      // A page we couldn't summarise is still worth keeping as it was.
    }
  }
  return cost;
}

const crawlWebsite: Connector = async ({ supabase, organizationId, sourceId, config, onStage }) => {
  onStage?.("discover");
  const startUrl = String(config["url"] ?? "").trim();
  if (!startUrl) throw new Error("Add the address of the website first.");
  const start = new URL(startUrl);
  const origin = start.origin;

  const mode = config["mode"] === "full" ? "full" : "day0";
  const planCap = mode === "full" ? await planPageCap(supabase, organizationId) : 30;
  const cap = mode === "full" ? Math.min(planCap, RUN_PAGE_CAP) : 30;
  const concurrency = mode === "full" ? 6 : 4;
  const deadline = mode === "day0" ? Date.now() + 90_000 : null;

  onStage?.("sitemap");
  const [blocked, sitemap, key, settings]: [string[], string[], string | null, { data: unknown }] =
    await Promise.all([
      disallowedPaths(origin),
      sitemapUrls(origin),
      readerKey(supabase),
      supabase.from("platform_settings").select("day0_crawl_cost_cap").maybeSingle(),
    ]);
  const costCap = Number(
    (settings.data as { day0_crawl_cost_cap?: number } | null)?.day0_crawl_cost_cap ?? 2,
  );

  // The homepage first: it tells us whether this is a shop with public data.
  const home = await readPage(start.toString(), { key, ...(onStage ? { onStage } : {}) });
  let readerCost = home?.usedReader ? READER_COST : 0;

  const candidates = new Map<string, number>();
  const consider = (raw: string, base: string) => {
    const url = normalizeUrl(raw, base, origin);
    if (!url) return;
    const score = scoreUrl(url, origin);
    if (score <= -10) return;
    if (blocked.some((p) => new URL(url).pathname.startsWith(p))) return;
    if (!candidates.has(url)) candidates.set(url, score);
  };

  consider(start.toString(), start.toString());
  for (const loc of sitemap) consider(loc, origin);
  for (const href of home?.links ?? []) consider(href, start.toString());

  const ordered = Array.from(candidates.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url)
    .slice(0, cap);

  const docs: KnowledgeDocument[] = [];
  if (home && home.text.length > 200) {
    docs.push({
      sourceRef: start.toString(),
      title: home.title || start.pathname,
      content: home.text.slice(0, 40000),
      metadata: { url: start.toString() },
    });
  }

  let seen = docs.length;
  const queue = ordered.filter((u) => u !== start.toString());

  const worker = async () => {
    while (queue.length > 0 && docs.length < cap) {
      if (deadline && Date.now() > deadline) return;
      const next = queue.shift();
      if (!next) return;
      const allowReader = readerCost + READER_COST <= costCap;
      const page = await readPage(next, { key, allowReader, ...(onStage ? { onStage } : {}) });
      seen += 1;
      if (page?.usedReader) readerCost += READER_COST;
      if (!page || page.text.length <= 200) continue;
      docs.push({
        sourceRef: next,
        title: page.title || new URL(next).pathname,
        content: page.text.slice(0, 40000),
        metadata: { url: next },
      });
      if (seen % 5 === 0) {
        await supabase.from("knowledge_sources").update({ pages_seen: seen }).eq("id", sourceId);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Shops hand over their catalogue directly; no need to walk every product.
  if (home?.html) {
    const room = Math.max(cap - docs.length, 0);
    if (room > 0) docs.push(...(await commerceDocuments(origin, home.html, room)));
  }

  if (docs.length === 0) throw new Error("We couldn't read any pages from that address.");

  onStage?.("facts");
  const factsCost = await factsPass(supabase, organizationId, docs);

  await supabase
    .from("knowledge_sources")
    .update({ pages_seen: seen, cost_amount: readerCost + factsCost })
    .eq("id", sourceId);

  return docs;
};


/** Pages of a PDF, one document each. */
export async function parsePdf(
  bytes: Uint8Array,
  name: string,
): Promise<KnowledgeDocument[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];
  const docs = pages
    .map((page, index) => ({
      sourceRef: `page-${index + 1}`,
      title: `${name} — page ${index + 1}`,
      content: String(page).replace(/\s+/g, " ").trim(),
      metadata: { page: index + 1, file: name },
    }))
    .filter((d) => d.content.length > 40);
  if (docs.length === 0) throw new Error("That file had no readable text in it.");
  return docs;
}

/** Rows of a spreadsheet, one document each. CSV and XLSX alike. */
export async function parseSpreadsheet(
  bytes: Uint8Array,
  name: string,
): Promise<KnowledgeDocument[]> {
  const XLSX = await import("xlsx");
  const book = XLSX.read(bytes, { type: "array" });
  const docs: KnowledgeDocument[] = [];
  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    rows.forEach((row, index) => {
      const content = Object.entries(row)
        .filter(([, value]) => String(value).trim().length > 0)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
      if (content.trim().length < 3) return;
      docs.push({
        sourceRef: `${sheetName}!${index + 2}`,
        title: `${name} — ${String(Object.values(row)[0] ?? `row ${index + 2}`)}`,
        content,
        metadata: { sheet: sheetName, row: index + 2, file: name },
      });
    });
  }
  if (docs.length === 0) throw new Error("That spreadsheet had no rows we could read.");
  return docs;
}

/**
 * Uploaded files are read once, at upload. We keep the text they contained,
 * never the file, so there is nothing to re-fetch on a refresh.
 */
const rereadUpload: Connector = async ({ supabase, sourceId }) => {
  const { data } = await supabase
    .from("knowledge_documents")
    .select("source_ref, title, content, metadata")
    .eq("source_id", sourceId);
  return ((data ?? []) as Array<{
    source_ref: string;
    title: string;
    content: string;
    metadata: Record<string, unknown>;
  }>).map((d) => ({
    sourceRef: d.source_ref,
    title: d.title,
    content: d.content,
    metadata: d.metadata ?? {},
  }));
};


/** Written answers, including corrections a merchant makes to a wrong reply. */
const readManualQa: Connector = async ({ supabase, sourceId }) => {
  const { data } = await supabase
    .from("knowledge_documents")
    .select("source_ref, title, content, metadata")
    .eq("source_id", sourceId);
  return ((data ?? []) as Array<KnowledgeDocument & { source_ref: string }>).map((d) => ({
    sourceRef: d.source_ref,
    title: d.title,
    content: d.content,
    metadata: (d.metadata ?? {}) as Record<string, unknown>,
  }));
};

export const CONNECTORS: Record<SourceType, Connector> = {
  website: crawlWebsite,
  pdf: rereadUpload,
  spreadsheet: rereadUpload,
  image: rereadUpload,
  docx: rereadUpload,
  upload: rereadUpload,
  manual_qa: readManualQa,
};

// ------------------------------------------------------------------ syncing

/** Fetch, store and embed one source. Returns how many items it now holds. */
export async function syncSource(
  supabase: SupabaseClient,
  sourceId: string,
  options?: { onStage?: (stage: CrawlStage) => void; preserveError?: boolean },
): Promise<{ ok: boolean; itemCount: number; error?: string }> {
  const { data } = await supabase
    .from("knowledge_sources")
    .select("id, organization_id, type, name, config")
    .eq("id", sourceId)
    .maybeSingle();
  const source = data as
    | { id: string; organization_id: string; type: SourceType; name: string; config: Record<string, unknown> }
    | null;
  if (!source) return { ok: false, itemCount: 0, error: "That source no longer exists." };

  const connector = CONNECTORS[source.type];
  if (!connector) return { ok: false, itemCount: 0, error: "We can't read that kind of source yet." };

  await supabase
    .from("knowledge_sources")
    .update({ status: "syncing", last_error: null })
    .eq("id", sourceId);

  try {
    const documents = await connector({
      supabase,
      organizationId: source.organization_id,
      sourceId,
      config: source.config ?? {},
      ...(options?.onStage ? { onStage: options.onStage } : {}),
    });

    options?.onStage?.("embed");
    for (const doc of documents) {
      await upsertDocument(supabase, source.organization_id, sourceId, doc);
    }

    // Anything the source no longer has is forgotten, so a deleted page stops
    // being quoted at customers.
    const keep = documents.map((d) => d.sourceRef);
    if (keep.length > 0 && source.type !== "manual_qa") {
      await supabase
        .from("knowledge_documents")
        .delete()
        .eq("source_id", sourceId)
        .not("source_ref", "in", `(${keep.map((k) => `"${k.replace(/"/g, '""')}"`).join(",")})`);
    }

    await supabase
      .from("knowledge_sources")
      .update({
        status: "ready",
        item_count: documents.length,
        last_synced_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", sourceId);

    return { ok: true, itemCount: documents.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "We couldn't read that source.";
    const name = error instanceof Error ? error.name : "Error";
    if (options?.preserveError) throw error;
    await supabase
      .from("knowledge_sources")
      .update({ status: "error", last_error: message.slice(0, 300) })
      .eq("id", sourceId);
    return { ok: false, itemCount: 0, error: message };
  }
}

/** Store one document and (re)build its chunks when the text has changed. */
export async function upsertDocument(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
  doc: KnowledgeDocument,
): Promise<void> {
  const hash = await hashText(doc.content);

  const { data: existing } = await supabase
    .from("knowledge_documents")
    .select("id, content_hash")
    .eq("source_id", sourceId)
    .eq("source_ref", doc.sourceRef)
    .maybeSingle();
  const prior = existing as { id: string; content_hash: string | null } | null;

  let documentId = prior?.id ?? null;

  if (prior) {
    await supabase
      .from("knowledge_documents")
      .update({ title: doc.title, content: doc.content, metadata: doc.metadata ?? {}, content_hash: hash })
      .eq("id", prior.id);
    if (prior.content_hash === hash) {
      const { count } = await supabase
        .from("knowledge_chunks")
        .select("id", { count: "exact", head: true })
        .eq("document_id", prior.id)
        .eq("embedding_model", EMBEDDING_MODEL);
      if ((count ?? 0) > 0) return; // unchanged and already read
    }
  } else {
    const { data: inserted } = await supabase
      .from("knowledge_documents")
      .insert({
        organization_id: organizationId,
        source_id: sourceId,
        source_ref: doc.sourceRef,
        title: doc.title,
        content: doc.content,
        metadata: doc.metadata ?? {},
        content_hash: hash,
      })
      .select("id")
      .maybeSingle();
    documentId = (inserted as { id?: string } | null)?.id ?? null;
  }

  if (!documentId) return;

  const chunks = chunkText(doc.content);
  if (chunks.length === 0) return;
  const vectors = await embedTexts(chunks, { supabase, organizationId });

  await supabase
    .from("knowledge_chunks")
    .delete()
    .eq("document_id", documentId)
    .eq("embedding_model", EMBEDDING_MODEL);

  const rows = chunks.map((text, index) => ({
    organization_id: organizationId,
    source_id: sourceId,
    document_id: documentId,
    source_ref: doc.sourceRef,
    chunk_index: index,
    text,
    embedding: JSON.stringify(vectors[index] ?? []),
    embedding_model: EMBEDDING_MODEL,
    dimensions: (vectors[index] ?? []).length || 1536,
  }));

  for (let i = 0; i < rows.length; i += 50) {
    await supabase.from("knowledge_chunks").insert(rows.slice(i, i + 50));
  }
}


/**
 * Add a website as something the employee reads, then read it. One
 * implementation, shared by the knowledge screen and the owner's chat with
 * Aiden, so both behave identically.
 */
export async function addWebsiteSource(
  supabase: SupabaseClient,
  organizationId: string,
  url: string,
  createdBy: string | null,
  options?: { mode?: "day0" | "full" },
): Promise<{
  ok: boolean;
  sourceId: string | null;
  itemCount: number;
  queued?: boolean;
  error?: string;
}> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { ok: false, sourceId: null, itemCount: 0, error: "That isn't a full web address." };
  }

  const { data, error } = await supabase
    .from("knowledge_sources")
    .insert({
      organization_id: organizationId,
      type: "website",
      name: hostname,
      config: { url, mode: options?.mode ?? "day0" },
      status: "pending",
      queued_at: new Date().toISOString(),
      refresh_days: 7,
      created_by: createdBy,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    return { ok: false, sourceId: null, itemCount: 0, error: "We couldn't add that website." };
  }

  // Reading a real website takes minutes, so it never happens on the request
  // that asked for it: the worker picks the queued source up within a minute.
  return { ok: true, sourceId: (data as { id: string }).id, itemCount: 0, queued: true };
}


/** A merchant's correction becomes a written answer, attributed and dated. */
export async function saveCorrection(
  supabase: SupabaseClient,
  organizationId: string,
  input: { question: string; answer: string; userId: string | null; agentId?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  let { data: source } = await supabase
    .from("knowledge_sources")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("type", "manual_qa")
    .limit(1)
    .maybeSingle();

  if (!source) {
    const { data: created, error } = await supabase
      .from("knowledge_sources")
      .insert({
        organization_id: organizationId,
        type: "manual_qa",
        name: "Answers you wrote",
        status: "ready",
        refresh_days: 0,
        created_by: input.userId,
      })
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, error: "We couldn't save that correction." };
    source = created as { id: string };
  }

  const sourceId = (source as { id: string }).id;
  await upsertDocument(supabase, organizationId, sourceId, {
    sourceRef: `qa-${await hashText(input.question)}`,
    title: input.question.slice(0, 120),
    content: `Question: ${input.question}\nAnswer: ${input.answer}`,
    metadata: {
      corrected_by: input.userId,
      corrected_at: new Date().toISOString(),
      agent_id: input.agentId ?? null,
    },
  });

  const { count } = await supabase
    .from("knowledge_documents")
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId);
  await supabase
    .from("knowledge_sources")
    .update({ item_count: count ?? 0, last_synced_at: new Date().toISOString(), status: "ready" })
    .eq("id", sourceId);

  return { ok: true };
}

async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Read an uploaded file once and keep its text. The file itself is not stored:
 * a merchant can see and delete every item it produced.
 */
export async function ingestUpload(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
  fileName: string,
  bytes: Uint8Array,
  kind: "pdf" | "spreadsheet" | "image" | "docx",
  options: {
    /** The file's real mime type (pictures are sent as-is to the model). */
    mime?: string | null;
    /** Extra metadata on every item, e.g. the Meta media id it came from. */
    extra?: Record<string, unknown>;
    /**
     * Set when several files share one source: item refs are prefixed so two
     * PDFs' "page-1" never overwrite each other.
     */
    refPrefix?: string | null;
  } = {},
): Promise<{ ok: boolean; itemCount: number; error?: string }> {
  try {
    const docs =
      kind === "pdf"
        ? await parsePdf(bytes, fileName)
        : kind === "image"
          ? await readImage(supabase, organizationId, bytes, fileName, options.mime ?? null)
          : kind === "docx"
            ? await parseDocx(bytes, fileName)
            : await parseSpreadsheet(bytes, fileName);
    for (const doc of docs) {
      const stamped: KnowledgeDocument = {
        ...doc,
        sourceRef: options.refPrefix ? `${options.refPrefix}:${doc.sourceRef}` : doc.sourceRef,
        metadata: { kind, ...(doc.metadata ?? {}), ...(options.extra ?? {}) },
      };
      await upsertDocument(supabase, organizationId, sourceId, stamped);
    }
    // A shared source counts everything it holds, not just this file.
    const { count } = await supabase
      .from("knowledge_documents")
      .select("id", { count: "exact", head: true })
      .eq("source_id", sourceId);
    await supabase
      .from("knowledge_sources")
      .update({
        status: "ready",
        item_count: count ?? docs.length,
        last_synced_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", sourceId);
    return { ok: true, itemCount: docs.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "We couldn't read that file.";
    await supabase
      .from("knowledge_sources")
      .update({ status: "error", last_error: message.slice(0, 300) })
      .eq("id", sourceId);
    return { ok: false, itemCount: 0, error: message };
  }
}

/** The one source every file an owner sends on the merchant channel lands in. */
export async function ensureUploadSource(
  supabase: SupabaseClient,
  organizationId: string,
  createdBy: string | null,
): Promise<{ id: string; cost_amount: number } | null> {
  const { data: existing } = await supabase
    .from("knowledge_sources")
    .select("id, cost_amount")
    .eq("organization_id", organizationId)
    .eq("type", "upload")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing) {
    return { id: (existing as { id: string }).id, cost_amount: Number((existing as { cost_amount?: number }).cost_amount ?? 0) };
  }
  const { data: created } = await supabase
    .from("knowledge_sources")
    .insert({
      organization_id: organizationId,
      type: "upload",
      name: "Files you sent",
      config: {},
      refresh_days: 0,
      status: "ready",
      created_by: createdBy,
    })
    .select("id")
    .maybeSingle();
  return created ? { id: (created as { id: string }).id, cost_amount: 0 } : null;
}


/** A Word document, one item per heading section. */
export async function parseDocx(
  bytes: Uint8Array,
  name: string,
): Promise<KnowledgeDocument[]> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.convertToHtml({
    buffer: Buffer.from(bytes as unknown as ArrayLike<number>),
  });
  const parts = String(value).split(/(?=<h[1-3][^>]*>)/i);
  const docs: KnowledgeDocument[] = [];
  parts.forEach((part, index) => {
    const { title, text } = stripHtml(part);
    const heading = stripHtml(part.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] ?? "").text;
    if (text.trim().length < 40) return;
    docs.push({
      sourceRef: `section-${index + 1}`,
      title: heading || title || `${name} — part ${index + 1}`,
      content: text,
      metadata: { file: name, section: index + 1 },
    });
  });
  if (docs.length === 0) throw new Error("That document had no readable text in it.");
  return docs;
}

/** A photo of a price list or menu, read out in words. */
export async function readImage(
  supabase: SupabaseClient,
  organizationId: string,
  bytes: Uint8Array,
  name: string,
  mime: string | null = null,
): Promise<KnowledgeDocument[]> {
  const { executeRun, meterAiUsage } = await import("@/lib/ai-run.server");
  const base64 = Buffer.from(bytes as unknown as ArrayLike<number>).toString("base64");
  const imageMime = mime && mime.startsWith("image/") ? mime.split(";")[0]! : "image/jpeg";
  const run = await executeRun(supabase, {
    organizationId,
    task: "agent_reply",
    tier: "everyday",
    input: "Read this picture.",
    imageDataUrl: `data:${imageMime};base64,${base64}`,
    system:
      "Transcribe every piece of text in this image exactly, keeping prices and numbers as written; " +
      "then list the items or services shown.",
    metadata: { purpose: "knowledge_image" },
    billingExempt: true,
  });
  // Platform-paid, but the cost still lands on the workspace's meter like a reader call.
  await meterAiUsage(supabase, organizationId, "knowledge_image", {
    costAmount: run.costAmount ?? 0,
    inputTokens: run.inputTokens ?? 0,
    outputTokens: run.outputTokens ?? 0,
    runs: 1,
  });
  const text = (run.output ?? "").trim();
  if (text.length < 20) throw new Error("We couldn't read any text in that picture.");
  return [
    {
      sourceRef: `image-${await hashText(name + text.slice(0, 200))}`,
      title: name,
      content: text,
      metadata: { file: name, kind: "image" },
    },
  ];
}
