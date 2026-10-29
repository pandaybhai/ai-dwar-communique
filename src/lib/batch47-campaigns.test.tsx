import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import type { CampaignRow } from "./campaigns";

/**
 * Batch 47 — Campaigns, Templates and Cards in the new design
 * (docs/design/preview.html #campaigns). No live database, WhatsApp or Meta:
 * reads go to a fake query builder, the API to a recorder.
 */

const h = vi.hoisted(() => ({
  newDesign: false,
  calls: [] as Array<{ path: string; body: unknown }>,
  reply: null as ((op: import("./test-support/fake-db").FakeOp) => unknown) | null,
  db: null as ReturnType<typeof import("./test-support/fake-db").fakeDb> | null,
  flags: { revenue_attribution: true } as Record<string, boolean>,
}));

vi.mock("@/lib/new-design", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/new-design")>()),
  useNewDesign: () => h.newDesign,
}));
vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({
    active: {
      organization: { id: "org-1", timezone: "Asia/Kolkata", name: "Kesar" },
      role: "owner",
    },
    can: () => true,
    permissions: [],
    permissionOverrides: {},
    permissionsLoading: false,
    flagsLoading: false,
    isFeatureEnabled: (k: string) => h.flags[k] ?? true,
  }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => () => undefined,
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));
// The dialogs render in place, so their markup can be read without a browser.
vi.mock("@/components/ui/dialog", () => {
  const pass = (tag: string) =>
    function P({ children, className }: { children?: ReactNode; className?: string }) {
      const T = tag as "div";
      return <T className={className}>{children}</T>;
    };
  return {
    Dialog: ({ children }: { children?: ReactNode }) => <>{children}</>,
    DialogTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
    DialogContent: pass("section"),
    DialogHeader: pass("header"),
    DialogFooter: pass("footer"),
    DialogTitle: pass("h2"),
    DialogDescription: pass("p"),
  };
});
vi.mock("@/integrations/aidwar/client", () => ({
  aidwar: {
    from: (t: string) => h.db!.supabase.from(t),
    rpc: (n: string, a: Record<string, unknown>) => h.db!.supabase.rpc(n, a),
  },
}));
vi.mock("@/lib/whatsapp-client", () => ({
  callApi: async (path: string, init: { body?: unknown } = {}) => {
    h.calls.push({ path, body: init.body });
    return { data: null, error: null, raw: null };
  },
}));
// Reduced motion, as some owners have it: tickers show the final number.
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => true,
}));

function useDb(reply: (op: FakeOp) => unknown) {
  h.db = fakeDb((op) => reply(op) as never);
}

beforeEach(() => {
  h.calls = [];
  h.newDesign = false;
  h.flags = { revenue_attribution: true };
  useDb(() => ({ data: [], error: null, count: 0 }));
});

const ORG = "org-1";
const NOW = Date.parse("2026-10-29T10:00:00Z");

function campaign(over: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "c-1",
    organization_id: ORG,
    name: "Dhanteras reminder",
    template_name: "diwali_preview",
    template_language: "en",
    variable_mappings: { "1": { source: "name" } },
    segment_id: null,
    status: "completed",
    scheduled_at: null,
    started_at: "2026-10-23T09:00:00Z",
    completed_at: "2026-10-23T11:00:00Z",
    total_recipients: 3150,
    sent_count: 3150,
    delivered_count: 3097,
    read_count: 2604,
    failed_count: 53,
    replied_count: 118,
    created_by: null,
    created_at: "2026-10-23T08:00:00Z",
    send_settings: {},
    estimated_cost: 2709,
    charged_amount: 2709,
    ...over,
  };
}

const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Markup with the inert new-design (`nd:`) classes taken out, as a flag-off browser draws it. */
const classicMarkup = (html: string) =>
  html.replace(/class="([^"]*)"/g, (_m, c: string) => {
    const kept = c.split(/\s+/).filter((t) => t && !t.startsWith("nd:"));
    return kept.length ? `class="${kept.join(" ")}"` : "";
  });

