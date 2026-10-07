import { describe, expect, it, vi } from "vitest";
import { fakeDb } from "./test-support/fake-db";

/**
 * Batch 21 item 3 — staff_handoff_alert is part of the platform's template
 * set, so Admin → Billing → "Create billing templates" submits it exactly like
 * the other notices (same create path as the Templates page, UTILITY, its own
 * examples), and skips it once held.
 */

const created: Array<{ organizationId: string; draft: Record<string, unknown> }> = [];
vi.mock("@/lib/template-create.server", () => ({
  createTemplateFromDraft: async (_db: unknown, input: { organizationId: string; draft: Record<string, unknown> }) => {
    created.push(input);
    return { ok: true };
  },
}));

describe("staff_handoff_alert in the platform template sync", () => {
  it("is listed with the definition handoff-alerts sends", async () => {
    const { BILLING_TEMPLATES } = await import("./billing-notify.server");
    const { STAFF_HANDOFF_TEMPLATE } = await import("./handoff-alerts.server");
    expect(BILLING_TEMPLATES.filter((t) => t.name === "staff_handoff_alert")).toEqual([STAFF_HANDOFF_TEMPLATE]);
  });

  it("Create billing templates submits it as UTILITY with its four examples; held already → skipped", async () => {
    vi.stubEnv("PLATFORM_ORG_ID", "platform-org");
    const { ensureBillingTemplates } = await import("./billing-notify.server");
    const run = async (held: string[]) => {
      created.length = 0;
      const db = fakeDb((op) => {
        if (op.table === "profiles") return { data: { is_super_admin: true }, error: null };
        // Batch 21b: one read of what the platform already holds, any language.
        if (op.table === "message_templates") return { data: held.map((name) => ({ name, language: "en_US", status: "PENDING" })), error: null };
        return undefined;
      });
      return ensureBillingTemplates(db.supabase, "admin-1");
    };
    const report = await run([]);
    expect(report.created).toContain("staff_handoff_alert");
    const draft = created.find((c) => c.draft["name"] === "staff_handoff_alert")!;
    expect(draft.organizationId).toBe("platform-org");
    expect(draft.draft).toMatchObject({
      category: "UTILITY",
      language: "en",
      body: "AiDwar alert for {{1}}: {{2}} is waiting for a person in the Inbox because {{3}}. Open the Inbox here: {{4}} — Aiden has stepped back on this chat until your team replies.",
      bodyExamples: { "1": "Sharma Textiles", "2": "Asha (+91 98765 43210)", "3": "a customer asked to talk to a person", "4": "https://aidwar.in/app/inbox" },
    });
    const again = await run(["staff_handoff_alert"]);
    expect(again.skipped).toContain("staff_handoff_alert");
    expect(created.some((c) => c.draft["name"] === "staff_handoff_alert")).toBe(false);
    vi.unstubAllEnvs();
  });
});
