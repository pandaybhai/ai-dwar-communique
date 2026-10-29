import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";

/**
 * Batch 49 — Automate (Aiden, Flows, Automations) and Shop (Catalogue,
 * Collections) in the new design, behind `new_design`. These lock: with the
 * flag off every route renders today's page and that page's code is byte for
 * byte what main had; with it on the new page renders; every write the new
 * screens make is the classic screen's own call, character for character;
 * the builder's new step card has exactly the handles of today's; and the
 * words the new screens show.
 */

const h = vi.hoisted(() => ({ newDesign: false }));
vi.mock("@/lib/new-design", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/new-design")>()),
  useNewDesign: () => h.newDesign,
}));

import {
  aidenStatus,
  answersToCheck,
  daysSince,
  freshnessText,
  knowsRows,
} from "@/components/automate-v2/aiden-v2";
import {
  eventText,
  graphForCard,
  stepTitle,
  thumbnailLayout,
  timelineEvents,
  triggerText,
  triggersLine,
} from "@/components/automate-v2/flows-v2";
import { FlowNodeViewV2 } from "@/components/automate-v2/flow-node-v2";
import { AidenStatusCard } from "@/components/automate-v2/aiden-status-card";
import { FlowNodeCard, type RFData } from "@/components/flows/v2/flow-node";
import { NODE_META } from "@/components/flows/v2/node-meta";
import type { EmployeeRun, KnowledgeSource } from "@/lib/employee-client";
import type { FlowGraph, NodeType } from "@/lib/flow-graph";

const src = (path: string) => readFileSync(join(process.cwd(), "src", path), "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The object literal holding `action: "<action>"` (from its `{` to the matching `}`), whitespace and trailing commas dropped. */
function callObject(code: string, action: string): string {
  const at = code.indexOf(`action: "${action}"`);
  if (at < 0) throw new Error(`no action "${action}"`);
  const start = code.lastIndexOf("{", at);
  let depth = 0;
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0)
        return code
          .slice(start, i + 1)
          .replace(/\s+/g, "")
          .replace(/,}/g, "}");
    }
  }
  throw new Error("unbalanced");
}

/** A function's body by name, braces matched. */
function fnBody(code: string, signature: string): string {
  const at = code.indexOf(signature);
  if (at < 0) throw new Error(`no ${signature}`);
  const start = code.indexOf("{", at + signature.length);
  let depth = 0;
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced");
}

const NEW_DIRS = ["components/automate-v2", "components/shop-v2"];
const newFiles = NEW_DIRS.flatMap((d) =>
  readdirSync(join(process.cwd(), "src", d)).map((f) => `${d}/${f}`),
);
const newCode = (f: string) => src(f);