describe("flag off: today's Campaigns, Templates and Cards, unchanged", () => {
  it("each route draws the Batch 41 page when new_design is off and the new one only when on", async () => {
    const cases: Array<[string, string, string]> = [
      ["@/routes/app/campaigns.index", "CampaignsPage", "NewCampaignsPage"],
      ["@/routes/app/campaigns.$id", "CampaignDetailPage", "NewCampaignDetailPage"],
      ["@/routes/app/templates", "TemplatesPage", "NewTemplatesPage"],
      ["@/routes/app/cards", "CardsPage", "NewCardsPage"],
    ];
    for (const [path, classic, fresh] of cases) {
      const { Route } = (await import(/* @vite-ignore */ path)) as {
        Route: { options: { component: unknown } };
      };
      // The router plugin splits the route's component out: load it, then ask it.
      const lazy = Route.options.component as {
        (props: object): { type: () => { type: { name: string } } };
        preload: () => Promise<void>;
      };
      await lazy.preload();
      const route = lazy({}).type;
      h.newDesign = false;
      expect(route().type.name).toBe(classic);
      h.newDesign = true;
      expect(route().type.name).toBe(fresh);
      h.newDesign = false;
    }
  });

  it("the Batch 41 list, results page, templates, cards and their parts are byte for byte main's", () => {
    const pinned: Record<string, string> = {
      "components/campaigns/campaigns-view.tsx":
        "d28ca52a15749a84cbaae58c6d472cf7d207f0dcaedc57e08e5818590e557889",
      "components/campaigns/campaign-detail.tsx":
        "8c36f1eb6b5448928b67eaa071e5bf8e44a5f9b17679736e3949910f77a67889",
      "components/campaigns/campaign-rates.tsx":
        "4b0f6a7e6b6025d3ff81c27fbf1c1593ec5778de81e2d915f7dd4fcd8da9d088",
      "components/campaigns/campaign-test-send.tsx":
        "2af36ad445bd8d000627055cfa29d03748176e0f2e09ff6593ca1cc554df95ef",
      "components/templates/templates-view.tsx":
        "9def6fe4a2feba7c92e602f5d9d61d0d298af780ffea8ba5e40c68532445ba21",
      "components/templates/template-preview.tsx":
        "963895bfb149639b57875696703bab2c0a59b9e3ffcf94f7a05cc664b0b97c6f",
      "components/templates/format-toolbar.tsx":
        "22637a923b6cb5361d121d9add9db30d310b51680446815c447ee0589c3694f9",
      "components/templates/customer-phone.tsx":
        "3c77ca6e09fd5b96ea23816d89d06dca75a436b5b52cce36c6065240512a8faa",
      "components/cards/cards-view.tsx":
        "b76694a233fc391757338804b3d63372aa7afd462b12d44d396ecead9e2721e2",
      "components/cards/card-preview.tsx":
        "7254400340a5ae5424285d18a5460d43dcf981f7330e4108b539d5f33228d96a",
    };
    for (const [file, hash] of Object.entries(pinned)) expect([file, sha(src(file))]).toEqual([file, hash]);

    // The routes' own Batch 41 page functions, from where they start to the end of the file.
    const routes: Array<[string, string, string]> = [
      [
        "routes/app/campaigns.index.tsx",
        "function CampaignsPage()",
        "9425f299b39f4e5062babd77cf3e99a87e80f0c3ae3972f0a049749cc6b63ff5",
      ],
      [
        "routes/app/campaigns.$id.tsx",
        "function CampaignDetailPage()",
        "db3408936d110726fbadc90786ace2ceda7d3c5ab96c49ccf41183b1ff001cfc",
      ],
      [
        "routes/app/templates.tsx",
        "function TemplatesPage()",
        "54e1ebc391e0363a7c1bd1bc96511c5dfa8ed87c4ea1bf0d45dbed69ebd54e21",
      ],
      [
        "routes/app/cards.tsx",
        "function CardsPage()",
        "9dc95c5810d1e86fe239d853fc01e1bc7ec34f8a57301de671de09030489e6c9",
      ],
    ];
    for (const [file, from, hash] of routes) {
      const text = src(file);
      expect([file, sha(text.slice(text.indexOf(from)))]).toEqual([file, hash]);
    }
  });

  it("the wizard and the template editor draw exactly main's markup with the flag off", async () => {
    const { CampaignWizard } = await import("@/components/campaigns/campaign-wizard");
    const { CreateTemplateDialog } = await import("@/components/templates/create-template-dialog");
    const { CustomerPhone } = await import("@/components/templates/customer-phone");
    const wizard = renderToStaticMarkup(
      <CampaignWizard
        open
        onOpenChange={() => {}}
        organizationId={ORG}
        timezone="Asia/Kolkata"
        onLaunched={() => {}}
      />,
    );
    const editor = renderToStaticMarkup(
      <CreateTemplateDialog organizationId={ORG} whatsappAccountId="acc-1" onCreated={() => {}} />,
    );
    const phone = renderToStaticMarkup(<CustomerPhone business="Kesar">hello</CustomerPhone>);
    // Hashes of main's markup (recorded before Batch 47 touched these files).
    expect(sha(classicMarkup(wizard))).toBe(
      "d52151066cbd4036526f351cbb4a095de620f70ee5c03cc956cf0aae1ffa4451",
    );
    expect(sha(classicMarkup(editor))).toBe(
      "f1c4af539d99f8dea1cc37cfc59498d3b540ac4703f86d471c1a26f59a3e0677",
    );
    expect(sha(classicMarkup(phone))).toBe(
      "b6a2bb08548e64027760518157f71760ddfaaed82c586e1e6dd0e797bc0ff401",
    );
    expect(wizard).toContain("Create campaign");
    expect(editor).toContain("Create a template");
  });
});

