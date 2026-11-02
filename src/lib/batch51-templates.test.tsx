import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 51, gap 2 — deleting a template from Campaigns > Templates. Meta is a
 * fake here (graphFetch is mocked; nothing reaches graph.facebook.com). The
 * route refuses while a campaign that hasn't ended or an active flow sends it,
 * calls Meta's delete for that one template on its own WABA, and marks the row
 * exactly as Meta's DELETED notice does (metaTemplateStatus).
 */

const h = vi.hoisted(() => ({
  db: null as null | ReturnType<typeof import("./test-support/fake-db").fakeDb>,
  denied: [] as string[],
  meta: [] as Array<{
    path: string;
    token: string;
    method?: string;
    query?: Record<string, string>;
  }>,
  metaOk: true,
  logged: [] as Array<{ action: string; details: Record<string, unknown> }>,
}));

vi.mock("@/lib/whatsapp-api.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-api.server")>()),
  requireOrgMember: async () => ({
    supabase: h.db!.supabase,
    organizationId: "org-51",
    userId: "u-51",
    role: "marketer",
  }),
  requirePermission: async (_auth: unknown, key: string) =>
    h.denied.includes(key)
      ? Response.json({ error: "You don't have permission." }, { status: 403 })
      : null,
  logServerActivity: async (
    _d: unknown,
    _o: string,
    _u: string,
    action: string,
    details: Record<string, unknown>,
  ) => {
    h.logged.push({ action, details });
  },
  graphFetch: async (
    path: string,
    token: string,
    init: { method?: string; query?: Record<string, string> } = {},
  ) => {
    h.meta.push({ path, token, ...init });
    return h.metaOk
      ? { ok: true, status: 200, body: { success: true } }
      : { ok: false, status: 400, body: { error: { message: "Template not found" } } };
  },
}));
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  getWhatsAppConnection: async () => ({ connection: null, error: "not used" }),
  listWabaConnections: async () => [
    { wabaId: "waba-other", accessToken: "token-other", accountIds: ["acc-2"] },
    { wabaId: "waba-1", accessToken: "token-1", accountIds: ["acc-1"] },
  ],
}));

import { Route as TemplatesRoute } from "../routes/api/whatsapp/templates";
import { metaTemplateStatus } from "./templates";
import { graphSendsTemplate, CAMPAIGN_STATES_USING_TEMPLATE } from "./template-delete.server";
import { deleteTemplateRequest, isDeletedTemplate } from "@/components/templates-v2/templates-data";

type Post = (a: { request: Request }) => Promise<Response>;
const post = (TemplatesRoute as unknown as { options: { server: { handlers: { POST: Post } } } })
  .options.server.handlers.POST;

const TEMPLATE = {
  id: "tpl-1",
  waba_id: "waba-1",
  meta_template_id: "meta-777",
  name: "diwali_offer",
  language: "en",
  status: "APPROVED",
};

type World = {
  campaigns?: Array<{ id: string; name: string; status: string }>;
  versions?: Array<{ flow_id: string; graph: unknown }>;
  flows?: Array<{ id: string; name: string; is_enabled: boolean; config: Record<string, unknown> }>;
  steps?: Array<{ flows: { name: string; is_enabled: boolean; config: Record<string, unknown> } }>;
  template?: Record<string, unknown> | null;
  failRead?: string;
};

const templateNode = (id: string) => ({
  nodes: [
    { id: "n1", type: "trigger", data: {} },
    { id: "n2", type: "template", data: { template_id: id } },
  ],
  edges: [],
});

