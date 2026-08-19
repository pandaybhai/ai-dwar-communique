/**
 * The employee's job description. A skill says what it is for, when not to use
 * it, and what it needs in order to work at all. Only the jobs that are both
 * switched on and actually possible are written into the prompt — every token
 * in that prompt is paid for on every single message.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { agentPrincipal, brokerTools } from "@/lib/ai-tools.server";

export type SkillRow = {
  id: string;
  key: string;
  name: string;
  use_when: string;
  do_not_use_when: string;
  enabled: boolean;
  is_custom: boolean;
  requires: { tools?: string[]; knowledge?: string[]; data?: string[] };
  sort_order: number;
};

export type SkillMissing = {
  text: string;
  /** Where the merchant fixes it. */
  href?: string;
  action?: string;
};

export type SkillState = SkillRow & {
  ready: boolean;
  missing: SkillMissing[];
  locked: boolean;
};

/** What this workspace actually has, checked once for all skills. */
async function workspaceFacts(supabase: SupabaseClient, organizationId: string) {
  const [tools, sources, products, returnsDocs] = await Promise.all([
    brokerTools(supabase, organizationId, agentPrincipal).catch(() => []),
    supabase
      .from("knowledge_sources")
      .select("id, type, name, item_count")
      .eq("organization_id", organizationId),
    supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId),
    supabase
      .from("knowledge_documents")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .or("title.ilike.%return%,title.ilike.%refund%,content.ilike.%refund policy%,content.ilike.%return policy%"),
  ]);

  const sourceRows = (sources.data ?? []) as Array<{ item_count: number }>;
  return {
    toolNames: new Set((tools as Array<{ name: string }>).map((t) => t.name)),
    knowledgeItems: sourceRows.reduce((sum, s) => sum + Number(s.item_count ?? 0), 0),
    productCount: products.count ?? 0,
    returnsDocs: returnsDocs.count ?? 0,
  };
}

export async function listSkills(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<SkillState[]> {
  const [{ data }, facts] = await Promise.all([
    supabase
      .from("ai_skills")
      .select("id, key, name, use_when, do_not_use_when, enabled, is_custom, requires, sort_order")
      .eq("organization_id", organizationId)
      .order("sort_order"),
    workspaceFacts(supabase, organizationId),
  ]);

  return ((data ?? []) as SkillRow[]).map((row) => {
    const requires = row.requires ?? {};
    const missing: SkillMissing[] = [];

    for (const tool of requires.tools ?? []) {
      if (!facts.toolNames.has(tool)) {
        missing.push(
          tool === "catalog_search"
            ? { text: "your product catalogue isn't reachable yet", href: "/app/catalog", action: "Open catalogue" }
            : tool === "lookup_order"
              ? { text: "orders aren't connected yet — connect your store", href: "/app/settings", action: "Connect store" }
              : { text: `the "${tool}" lookup isn't available to me`, href: "/app/employee", action: "Check my tools" },
        );
      }
    }

    for (const need of requires.knowledge ?? []) {
      if (need === "any" && facts.knowledgeItems === 0) {
        missing.push({
          text: "I haven't read anything about your business yet — add your website or a document",
          href: "/app/employee",
          action: "Teach me",
        });
      }
      if (need === "returns_policy" && facts.returnsDocs === 0) {
        missing.push({
          text: "add your returns policy so I can answer this properly",
          href: "/app/employee",
          action: "Add returns policy",
        });
      }
    }

    for (const need of requires.data ?? []) {
      if (need === "products" && facts.productCount === 0) {
        missing.push({
          text: "there are no products in your catalogue yet",
          href: "/app/catalog",
          action: "Add products",
        });
      }
    }

    return { ...row, ready: missing.length === 0, missing, locked: row.key === "opt_out" };
  });
}

/** The lines that go into the prompt: enabled, ready jobs only. */
export function skillsBlock(skills: SkillState[]): string {
  const usable = skills.filter((s) => s.enabled && s.ready);
  if (usable.length === 0) return "";
  return [
    "These are the jobs you handle. If a message is not one of them, hand it to a person.",
    ...usable.map((s) =>
      [
        `- ${s.name}.`,
        s.use_when ? `Use when: ${s.use_when}` : "",
        s.do_not_use_when ? `Never: ${s.do_not_use_when}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    ),
  ].join("\n");
}