describe("flag off: today's Automate and Shop, unchanged", () => {
  type Lazy = {
    (props: object): {
      type: () => { type: { name: string }; props: { children?: { type: { name: string } } } };
    };
    preload: () => Promise<void>;
  };
  const ROUTES: Array<[string, string, string]> = [
    ["employee", "EmployeePage", "NewAidenPage"],
    ["flows.index", "FlowsPage", "NewFlowsPage"],
    ["automations", "AutomationsPage", "NewAutomationsPage"],
    ["catalog.index", "CatalogPage", "NewCataloguePage"],
    ["catalog.collections", "CollectionsPage", "NewCollectionsPage"],
  ];

  for (const [file, classic, next] of ROUTES) {
    it(`/${file}: ${classic} with new_design off, ${next} with it on`, async () => {
      const { Route } = (await import(`../routes/app/${file}.tsx`)) as {
        Route: { options: { component: unknown } };
      };
      const lazy = Route.options.component as Lazy;
      await lazy.preload();
      const route = lazy({}).type;
      h.newDesign = false;
      expect(route().type.name).toBe(classic);
      h.newDesign = true;
      expect(route().type.name).toBe(next);
      h.newDesign = false;
    });
  }

  it("/flows/v2/$id: the same FlowEditorPage either way, inside .nd-flow-builder only when on", async () => {
    const { Route } = (await import("../routes/app/flows.v2.$id.tsx")) as {
      Route: { options: { component: unknown } };
    };
    const lazy = Route.options.component as Lazy;
    await lazy.preload();
    const route = lazy({}).type;
    h.newDesign = false;
    expect(route().type.name).toBe("FlowEditorPage");
    h.newDesign = true;
    const on = route() as unknown as {
      type: string;
      props: { className: string; children: { type: { name: string } } };
    };
    expect(on.type).toBe("div");
    expect(on.props.className).toBe("nd-flow-builder");
    expect(on.props.children.type.name).toBe("FlowEditorPage");
    h.newDesign = false;
  });

  it("each classic page's code is byte for byte what main had", () => {
    const PINNED: Array<[string, string, string]> = [
      [
        "routes/app/employee.tsx",
        "const MODES = [",
        "06d2dc91c5b8f30cdf2767f30738ea5c4b590deef203963516e8b9f4db2a32b8",
      ],
      [
        "routes/app/flows.index.tsx",
        "function FlowsPage()",
        "ab3ec296328d8ec5bfefb1b63b4cfb8aec3513c2b0c2ca19255d2c16f588c94f",
      ],
      [
        "routes/app/flows.v2.$id.tsx",
        "type Loaded =",
        "59b044e845afa5e823955ff4cb39949cf39c94a1e755a17e3d05f221b9a94303",
      ],
      [
        "routes/app/automations.tsx",
        "function AutomationsPage()",
        "423b9767cb9ccb75b70a61badd2fb75ef01bbcf656002825a0fa6cf67c5fd3aa",
      ],
      [
        "routes/app/catalog.index.tsx",
        "function CatalogPage()",
        "9874c933ff1ce9aafb810c00121c45ab67d55a079d386f23487b135ae825c5b8",
      ],
      [
        "routes/app/catalog.collections.tsx",
        "function CollectionsPage()",
        "ca897a43a79d9455d5887ff78ad5f8d51ab330ae556beb02eef8f27645795c18",
      ],
    ];
    for (const [file, start, hash] of PINNED) {
      const code = src(file);
      expect(sha(code.slice(code.indexOf(start))), file).toBe(hash);
    }
    // Today's step card, and the Triggers panel (which only gained `export` on its names).
    const node = src("components/flows/v2/flow-node.tsx");
    expect(
      sha(node.slice(node.indexOf("function FlowNodeView("), node.indexOf("/** Batch 49"))),
    ).toBe("8705d7e764d9b2620fbf217ca3cc551645a6651174dfc9cf59cd5c70cde994b6");
    expect(
      sha(
        src("components/flows/v2/triggers-panel.tsx").replace(
          "export const KIND_LABELS",
          "const KIND_LABELS",
        ),
      ),
    ).toBe("f117907050c5e5639eca66d2d16a576fe291c08d1fafcc38948a6cbe7cc92bed");
  });

  it("the classic components the new pages reuse don't know the new design", () => {
    for (const f of [
      "components/employee/knowledge-manager.tsx",
      "components/employee/playground.tsx",
      "components/employee/work-log.tsx",
      "components/flows/v2/chat-flows-list.tsx",
      "components/flows/v2/flow-editor.tsx",
      "components/flows/flows-view.tsx",
      "components/automations/automations-view.tsx",
      "components/catalog/catalog-view.tsx",
      "components/catalog/collections-view.tsx",
      "components/catalog/products-summary.tsx",
      "components/catalog/whatsapp-shop-card.tsx",
    ]) {
      expect(src(f), f).not.toMatch(/new-design|useNewDesign|automate-v2|shop-v2/);
    }
  });

  it("the builder's step: today's FlowNodeView with the flag off", () => {
    const data: RFData = { kind: "text", data: { text: "Hi!" } };
    const Card = FlowNodeCard as unknown as React.ComponentType<Record<string, unknown>>;
    h.newDesign = false;
    const off = renderToStaticMarkup(
      <ReactFlowProvider>
        <Card id="n1" data={data} selected={false} type="flow" />
      </ReactFlowProvider>,
    );
    expect(off).toContain("rounded-2xl border bg-card");
    expect(off).not.toContain("nd-flow-step");
    h.newDesign = true;
    const on = renderToStaticMarkup(
      <ReactFlowProvider>
        <Card id="n1" data={data} selected={false} type="flow" />
      </ReactFlowProvider>,
    );
    expect(on).toContain("nd-flow-step");
    h.newDesign = false;
  });
});