describe("Campaigns: the funnel is the campaign's own counters", () => {
  it("funnelSteps gives sent, delivered, read and replied, each a share of the audience (Batch 41's rule)", async () => {
    const { funnelSteps } = await import("@/components/campaigns-v2/data");
    const { percent } = await import("./campaigns");
    const c = campaign();
    expect(funnelSteps(c).map((s) => [s.label, s.value, s.share])).toEqual([
      ["Sent", c.sent_count, percent(c.sent_count, c.total_recipients)],
      ["Delivered", c.delivered_count, percent(c.delivered_count, c.total_recipients)],
      ["Read", c.read_count, percent(c.read_count, c.total_recipients)],
      ["Replied", c.replied_count, percent(c.replied_count, c.total_recipients)],
    ]);
    // The same counters the Batch 41 results page's FUNNEL reads.
    for (const key of ["sent_count", "delivered_count", "read_count", "replied_count"])
      expect(src("components/campaigns/campaign-detail.tsx")).toContain(`key: "${key}"`);
  });

  it("the results draw those numbers, the cost and the phone with the campaign's template", async () => {
    const { CampaignResults } = await import("@/components/campaigns-v2/campaign-results");
    const html = renderToStaticMarkup(
      <CampaignResults
        organizationId={ORG}
        campaignId="c-1"
        timezone="Asia/Kolkata"
        listRow={campaign()}
        onChanged={() => {}}
      />,
    );
    for (const n of ["3,150", "3,097", "2,604", "118"]) expect(html).toContain(n);
    expect(html).toContain("₹2,709");
    expect(html).toContain("53"); // failed
    expect(html).toContain("Dhanteras reminder");
    // Nothing invented: no sales figure until the attribution read says so.
    expect(html).not.toContain("Sales from this campaign");
  });

  it("the list's bars are delivered, read and replied, and nothing before a send", async () => {
    const { miniBars, campaignTag } = await import("@/components/campaigns-v2/data");
    expect(miniBars(campaign())).toEqual({ delivered: 98, read: 83, replied: 4 });
    const draft = campaign({ status: "draft", sent_count: 0, delivered_count: 0, read_count: 0 });
    expect(miniBars(draft)).toBeNull();
    expect(campaignTag(draft)).toBe("Draft");
    expect(campaignTag(campaign())).toBeNull();
  });

  it("the list's second line follows the status and the workspace's own day", async () => {
    const { campaignSubtitle, relativeDay } = await import("@/components/campaigns-v2/data");
    expect(relativeDay("2026-10-29T03:00:00Z", "Asia/Kolkata", NOW)).toBe("today");
    expect(relativeDay("2026-10-28T03:00:00Z", "Asia/Kolkata", NOW)).toBe("yesterday");
    expect(relativeDay("2026-10-26T03:00:00Z", "Asia/Kolkata", NOW)).toBe("3 days ago");
    // 28 Oct 20:00 UTC is already 29 Oct in Kolkata.
    expect(relativeDay("2026-10-28T20:00:00Z", "Asia/Kolkata", NOW)).toBe("today");
    expect(campaignSubtitle(campaign(), "Asia/Kolkata", NOW)).toBe("Sent 6 days ago to 3,150");
    expect(
      campaignSubtitle(campaign({ status: "sending", sent_count: 2630, total_recipients: 4210 }), "Asia/Kolkata", NOW),
    ).toBe("Sending now, 2,630 of 4,210");
    expect(campaignSubtitle(campaign({ status: "draft" }), "Asia/Kolkata", NOW)).toBe("Draft");
  });

  it("reads exactly what the Batch 41 list and results page read, and writes nothing", async () => {
    const { loadCampaignList, loadCampaignResults } = await import("@/components/campaigns-v2/data");
    useDb(() => ({ data: [campaign()], error: null, count: 1 }));
    await loadCampaignList(ORG);
    await loadCampaignResults({
      organizationId: ORG,
      campaignId: "c-1",
      page: 1,
      status: "failed",
      phoneDigits: "9820",
    });
    const ops = h.db!.ops;
    expect(ops.every((o) => o.kind === "select")).toBe(true);
    const list = ops[0]!;
    expect(list.table).toBe("campaigns");
    expect(h.db!.has(list, "eq", "organization_id", ORG)).toBe(true);
    const rec = ops.find((o) => o.table === "campaign_recipients")!;
    expect(rec.select?.[0]).toBe("id, contact_id, phone, resolved_variables, status, error, updated_at");
    expect(src("components/campaigns/campaign-detail.tsx")).toContain(
      `"id, contact_id, phone, resolved_variables, status, error, updated_at"`,
    );
    expect(h.db!.has(rec, "eq", "status", "failed")).toBe(true);
    expect(h.db!.has(rec, "ilike", "phone", "%9820%")).toBe(true);
    expect(h.db!.has(rec, "range", 20, 39)).toBe(true);
    const one = ops.find((o) => o.table === "campaigns" && h.db!.has(o, "eq", "id", "c-1"))!;
    expect(h.db!.has(one, "eq", "organization_id", ORG)).toBe(true);
  });

  it("pause, resume, cancel and approve are the results page's own request", async () => {
    const { controlCampaign } = await import("@/components/campaigns-v2/data");
    await controlCampaign(ORG, "c-1", "pause");
    expect(h.calls).toEqual([
      {
        path: "/api/campaigns/control",
        body: { organization_id: ORG, campaign_id: "c-1", action: "pause" },
      },
    ]);
    expect(src("components/campaigns/campaign-detail.tsx")).toMatch(
      /callApi\("\/api\/campaigns\/control", \{\s*body: \{ organization_id: organizationId, campaign_id: campaignId, action \}/,
    );
  });

  it("sales are the attributed orders' total, and nothing when that total isn't whole", async () => {
    const { loadCampaignSales } = await import("@/components/campaigns-v2/data");
    useDb((op) =>
      op.table === "revenue_attributions"
        ? {
            data: [
              { order_total: 28900, currency: "INR" },
              { order_total: "12300.50", currency: "INR" },
            ],
            error: null,
            count: 2,
          }
        : { data: [], error: null },
    );
    expect(await loadCampaignSales(ORG, "c-1")).toEqual({
      orders: 2,
      revenue: 41200.5,
      currency: "INR",
    });
    const read = h.db!.ops[0]!;
    expect(h.db!.has(read, "eq", "source_type", "campaign")).toBe(true);
    expect(h.db!.has(read, "eq", "source_id", "c-1")).toBe(true);
    expect(h.db!.ops.every((o) => o.kind === "select")).toBe(true);
    // More rows than one read returns: no short total.
    useDb(() => ({ data: [{ order_total: 1, currency: "INR" }], error: null, count: 1500 }));
    expect(await loadCampaignSales(ORG, "c-1")).toBeNull();
    // Two currencies: no mixed total.
    useDb(() => ({
      data: [
        { order_total: 1, currency: "INR" },
        { order_total: 1, currency: "USD" },
      ],
      error: null,
      count: 2,
    }));
    expect(await loadCampaignSales(ORG, "c-1")).toBeNull();
    // None, or a read refused (no analytics.view): nothing shown.
    useDb(() => ({ data: [], error: null, count: 0 }));
    expect(await loadCampaignSales(ORG, "c-1")).toBeNull();
    useDb(() => ({ data: null, error: { message: "permission denied" } }));
    expect(await loadCampaignSales(ORG, "c-1")).toBeNull();
  });

  it("the phone shows the template's stored components with this campaign's file and fills", async () => {
    const { campaignPreviewModel, mappingLabels } = await import("@/components/campaigns-v2/data");
    expect(
      mappingLabels({
        "1": { source: "name" },
        "2": { source: "attribute", key: "city" },
        "3": { source: "static", value: "FEST20" },
      }),
    ).toEqual({ 1: "{{name}}", 2: "{{city}}", 3: "FEST20" });
    const template = {
      id: "t",
      organization_id: ORG,
      waba_id: "w",
      meta_template_id: null,
      name: "diwali_preview",
      language: "en",
      category: "MARKETING",
      status: "APPROVED",
      rejection_reason: null,
      created_at: "",
      updated_at: "",
      components: [
        { type: "HEADER", format: "IMAGE" },
        { type: "BODY", text: "Hi {{1}}, our Diwali collection is here." },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "View collection" }] },
      ],
    } as never;
    const model = campaignPreviewModel(
      campaign({ send_settings: { header_media_url: "https://x/diwali.jpg" } }),
      template,
    );
    expect(model.body).toBe("Hi {{name}}, our Diwali collection is here.");
    expect(model.header?.mediaUrl).toBe("https://x/diwali.jpg");
    expect(model.buttons.map((b) => b["text"])).toEqual(["View collection"]);
  });
});