function world(w: World = {}) {
  h.meta = [];
  h.logged = [];
  h.metaOk = true;
  h.db = fakeDb((op: FakeOp) => {
    if (w.failRead === op.table) return { data: null, error: { message: "boom" } };
    if (op.table === "message_templates" && op.kind === "select")
      return { data: w.template === undefined ? TEMPLATE : w.template, error: null };
    if (op.table === "campaigns") {
      // The fake doesn't filter: apply the route's status filter here.
      const states = op.filters.find(([m]) => m === "in")?.[1]?.[1] as string[];
      return { data: (w.campaigns ?? []).filter((c) => states.includes(c.status)), error: null };
    }
    if (op.table === "flow_versions") return { data: w.versions ?? [], error: null };
    if (op.table === "flows") return { data: w.flows ?? [], error: null };
    if (op.table === "flow_steps") return { data: w.steps ?? [], error: null };
    return undefined;
  });
  return h.db;
}

const del = (body: Record<string, unknown> = deleteTemplateRequest("org-51", "tpl-1")) =>
  post({
    request: new Request("http://x/api/whatsapp/templates", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  });

const updates = (db: ReturnType<typeof world>) =>
  db.ops.filter((o) => o.table === "message_templates" && o.kind === "update");

describe("delete a template: the fake Meta call and the local mark", () => {
  it("calls Meta's delete for that template on its own business account", async () => {
    const db = world();
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(h.meta).toEqual([
      {
        path: "waba-1/message_templates",
        token: "token-1",
        method: "DELETE",
        query: { hsm_id: "meta-777", name: "diwali_offer" },
      },
    ]);
    // Marked as Meta's DELETED notice marks it (the webhook and sync's mapping).
    const [mark, hide] = updates(db);
    expect(mark!.payload).toMatchObject({
      status: metaTemplateStatus("DELETED"),
      rejection_reason: null,
    });
    expect(metaTemplateStatus("DELETED")).toBe("PAUSED");
    expect(Object.keys(hide!.payload as object)).toEqual(["deleted_at"]);
    expect(db.has(mark!, "eq", "organization_id", "org-51")).toBe(true);
    expect(h.logged).toEqual([
      {
        action: "template_deleted",
        details: { template_id: "tpl-1", template_name: "diwali_offer", language: "en" },
      },
    ]);
  });

  it("Meta refuses: its reason is shown and nothing is marked", async () => {
    const db = world();
    h.metaOk = false;
    const res = await del();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Template not found");
    expect(updates(db)).toEqual([]);
    expect(h.logged).toEqual([]);
  });

  it("needs templates.manage, the permission that creates templates", async () => {
    world();
    h.denied = ["templates.manage"];
    const res = await del();
    h.denied = [];
    expect(res.status).toBe(403);
    expect(h.meta).toEqual([]);
  });

  it("another workspace's template, or one Meta hasn't given an id: no call", async () => {
    world({ template: null });
    expect((await del()).status).toBe(404);
    world({ template: { ...TEMPLATE, meta_template_id: null } });
    expect((await del()).status).toBe(400);
    expect(h.meta).toEqual([]);
  });
});

describe("blocked while something still sends it", () => {
  it("a scheduled, sending, paused or awaiting campaign blocks it, naming the campaign", async () => {
    for (const status of CAMPAIGN_STATES_USING_TEMPLATE) {
      const db = world({ campaigns: [{ id: "cmp-1", name: "Diwali blast", status }] });
      const res = await del();
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain("“Diwali blast”");
      expect(body.used_by).toEqual({ campaigns: ["Diwali blast"], flows: [] });
      expect(h.meta).toEqual([]);
      expect(updates(db)).toEqual([]);
      // Matched by name and language, as campaigns store the template.
      const read = db.ops.find((o) => o.table === "campaigns")!;
      expect(db.has(read, "eq", "template_name", "diwali_offer")).toBe(true);
      expect(db.has(read, "eq", "template_language", "en")).toBe(true);
    }
  });

  it("finished, cancelled, failed and draft campaigns don't block it", async () => {
    world({
      campaigns: ["completed", "cancelled", "failed", "draft"].map((status, i) => ({
        id: `c${i}`,
        name: `Old ${i}`,
        status,
      })),
    });
    expect((await del()).status).toBe(200);
    expect(h.meta).toHaveLength(1);
  });

  it("an active Flows v2 flow with a template step on its published version blocks it", async () => {
    world({
      versions: [{ flow_id: "f1", graph: templateNode("tpl-1") }],
      flows: [{ id: "f1", name: "Order follow-up", is_enabled: true, config: {} }],
    });
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).used_by).toEqual({ campaigns: [], flows: ["Order follow-up"] });
    expect(h.meta).toEqual([]);
  });

  it("a switched-off or deleted flow doesn't block it", async () => {
    world({
      versions: [
        { flow_id: "f1", graph: templateNode("tpl-1") },
        { flow_id: "f2", graph: templateNode("tpl-1") },
      ],
      flows: [
        { id: "f1", name: "Off", is_enabled: false, config: {} },
        {
          id: "f2",
          name: "Deleted",
          is_enabled: true,
          config: { deleted_at: "2026-10-01T00:00:00Z" },
        },
      ],
    });
    expect((await del()).status).toBe(200);
  });

  it("an enabled legacy flow step blocks it too", async () => {
    world({ steps: [{ flows: { name: "Abandoned cart", is_enabled: true, config: {} } }] });
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("the active flow “Abandoned cart”");
  });

  it("a read that fails refuses: never delete on a guess", async () => {
    const db = world({ failRead: "flow_versions" });
    expect((await del()).status).toBe(500);
    expect(h.meta).toEqual([]);
    expect(updates(db)).toEqual([]);
  });

  it("graphSendsTemplate reads only template steps with that id", () => {
    expect(graphSendsTemplate(templateNode("tpl-1"), "tpl-1")).toBe(true);
    expect(graphSendsTemplate(templateNode("tpl-2"), "tpl-1")).toBe(false);
    expect(
      graphSendsTemplate(
        { nodes: [{ type: "send_text", data: { template_id: "tpl-1" } }] },
        "tpl-1",
      ),
    ).toBe(false);
    expect(graphSendsTemplate(null, "tpl-1")).toBe(false);
  });
});