describe("every write is the classic screen's own call", () => {
  it("Aiden: the mode switch is the shared hook (Home's), set_mode exactly as the Employee page sends it", () => {
    const page = newCode("components/automate-v2/aiden-page.tsx");
    const card = newCode("components/automate-v2/aiden-status-card.tsx");
    const classic = src("routes/app/employee.tsx");
    const hook = src("hooks/use-aiden-mode-switch.ts");
    expect(page).toContain('from "@/hooks/use-aiden-mode-switch"');
    expect(page + card).not.toContain('action: "set_mode"');
    expect(callObject(hook, "set_mode")).toBe(callObject(classic, "set_mode"));
    // Turn on: the Employee page's save_settings with ai_enabled.
    expect(callObject(page, "save_settings")).toBe(callObject(classic, "save_settings"));
    expect(callObject(page, "overview")).toBe(callObject(classic, "overview"));
  });

  it("Aiden: Test Aiden asks through the Playground's run; Teach uses UnansweredList's and WorkLog's calls", () => {
    const test = newCode("components/automate-v2/test-aiden.tsx");
    const review = newCode("components/automate-v2/aiden-review.tsx");
    const playground = src("components/employee/playground.tsx");
    const knowledge = src("components/employee/knowledge-manager.tsx");
    const work = src("components/employee/work-log.tsx");
    expect(callObject(test, "playground")).toBe(callObject(playground, "playground"));
    expect(test).toContain("aiRunApi<");
    expect(callObject(review, "answer_gap")).toBe(callObject(knowledge, "answer_gap"));
    expect(callObject(review, "dismiss_gap")).toBe(callObject(knowledge, "dismiss_gap"));
    expect(callObject(review, "correct")).toBe(callObject(work, "correct"));
    // The same success words the merchant already knows.
    expect(review).toContain("Sent to the customer — and I'll remember it.");
    expect(review).toContain("Saved. It will use your answer from now on.");
  });

  it("Flows: restore, create and delete are the classic list's", () => {
    const list = newCode("components/automate-v2/chat-flows-v2.tsx");
    const classic = src("components/flows/v2/chat-flows-list.tsx");
    expect(callObject(list, "restore_flow")).toBe(callObject(classic, "restore_flow"));
    expect(callObject(list, "create")).toBe(callObject(classic, "create"));
    expect(list).toContain("<DeleteFlowDialog");
    expect(list).not.toContain('"delete_flow"');
  });

  it("Automations: the switch and delete are the classic view's functions, line for line", () => {
    const next = newCode("components/automate-v2/automations-v2.tsx");
    const classic = src("components/automations/automations-view.tsx");
    for (const sig of [
      "async function toggle(row: AutomationRow, next: boolean)",
      "async function confirmDelete()",
    ]) {
      // Same code; only line breaks may differ (Prettier on the new file).
      const norm = (code: string) => code.replace(/\s+/g, "").replace(/,([)}\]])/g, "$1");
      expect(norm(fnBody(next, sig))).toBe(norm(fnBody(classic, sig)));
    }
    expect(next).toContain("<AutomationDrawer");
  });

  it("Shop: Refresh from website is ProductsSummary's read_changes", () => {
    const overview = newCode("components/shop-v2/shop-overview.tsx");
    const classic = src("components/catalog/products-summary.tsx");
    expect(callObject(overview, "read_changes")).toBe(callObject(classic, "read_changes"));
    const pages = newCode("components/shop-v2/shop-pages.tsx");
    for (const c of ["<CatalogView", "<CollectionsView", "<WhatsAppShopCard", "<CategoryWordsCard"])
      expect(pages).toContain(c);
  });

  it("the new screens add no write path: no insert, upsert, rpc; update/delete only in the copied Automations functions", () => {
    for (const f of newFiles) {
      const code = newCode(f);
      expect(code, f).not.toMatch(/\.(insert|upsert|rpc)\(/);
      if (f.endsWith("automations-v2.tsx")) continue;
      expect(code, f).not.toMatch(/\.(update|delete)\(/);
    }
    // Every API action the new screens send is one a classic file already sends.
    const classicCode = [
      "routes/app/employee.tsx",
      "components/employee/playground.tsx",
      "components/employee/knowledge-manager.tsx",
      "components/employee/work-log.tsx",
      "components/flows/v2/chat-flows-list.tsx",
      "components/catalog/products-summary.tsx",
    ]
      .map(src)
      .join("\n");
    const actions = new Set(
      newFiles.flatMap((f) => [...newCode(f).matchAll(/action: "([a-z_]+)"/g)].map((m) => m[1]!)),
    );
    for (const a of actions) expect(classicCode, a).toContain(`action: "${a}"`);
  });
});