describe("one path each: launch, submit, and no new writes", () => {
  it("the new Campaigns opens the Batch 41 wizard, whose launch is the one /api/campaigns/launch request", () => {
    const wizard = src("components/campaigns/campaign-wizard.tsx");
    expect(wizard.match(/"\/api\/campaigns\/launch"/g)).toHaveLength(1);
    expect(src("components/campaigns-v2/new-campaigns.tsx")).toMatch(
      /import \{ CampaignWizard \} from "@\/components\/campaigns\/campaign-wizard"/,
    );
  });

  it("with the flag on the wizard is the calm stepper, the PhoneFrame and the cost beside it", async () => {
    h.newDesign = true;
    const { CampaignWizard } = await import("@/components/campaigns/campaign-wizard");
    const html = renderToStaticMarkup(
      <CampaignWizard
        open
        onOpenChange={() => {}}
        organizationId={ORG}
        timezone="Asia/Kolkata"
        onLaunched={() => {}}
      />,
    );
    expect(html).toContain("New campaign");
    for (const label of ["Audience", "Message", "Personalise", "Test send", "Review and cost"])
      expect(html).toContain(label);
    expect(html).toContain('aria-label="The message on the customer&#x27;s WhatsApp"');
    expect(html).toContain("This send costs about");
    expect(html).not.toContain(" · ");
  });

  it("the gallery opens the Batch 41 editor, which submits through its one create request", async () => {
    const editor = src("components/templates/create-template-dialog.tsx");
    expect(editor.match(/action: "create"/g)).toHaveLength(1);
    expect(editor).toMatch(/callApi\("\/api\/whatsapp\/templates"/);
    // A starter picked on the gallery opens it preloaded (the invoice one with a PDF).
    expect(editor).toContain('start.kind === "invoice" ? documentTemplateStarter() : emptyDraft()');
    const gallery = src("components/templates-v2/new-templates.tsx");
    expect(gallery).toContain("<CreateTemplateDialog");
    expect(gallery).not.toMatch(/action: "create"/);

    h.newDesign = true;
    const { CreateTemplateDialog } = await import("@/components/templates/create-template-dialog");
    const html = renderToStaticMarkup(
      <CreateTemplateDialog organizationId={ORG} whatsappAccountId="acc-1" onCreated={() => {}} />,
    );
    expect(html).toContain("New template");
    expect(html).toContain("Body text style"); // the Batch 35 toolbar
    expect(html).toContain("Invoice or receipt with a PDF");
    expect(html).toContain("The message on the customer&#x27;s WhatsApp");
  });

  it("the new screens add no write path: reads, and only the requests the Batch 41 pages make", () => {
    const dirs = ["components/campaigns-v2", "components/templates-v2", "components/cards-v2"];
    const files = dirs.flatMap((d) =>
      readdirSync(join(process.cwd(), "src", d)).map((f) => `${d}/${f}`),
    );
    const code = files.map((f) => src(f)).join("\n");
    expect(code).not.toMatch(/\.(update|insert|upsert|delete)\(/);
    expect(code).not.toMatch(/\.rpc\(/);
    const endpoints = [...code.matchAll(/callApi(?:<[^>]*>)?\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(endpoints)).toEqual(
      new Set(["/api/campaigns/control", "/api/whatsapp/templates", "/api/cards"]),
    );
    // Templates: only the sync; Cards: only the Batch 41 page's four actions.
    expect(src("components/templates-v2/new-templates.tsx")).toMatch(/action: "sync"/);
    const cardActions = [...src("components/cards-v2/new-cards.tsx").matchAll(/action: "(\w+)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(cardActions)).toEqual(
      new Set(["stored_previews", "save_branding", "save_usage", "preview"]),
    );
    for (const a of cardActions) expect(src("components/cards/cards-view.tsx")).toContain(`action: "${a}"`);
  });

  it("the Hallmark floor on the new files: tokens, no tracked capitals, no middle dots, no transition-all", () => {
    const dirs = ["components/campaigns-v2", "components/templates-v2", "components/cards-v2"];
    for (const d of dirs)
      for (const f of readdirSync(join(process.cwd(), "src", d))) {
        const code = src(`${d}/${f}`);
        expect([f, code.includes("·")]).toEqual([f, false]);
        expect([f, /transition-all|transition: all/.test(code)]).toEqual([f, false]);
        expect([f, /\buppercase\b|tracking-wide|tracking-wider/.test(code)]).toEqual([f, false]);
        expect([f, /#[0-9a-fA-F]{6}\b(?!\))/.test(code.replace(/placeholder="#[0-9A-F]{6}"/g, ""))]).toEqual(
          [f, false],
        );
      }
  });
});

describe("Templates: review states", () => {
  it("pending covers both of Meta's review states; paused ones show under All only", async () => {
    const { reviewStateOf, TEMPLATE_STATUS_FILTERS } = await import(
      "@/components/templates-v2/templates-data"
    );
    expect(reviewStateOf({ status: "APPROVED" })).toBe("APPROVED");
    expect(reviewStateOf({ status: "IN_APPEAL" })).toBe("PENDING");
    expect(reviewStateOf({ status: "pending" })).toBe("PENDING");
    expect(reviewStateOf({ status: "REJECTED" })).toBe("REJECTED");
    expect(reviewStateOf({ status: "PAUSED" })).toBe("OTHER");
    expect(TEMPLATE_STATUS_FILTERS.map((f) => f.key)).toEqual([
      "all",
      "APPROVED",
      "PENDING",
      "REJECTED",
    ]);
  });
});
