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

export type SourceType = "website" | "pdf" | "spreadsheet" | "manual_qa";

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
};

export type Connector = (ctx: ConnectorContext) => Promise<KnowledgeDocument[]>;

// ------------------------------------------------------------------ helpers

const MAX_PAGES = 40;
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;

function stripHtml(html: string): { title: string; text: string; links: string[] } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const links = Array.from(html.matchAll(/href=["']([^"'#]+)["']/gi)).map((m) => m[1] ?? "");
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return { title: (titleMatch?.[1] ?? "").trim(), text, links };
}

/** Very small robots.txt reader: honours Disallow for User-agent: *. */
async function disallowedPaths(origin: string): Promise<string[]> {
  try {
    const res = await fetch(`${origin}/robots.txt`, { redirect: "follow" });
    if (!res.ok) return [];
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

const crawlWebsite: Connector = async ({ config }) => {
  const startUrl = String(config["url"] ?? "").trim();
  if (!startUrl) throw new Error("Add the address of the website first.");
  const start = new URL(startUrl);
  const cap = Math.min(Number(config["page_cap"] ?? MAX_PAGES) || MAX_PAGES, MAX_PAGES);
  const blocked = await disallowedPaths(start.origin);

  const queue = [start.toString()];
  const seen = new Set<string>();
  const docs: KnowledgeDocument[] = [];

  while (queue.length > 0 && docs.length < cap) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);

    const url = new URL(next);
    if (blocked.some((p) => url.pathname.startsWith(p))) continue;

    let html: string;
    try {
      const res = await fetch(next, { redirect: "follow" });
      if (!res.ok) continue;
      const type = res.headers.get("content-type") ?? "";
      if (!type.includes("text/html")) continue;
      html = await res.text();
    } catch {
      continue;
    }

    const { title, text, links } = stripHtml(html);
    if (text.length > 200) {
      docs.push({
        sourceRef: next,
        title: title || url.pathname,
        content: text.slice(0, 40000),
        metadata: { url: next },
      });
    }

    for (const href of links) {
      try {
        const linked = new URL(href, next);
        if (linked.origin !== start.origin) continue;
        linked.hash = "";
        if (!seen.has(linked.toString()) && queue.length + docs.length < cap * 2) {
          queue.push(linked.toString());
        }
      } catch {
        // not a usable link
      }
    }
  }

  if (docs.length === 0) throw new Error("We couldn't read any pages from that address.");
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
  pdf: readPdf,
  spreadsheet: readSpreadsheet,
  manual_qa: readManualQa,
};

// ------------------------------------------------------------------ syncing

/** Fetch, store and embed one source. Returns how many items it now holds. */
export async function syncSource(
  supabase: SupabaseClient,
  sourceId: string,
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
    });

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
  const vectors = await embedTexts(chunks);

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
