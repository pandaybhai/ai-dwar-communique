import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryDb } from "./test-support/memory-db";

/**
 * Batch 15B (part 1), items 2–4:
 *  (2) Inbox "Improve this answer" on any Aiden reply — one text, a part of a
 *      multi-part reply, or a product picture — opening the existing
 *      CorrectionDialog (knowledge "correct" → saveCorrection);
 *  (3) admin Test → Compare: the workspace's last 20 customer questions, each
 *      run through the Test path (aiden_test: never sent, never billed) with
 *      the saved instructions and with a draft;
 *  (4) the Test tab shows each picture with its caption, in send order.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  calls: [] as Array<{ question: string; override: string | null; preview: unknown }>,
  run: null as null | Record<string, unknown>,
}));
vi.mock("@/lib/whatsapp-webhook.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-webhook.server")>()),
  getServiceClient: () => h.db!.supabase,
}));
vi.mock("@/lib/whatsapp-api.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-api.server")>()),
  isSuperAdmin: async () => true,
  logServerActivity: async () => undefined,
}));
vi.mock("@/lib/billing-notify.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/billing-notify.server")>()),
  resolvePlatformOrg: async () => null,
}));
vi.mock("@/lib/ai-tasks.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-tasks.server")>()),
  playgroundAnswer: async (
    _s: unknown,
    _c: unknown,
    question: string,
    _tier: unknown,
    override: string | null,
    _cmp: unknown,
    preview: unknown,
  ) => {
    h.calls.push({ question, override, preview });
    return h.run;
  },
}));

import { aiRunFor, questionBefore, type AiRunRow } from "./inbox-ai-runs";
import { replySendOrder } from "./reply-order.server";
import { Bubble } from "@/components/inbox/chat-thread";
import { SendSequence } from "@/components/admin/send-sequence";
import { runBothSides } from "./aiden-compare";
import { Route as AdminAiRoute } from "../routes/api/admin/ai";
import type { ChosenProduct, RunMedia, RunResult } from "./ai-run.server";
import type { MessageRow } from "@/components/inbox/inbox-utils";

const ORG = "81c234b2-569f-40be-ad71-96c046de5d12";
const IMG = "https://cdn.example.com/p";

afterEach(() => {
  h.calls = [];
  h.run = null;
});

const media = (title: string, price: number | null, extra: Partial<RunMedia> = {}): RunMedia => ({
  title,
  imageUrl: `${IMG}/${encodeURIComponent(title)}.jpg`,
  price,
  currency: "INR",
  productUrl: `https://shop.example.com/${encodeURIComponent(title)}`,
  retailerId: null,
  category: "rings",
  inCatalog: false,
  ...extra,
});
const chosen = (title: string, caption: string, hasPhoto = true): ChosenProduct => ({
  ...media(title, 19604),
  productId: `id-${title}`,
  caption,
  hasPhoto,
  ...(hasPhoto ? {} : { imageUrl: "" }),
});

// ------------------------------------------------------------ (2) the Inbox

describe("(2) Inbox — which Aiden answer a message came from", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 6, 10, 0, s)).toISOString();
  const runs: AiRunRow[] = [
    {
      output: "Here are two rings under ₹20,000:\n\nWould you like to visit our Somajiguda showroom?",
      input_summary: "rings under 20k",
      sources: [{ sourceType: "manual_qa" }],
      created_at: at(30),
    },
    { output: "We deliver across India in 5–7 days.", input_summary: "do you deliver to pune", sources: [], created_at: at(0) },
  ];
  const msg = (over: Partial<MessageRow>): MessageRow => ({
    id: "m",
    conversation_id: "c",
    direction: "outbound",
    type: "text",
    body: "",
    media_url: null,
    media_mime: null,
    template_name: null,
    status: "sent",
    error_detail: null,
    sent_by: null,
    metadata: null,
    created_at: at(31),
    ...over,
  });

  it("a whole one-message reply (as before)", () => {
    const note = aiRunFor(msg({ body: "We deliver across India in 5–7 days.", created_at: at(2) }), runs);
    expect(note).toMatchObject({ question: "do you deliver to pune", reply: "We deliver across India in 5–7 days.", taughtOn: null });
  });
  it("each part of a multi-part reply, and each product picture, belongs to its run", () => {
    expect(aiRunFor(msg({ body: "Here are two rings under ₹20,000:" }), runs)?.question).toBe("rings under 20k");
    expect(aiRunFor(msg({ body: "Would you like to visit our Somajiguda showroom?", created_at: at(33) }), runs)?.reply).toMatch(/^Here are two rings/);
    const picture = msg({ type: "image", body: "The Gilded Chevron — ₹19,604", media_url: "x", metadata: { kind: "ai_product", product_id: "p1" }, created_at: at(32) });
    expect(aiRunFor(picture, runs)).toMatchObject({ question: "rings under 20k", taughtOn: expect.any(String) });
  });
  it("never a teammate's, a flow's, a campaign's or a customer's message", () => {
    expect(aiRunFor(msg({ body: "We deliver across India in 5–7 days.", sent_by: "u1" }), runs)).toBeNull();
    expect(aiRunFor(msg({ body: "Here are two rings under ₹20,000:", metadata: { kind: "flow_v2" } }), runs)).toBeNull();
    expect(aiRunFor(msg({ body: "Here are two rings under ₹20,000:", direction: "inbound" }), runs)).toBeNull();
    // Words no answer wrote, and a picture long after any answer.
    expect(aiRunFor(msg({ body: "Your order has shipped!" }), runs)).toBeNull();
    expect(aiRunFor(msg({ metadata: { kind: "ai_product" }, created_at: new Date(Date.UTC(2026, 9, 6, 11)).toISOString() }), runs)).toBeNull();
  });
  it("the question falls back to the customer's message before the reply", () => {
    const list = [msg({ direction: "inbound", body: "do you have ruby rings?" }), msg({ body: "x" }), msg({ body: "y" })];
    expect(questionBefore(list, 2)).toBe("do you have ruby rings?");
    expect(questionBefore(list, 0)).toBe("");
  });
  it("the bubble offers 'Improve this answer' and hands over the whole reply", () => {
    const seen: unknown[] = [];
    const note = aiRunFor(msg({ body: "Here are two rings under ₹20,000:" }), runs)!;
    const html = renderToStaticMarkup(
      <Bubble message={msg({ body: "Here are two rings under ₹20,000:" })} organizationId="org" agentName="Aiden" aiRun={note} onTeach={(n) => seen.push(n)} />,
    );
    expect(html).toContain("Improve this answer");
    expect(html).not.toContain("Not right");
    // Without the permission to save answers there is no button.
    const plain = renderToStaticMarkup(<Bubble message={msg({ body: "Hi" })} organizationId="org" agentName="Aiden" aiRun={note} />);
    expect(plain).not.toContain("Improve this answer");
  });
  it("the dialog saves through the existing 'correct' action (saveCorrection), no new table", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../components/inbox/correction-dialog.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/action: "correct"/);
    const route = readFileSync(new URL("../routes/api/ai/knowledge.ts", import.meta.url), "utf8");
    expect(route).toMatch(/action === "add_answer" \|\| action === "correct"/);
    expect(route).toMatch(/saveCorrection\(/);
  });
});

// ------------------------------------------------- (4) pictures in send order

describe("(4) a test reply in send order, each picture with its caption", () => {
  it("send_products: words, then that part's products in the model's order; no photo → its caption as text", () => {
    const steps = replySendOrder({
      output: "ignored when there are parts",
      media: [],
      parts: [
        { kind: "text", text: "Two rings for you:" },
        {
          kind: "products",
          items: [
            chosen("The Gilded Chevron", "The Gilded Chevron — ₹19,604, 18K gold"),
            chosen("ZERN-0207", "Diamond Gold Earrings — ₹39,296", false),
            chosen("Onyx Skyline", "Onyx Skyline — ₹52,275"),
          ],
        },
        { kind: "text", text: "Shall I book a visit?" },
      ],
    });
    expect(steps).toEqual([
      { kind: "text", text: "Two rings for you:" },
      expect.objectContaining({ kind: "picture", title: "The Gilded Chevron", caption: "The Gilded Chevron — ₹19,604, 18K gold" }),
      { kind: "text", text: "Diamond Gold Earrings — ₹39,296" },
      expect.objectContaining({ kind: "picture", title: "Onyx Skyline", caption: "Onyx Skyline — ₹52,275" }),
      { kind: "text", text: "Shall I book a visit?" },
    ]);
  });
  it("no send_products: the answer, then up to 3 pictures captioned name — price (as the reply path does)", () => {
    const steps = replySendOrder({
      output: "  Here you go  ",
      media: [media("A", 1000), media("B", null), media("C", 3000), media("D", 4000)],
    });
    expect(steps.map((s) => (s.kind === "text" ? s.text : s.caption))).toEqual(["Here you go", "A — ₹1,000", "B", "C — ₹3,000"]);
    expect(replySendOrder({ output: "", media: [media("A", 1000)] })).toEqual([]);
  });
  it("the Test tab draws them numbered, caption under each picture", () => {
    const html = renderToStaticMarkup(
      <SendSequence
        steps={[
          { kind: "text", text: "Two rings:" },
          { kind: "picture", title: "Gilded", image_url: `${IMG}/g.jpg`, caption: "Gilded — ₹19,604", price: 19604, currency: "INR" },
          { kind: "picture", title: "Onyx", image_url: `${IMG}/o.jpg`, caption: "", price: null, currency: null },
        ]}
      />,
    );
    expect(html.indexOf("Two rings:")).toBeLessThan(html.indexOf("Gilded — ₹19,604"));
    expect(html.indexOf("Gilded — ₹19,604")).toBeLessThan(html.indexOf(`${IMG}/o.jpg`));
    expect(html).toContain("<figcaption");
    expect(html).toContain("No caption");
    expect(html).toContain("2 pictures");
  });
});

// --------------------------------------------- (3)/(4) the admin route

describe("/api/admin/ai — Test tab and Compare", () => {
  type Post = (ctx: { request: Request }) => Promise<Response>;
  const post = (AdminAiRoute.options as unknown as { server: { handlers: { POST: Post } } }).server.handlers.POST;
  const call = async (body: Record<string, unknown>) => {
    const res = await post({ request: new Request("http://x/api/admin/ai", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(body) }) });
    return (await res.json()) as Record<string, unknown>;
  };
  const world = (messages: Array<Record<string, unknown>> = []) => {
    const db = memoryDb({ messages });
    Object.assign(db.supabase, { auth: { getUser: async () => ({ data: { user: { id: "admin-1" } } }) } });
    h.db = db;
    return db;
  };
  const run = (over: Partial<RunResult> = {}): RunResult =>
    ({
      runId: "r1",
      status: "ok",
      output: "Two rings for you:",
      sources: [],
      toolCalls: [],
      media: [media("The Gilded Chevron", 19604)],
      parts: [
        { kind: "text", text: "Two rings for you:" },
        { kind: "products", items: [chosen("The Gilded Chevron", "Gilded — ₹19,604"), chosen("Onyx Skyline", "Onyx — ₹52,275")] },
      ],
      escalationSignal: null,
      needsOwner: false,
      latencyMs: 1200,
      tier: "standard",
      ...over,
    }) as RunResult;

  it("aiden_test returns the reply in send order, captions included; still preview (never sent or billed)", async () => {
    world();
    h.run = run();
    const out = await call({ action: "aiden_test", organization_id: ORG, question: "rings under 20k" });
    expect(out["sequence"]).toEqual([
      { kind: "text", text: "Two rings for you:" },
      expect.objectContaining({ kind: "picture", caption: "Gilded — ₹19,604" }),
      expect.objectContaining({ kind: "picture", caption: "Onyx — ₹52,275" }),
    ]);
    // The old fields are still there for anything reading them.
    expect(out["media"]).toEqual([expect.objectContaining({ title: "The Gilded Chevron" })]);
    expect(h.calls[0]).toMatchObject({ question: "rings under 20k", override: null, preview: { history: [] } });
  });

  it("aiden_questions: the workspace's last 20 customer questions, newest first, no repeats", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      organization_id: ORG,
      direction: "inbound",
      body: i === 29 ? "Do you have ruby rings?" : `Question number ${i}?`,
      created_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    }));
    rows.push({ organization_id: ORG, direction: "inbound", body: "do you have RUBY rings?", created_at: new Date(Date.UTC(2026, 9, 1, 0, 28, 30)).toISOString() });
    rows.push({ organization_id: ORG, direction: "outbound", body: "Our reply, not a question", created_at: new Date(Date.UTC(2026, 9, 2)).toISOString() });
    rows.push({ organization_id: "other-org", direction: "inbound", body: "Someone else's question", created_at: new Date(Date.UTC(2026, 9, 3)).toISOString() });
    world(rows);
    const out = await call({ action: "aiden_questions", organization_id: ORG });
    const qs = out["questions"] as string[];
    expect(qs).toHaveLength(20);
    expect(qs[0]).toBe("Do you have ruby rings?");
    expect(qs).not.toContain("do you have RUBY rings?");
    expect(qs.join(" ")).not.toMatch(/Our reply|Someone else/);
  });

  it("Compare runs each question twice through aiden_test: saved instructions, then the draft in their place", async () => {
    world();
    h.run = run();
    // One request at a time through the real route (vitest's lazy mocks race
    // when two first imports overlap); the order of the two sides is kept.
    let queue: Promise<unknown> = Promise.resolve();
    const callApi = (body: Record<string, unknown>) => {
      const next = queue.then(async () => ({ data: await call(body), error: null }));
      queue = next;
      return next;
    };
    const row = await runBothSides(ORG, "rings under 20k", "Always offer the showroom visit.", callApi);
    expect(h.calls.map((c) => c.override)).toEqual([null, "Always offer the showroom visit."]);
    expect(h.calls.every((c) => (c.preview as { history?: unknown[] }).history?.length === 0)).toBe(true);
    expect(row.current?.sequence?.map((s) => s.kind)).toEqual(["text", "picture", "picture"]);
    expect(row.draft?.sequence?.map((s) => s.kind)).toEqual(["text", "picture", "picture"]);
  });
});