describe("the builder: drawing only, the same handles", () => {
  const types = Object.keys(NODE_META) as NodeType[];
  /** Each React Flow handle as "source|target:position:id" (a target has no id). */
  const handles = (html: string) =>
    [...html.matchAll(/<div([^>]*class="react-flow__handle[^"]*")[^>]*>/g)]
      .map((m) => {
        const attrs = m[1]!;
        const id = /data-handleid="([^"]*)"/.exec(attrs)?.[1] ?? "";
        const pos = /data-handlepos="([a-z]+)"/.exec(attrs)?.[1] ?? "";
        const kind =
          /\b(source|target)\b/.exec(/class="([^"]*)"/.exec(attrs)?.[1] ?? "")?.[1] ?? "";
        return `${kind}:${pos}:${id}`;
      })
      .sort();
  const sample: Record<string, Record<string, unknown>> = {
    buttons: {
      text: "Pick",
      buttons: [
        { id: "b1", title: "Yes" },
        { id: "b2", title: "No" },
      ],
    },
    list: { text: "Pick", rows: [{ id: "r1", title: "One" }] },
    branch: { branches: [{ id: "br1", label: "VIP" }] },
  };

  for (const kind of types) {
    it(`${kind}: the new step card has exactly today's handles`, () => {
      const data: RFData = { kind, data: sample[kind] ?? NODE_META[kind].defaults() };
      const props = { id: "n1", data, selected: false, type: "flow" } as unknown as Parameters<
        typeof FlowNodeViewV2
      >[0];
      h.newDesign = false;
      const classic = renderToStaticMarkup(
        <ReactFlowProvider>
          {(() => {
            const Card = FlowNodeCard as unknown as React.ComponentType<typeof props>;
            return <Card {...props} />;
          })()}
        </ReactFlowProvider>,
      );
      const next = renderToStaticMarkup(
        <ReactFlowProvider>
          <FlowNodeViewV2 {...props} />
        </ReactFlowProvider>,
      );
      expect(handles(next)).toEqual(handles(classic));
      if (kind !== "note") expect(handles(classic).length).toBeGreaterThan(0);
    });
  }

  it("its styles apply only under html[data-design=new] .nd-flow-builder", () => {
    const css = src("components/automate-v2/flow-builder-v2.css");
    const selectors = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .map((block) => block.split("{")[0]!.trim())
      .filter((sel) => sel && !sel.startsWith("@media"));
    for (const sel of selectors) {
      for (const part of sel.split(",")) {
        expect(part.trim(), part).toMatch(/^html\[data-design="new"\] \.nd-flow-builder/);
      }
    }
    expect(css).toContain("prefers-reduced-motion: reduce");
  });
});