describe("the gallery", () => {
  it("hides a template deleted here while it carries the DELETED mark; a recreated one shows", () => {
    expect(isDeletedTemplate({ status: "PAUSED", deleted_at: "2026-10-29T10:00:00Z" })).toBe(true);
    expect(isDeletedTemplate({ status: "APPROVED", deleted_at: "2026-10-29T10:00:00Z" })).toBe(
      false,
    );
    expect(isDeletedTemplate({ status: "PENDING", deleted_at: "2026-10-29T10:00:00Z" })).toBe(
      false,
    );
    // Before 20261250 is applied there is no deleted_at: nothing is hidden.
    expect(isDeletedTemplate({ status: "PAUSED" })).toBe(false);
  });

  it("the menu and dialog are the new gallery's only; the classic page has no delete", () => {
    const gallery = readFileSync("src/components/templates-v2/new-templates.tsx", "utf8");
    // Batch 57: copy (the words live in templates-v2/copy.ts; "Message designs" is the visible name)
    const copy = readFileSync("src/components/templates-v2/copy.ts", "utf8");
    expect(gallery).toContain("{tc.deleteAction}");
    expect(copy).toContain('deleteAction: "Delete message design"');
    expect(gallery).toContain("{...(canManage ? { onDelete: () => setDeleting(t) } : {})}");
    const dialog = readFileSync("src/components/templates-v2/delete-template.tsx", "utf8");
    expect(dialog).toContain("{deleteCopy.title(template?.name)}");
    expect(copy).toContain('title: (name: string | undefined) => `Delete “${name ?? ""}”?`');
    expect(dialog).toContain("deleteTemplateRequest(organizationId, template.id)");
    const classic = readFileSync("src/components/templates/templates-view.tsx", "utf8");
    expect(classic).not.toMatch(/action:\s*"delete"/);
  });
});
