import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, ORG, publicApiWorld } from "./test-support/public-api-world";
import {
  documentTemplateStarter,
  draftToComponents,
  templateVariableSpec,
  validateDraft,
} from "./templates";
import { createTemplateFromDraft } from "./template-create.server";
import { resolveApiTemplate } from "./public-api-send.server";

/**
 * Batch 34 item 5 — the invoice starter. A generic UTILITY template with a
 * DOCUMENT header in the existing builder: the merchant edits it, uploads a
 * sample PDF and submits it through the same createTemplateFromDraft every
 * template uses. Nothing is sent: it waits for Meta like any template, and
 * only once approved can the API use it. Fakes only.
 */

afterEach(() => vi.unstubAllGlobals());

describe("the starter", () => {
  it("is a utility template with a document header and three numbered values — nothing about any kind of shop", () => {
    const d = documentTemplateStarter();
    expect(d).toMatchObject({
      category: "UTILITY",
      headerFormat: "DOCUMENT",
      body: "Hi {{1}}, your invoice {{2}} for {{3}} is attached. Thank you.",
      buttons: [],
      cards: [],
    });
    expect(Object.keys(d.bodyExamples)).toEqual(["1", "2", "3"]);
  });

  it("can't be submitted until a sample PDF is uploaded (Meta reviews it with the template)", () => {
    const d = documentTemplateStarter();
    expect(validateDraft(d).length).toBeGreaterThan(0);
    expect(
      validateDraft({
        ...d,
        headerHandle: "4::aGFuZGxl",
        headerMediaUrl: "https://x/sample.pdf",
        headerFileName: "sample.pdf",
      }),
    ).toEqual([]);
  });

  it("is in the template builder as a 'Start from' choice", () => {
    const dialog = readFileSync(
      join(import.meta.dirname, "../components/templates/create-template-dialog.tsx"),
      "utf8",
    );
    expect(dialog).toContain("setDraft(documentTemplateStarter())");
  });
});

describe("submitted through the one template path, then usable by the API only once approved", () => {
  it("createTemplateFromDraft sends Meta a DOCUMENT header and the body with its examples, filed as PENDING", async () => {
    const w = publicApiWorld();
    const net = fakeFetch([
      (c) =>
        c.url.includes("/waba-a/message_templates") && c.method === "POST"
          ? Response.json({ id: "meta-tpl-1", status: "PENDING", category: "UTILITY" })
          : undefined,
    ]);
    vi.stubGlobal("fetch", net.impl);
    const draft = {
      ...documentTemplateStarter(),
      headerHandle: "4::aGFuZGxl",
      headerMediaUrl: "https://x/sample.pdf",
      headerFileName: "sample.pdf",
    };
    const out = await createTemplateFromDraft(w.db.supabase, {
      organizationId: ORG,
      userId: "u-admin",
      draft,
    });
    expect(out).toMatchObject({ ok: true, status: "PENDING" });

    const call = net.calls.find((c) => c.url.includes("message_templates"))!;
    const sent = JSON.parse(String(call.body)) as {
      name: string;
      category: string;
      components: Array<Record<string, unknown>>;
    };
    expect(sent.name).toBe("invoice_document");
    expect(sent.category).toBe("UTILITY");
    expect(sent.components).toEqual(draftToComponents(draft));
    expect(sent.components[0]).toMatchObject({
      type: "HEADER",
      format: "DOCUMENT",
      example: { header_handle: ["4::aGFuZGxl"] },
    });
    expect(sent.components[1]).toMatchObject({
      type: "BODY",
      example: { body_text: [["Asha", "INV-1001", "2,500.00"]] },
    });
    // Nothing was sent to a customer.
    expect(net.calls.some((c) => c.url.endsWith("/messages"))).toBe(false);

    const stored = w.db.rows("message_templates").find((t) => t["name"] === "invoice_document")!;
    expect(stored).toMatchObject({ status: "PENDING", category: "UTILITY", waba_id: "waba-a" });
    expect(templateVariableSpec(stored["components"] as never)).toMatchObject({
      headerMedia: { format: "DOCUMENT" },
      body: [1, 2, 3],
    });

    const pending = await resolveApiTemplate(w.db.supabase, {
      organizationId: ORG,
      wabaId: "waba-a",
      name: "invoice_document",
      language: null,
      paramCount: 3,
    });
    expect(pending.ok ? null : pending.answer.body["code"]).toBe("template_not_approved");
    stored["status"] = "APPROVED"; // Meta approved it (the template webhook / sync)
    const approved = await resolveApiTemplate(w.db.supabase, {
      organizationId: ORG,
      wabaId: "waba-a",
      name: "invoice_document",
      language: null,
      paramCount: 3,
    });
    expect(approved.ok).toBe(true);
  });
});