describe("Aiden's words", () => {
  it("switched off for the workspace wins over the agent's mode", () => {
    expect(aidenStatus("replying", false, "Aiden")).toMatchObject({
      mode: "off",
      orb: "off",
      title: "Aiden is switched off",
    });
    expect(aidenStatus("replying", true, "Aiden")).toMatchObject({
      mode: "replying",
      orb: "replying",
    });
    expect(aidenStatus("draft", true, "Meera")).toMatchObject({
      mode: "draft",
      orb: "draft",
      title: "Meera writes, you send",
    });
    expect(aidenStatus("weird", true, "Aiden").mode).toBe("off");
  });

  it("the switch follows the Employee page's rule: switched off, only Off can be pressed; without ai.configure nothing can", () => {
    const base = {
      name: "Aiden",
      busy: null,
      onSetMode: () => {},
      onTurnOn: () => {},
      turningOn: false,
      week: { answered: 3, passed: 1 },
      spend: 12,
      currency: "INR",
      testedRecently: true,
    };
    const off = renderToStaticMarkup(
      <AidenStatusCard {...base} mode="replying" aiEnabled={false} canConfigure />,
    );
    const button = (html: string, label: string) =>
      new RegExp(`<button[^>]*>${label}</button>`).exec(html)?.[0] ?? "";
    const isDisabled = (b: string) => / disabled=""/.test(b);
    expect(button(off, "Off")).toContain('aria-pressed="true"');
    expect(isDisabled(button(off, "Off"))).toBe(false);
    expect(isDisabled(button(off, "Drafts"))).toBe(true);
    expect(isDisabled(button(off, "Replying"))).toBe(true);
    expect(off).toContain("Turn Aiden on");
    const viewer = renderToStaticMarkup(
      <AidenStatusCard {...base} mode="draft" aiEnabled canConfigure={false} />,
    );
    for (const l of ["Off", "Drafts", "Replying"]) expect(isDisabled(button(viewer, l))).toBe(true);
    expect(button(viewer, "Drafts")).toContain('aria-pressed="true"');
    expect(viewer).toContain("Configure");
  });

  it("freshness in days, from the source's own last read", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(daysSince(null, now)).toBeNull();
    expect(freshnessText("2026-10-29T08:00:00Z", now)).toBe("updated today");
    expect(freshnessText("2026-10-28T08:00:00Z", now)).toBe("updated yesterday");
    expect(freshnessText("2026-10-20T12:00:00Z", now)).toBe("updated 9 days ago");
  });

  it("what Aiden knows: website, documents, your answers, catalogue; deleted websites left out", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    const s = (o: Partial<KnowledgeSource>): KnowledgeSource =>
      ({
        id: "x",
        type: "website",
        name: "x",
        status: "ready",
        item_count: 0,
        last_synced_at: null,
        last_error: null,
        ...o,
      }) as KnowledgeSource;
    const rows = knowsRows(
      [
        s({
          id: "w",
          name: "kesar.example",
          item_count: 126,
          last_synced_at: "2026-10-27T12:00:00Z",
        }),
        s({ id: "old", name: "old.example", deleted: { at: "x", purge_after: "y", products: 0 } }),
        s({
          id: "p",
          type: "pdf",
          name: "Returns.pdf",
          item_count: 14,
          last_synced_at: "2026-10-20T12:00:00Z",
        }),
        s({ id: "q", type: "manual_qa", name: "Answers", item_count: 1 }),
      ],
      { products: 8, lastUpdated: "2026-10-29T11:00:00Z" },
      now,
    );
    expect(rows.map((r) => [r.key, r.label, r.detail, r.state])).toEqual([
      ["website", "kesar.example", "126 pages, updated 2 days ago", "ok"],
      ["documents", "Documents", "1 file, updated 9 days ago", "ok"],
      ["answers", "Your answers", "1 answer you wrote", "ok"],
      ["catalogue", "Catalogue", "8 products, updated today", "ok"],
    ]);
    expect(knowsRows([s({ status: "syncing", item_count: 4 })], null, now)[0]).toMatchObject({
      state: "reading",
      detail: "Reading now, 4 pages so far",
    });
    expect(knowsRows([s({ status: "error" })], null, now)[0]!.state).toBe("problem");
    expect(knowsRows([], null, now).map((r) => r.state)).toEqual(["empty", "empty", "empty"]);
  });

  it("answers to check: customer replies passed on or not given, one per question, newest first", () => {
    const run = (o: Partial<EmployeeRun>): EmployeeRun =>
      ({
        id: "r",
        task: "agent_reply",
        status: "ok",
        escalation_signal: null,
        input_summary: "q",
        created_at: "",
        ...o,
      }) as EmployeeRun;
    const got = answersToCheck([
      run({ id: "1", status: "escalated", input_summary: "Discount?" }),
      run({ id: "2", status: "ok", input_summary: "Timings?" }),
      run({ id: "3", status: "refused", input_summary: "Buy back gold?" }),
      run({ id: "4", status: "escalated", input_summary: "discount? " }),
      run({ id: "5", task: "suggest_reply", status: "escalated", input_summary: "Draft" }),
      run({ id: "6", status: "error", input_summary: "Broke" }),
    ]);
    expect(got.map((r) => r.id)).toEqual(["1", "3"]);
  });
});

describe("Flows' words and shapes", () => {
  it("triggers in the Triggers panel's names, keywords quoted", () => {
    expect(triggerText({ kind: "keyword", config: { keywords: ["menu", "hi", "hello"] } })).toBe(
      "Keyword “menu”, “hi” and 1 more",
    );
    expect(triggerText({ kind: "first_message", config: {} })).toBe("First message ever");
    expect(triggersLine([])).toBe("No trigger yet");
    expect(triggersLine([{ flow_id: "f", kind: "manual", config: {}, is_enabled: false }])).toBe(
      "Its triggers are switched off",
    );
    expect(
      triggersLine([
        { flow_id: "f", kind: "first_message", config: {}, is_enabled: true },
        { flow_id: "f", kind: "keyword", config: { keywords: ["menu"] }, is_enabled: true },
      ]),
    ).toBe("Starts on: First message ever and 1 more");
  });

  const graph: FlowGraph = {
    nodes: [
      { id: "s", type: "start", position: { x: 0, y: 0 }, data: {} },
      {
        id: "m",
        type: "buttons",
        position: { x: 320, y: 0 },
        data: { text: "Hi! How can we help today?" },
      },
      {
        id: "a",
        type: "ask",
        position: { x: 640, y: 200 },
        data: { text: "Order number?", label: "Order number" },
      },
      { id: "n", type: "note", position: { x: 2000, y: 2000 }, data: { text: "note" } },
    ],
    edges: [
      { id: "e1", source: "s", target: "m", sourceHandle: "next" },
      { id: "e2", source: "m", target: "a", sourceHandle: "b1" },
      { id: "e3", source: "m", target: "gone", sourceHandle: "b2" },
    ],
  };

  it("the mini map fits every step but notes inside the box, and draws only links between drawn steps", () => {
    const { boxes, lines } = thumbnailLayout(graph, 280, 120, 12);
    expect(boxes.map((b) => b.id)).toEqual(["s", "m", "a"]);
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(11.99);
      expect(b.y).toBeGreaterThanOrEqual(11.99);
      expect(b.x + b.w).toBeLessThanOrEqual(268.01);
      expect(b.y + b.h).toBeLessThanOrEqual(108.01);
    }
    expect(lines.map((l) => l.id)).toEqual(["e1", "e2"]);
    expect(thumbnailLayout(null)).toEqual({ boxes: [], lines: [] });
  });

  it("the card shows the published graph, else the newest draft", () => {
    const g = (n: number): FlowGraph => ({
      nodes: [{ id: String(n), type: "start", data: {} }],
      edges: [],
    });
    const v = [
      { flow_id: "f", status: "draft", version: 3, graph: g(3) },
      { flow_id: "f", status: "published", version: 2, graph: g(2) },
      { flow_id: "x", status: "draft", version: 1, graph: g(1) },
    ];
    expect(graphForCard(v, "f")).toBe(v[1]!.graph);
    expect(graphForCard(v, "x")).toBe(v[2]!.graph);
    expect(graphForCard(v, "none")).toBeNull();
  });

  it("run timeline: steps named from the run's graph, bookkeeping rows dropped", () => {
    expect(stepTitle(graph, "a")).toBe("Order number");
    expect(stepTitle(graph, "m")).toBe("Buttons “Hi! How can we help today?”");
    expect(stepTitle(graph, "missing")).toBeNull();
    expect(eventText("send", stepTitle(graph, "m"))).toBe(
      "Sent Buttons “Hi! How can we help today?”",
    );
    expect(eventText("reply", "Order number")).toBe("Customer answered Order number");
    expect(eventText("http_failed", null)).toBe("Web request failed");
    expect(eventText("started", "Start")).toBe("Started");
    expect(eventText("brand_new_event", null)).toBe("brand new event");
    const ev = [
      { event: "started" },
      { event: "entered" },
      { event: "send" },
      { event: "exited" },
      { event: "reply" },
    ];
    expect(timelineEvents(ev).map((e) => e.event)).toEqual(["started", "send", "reply"]);
    expect(timelineEvents(ev, 2).map((e) => e.event)).toEqual(["send", "reply"]);
  });
});

describe("Hallmark floor on the new screens", () => {
  it("no transition-all, no tracked capitals, no middle-dot strings; loading pulses stop under reduced motion", () => {
    for (const f of newFiles) {
      const code = newCode(f);
      expect(code, f).not.toMatch(/transition-all|transition:\s*all/);
      if (f.endsWith(".tsx")) {
        expect(code, f).not.toMatch(/\buppercase\b|tracking-wide/);
        // The one allowed: removing a shared helper's middle dot (`.replace(" · ", ", ")`).
        expect(code.replaceAll('.replace(" · ", ", ")', ""), f).not.toContain("·");
      }
      for (const line of code.split("\n").filter((l) => l.includes("animate-pulse"))) {
        expect(line, f).toContain("motion-reduce:animate-none");
      }
    }
  });
});
