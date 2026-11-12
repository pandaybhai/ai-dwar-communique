import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fakeDb } from "./test-support/fake-db";
import {
  DISPATCH_DEFAULTS,
  resetDispatchCaches,
  runCampaignDispatch,
  type DispatchConfig,
} from "./campaign-dispatch.server";
import { meta as fakeMeta, world } from "./test-support/campaign-world";

/**
 * Batch 65 — the Public API's new phone rule (apiPhoneNumber: no number
 * without its country code) applies only to `to` and `cc` in a Public API
 * request. Everything else that sends to a stored number — a scheduled
 * campaign, a template sent from the app — sends exactly what it sent
 * before, to the same digits, even for a stored number the API would now
 * refuse. The expected Meta requests below were recorded on main before
 * Batch 65 (this file was run there first, unchanged). Fakes only.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  graphFetch: vi.fn(async (..._args: unknown[]) => ({
    ok: true,
    status: 200,
    body: { messages: [{ id: "wamid.1" }] },
  })),
}));
vi.mock("@/lib/whatsapp-api.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./whatsapp-api.server")>();
  return {
    ...actual,
    requireOrgMember: async () => ({
      supabase: h.db!.supabase,
      organizationId: "org",
      userId: "u1",
    }),
    requirePermission: async () => null,
    graphFetch: h.graphFetch,
    logServerActivity: async () => {},
  };
});
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  getWhatsAppConnection: async () => ({
    connection: { accountId: "acc", wabaId: "waba", phoneNumberId: "pn", accessToken: "t" },
    error: null,
  }),
}));
vi.mock("@/lib/events.server", () => {
  const noop = async () => {};
  return { emitEvent: noop, recordUsage: noop };
});

import { Route as SendRoute } from "../routes/api/whatsapp/send-message";

/** Stored numbers as they may sit in contacts / campaign_recipients today. */
const STORED = ["+919876543210", "919876543210", "9876543210", "09876543210", "+6591234567"];
/** What Meta got for each, recorded on main before Batch 65. */
const META_TO = ["919876543210", "919876543210", "9876543210", "09876543210", "6591234567"];

/** Meta's request per recipient, without its callback tag, recorded on main before Batch 65. */
const CAMPAIGN_BODIES: unknown[] = [
  {
    messaging_product: "whatsapp",
    to: "09876543210",
    type: "template",
    template: { name: "promo", language: { code: "en" } },
  },
  {
    messaging_product: "whatsapp",
    to: "6591234567",
    type: "template",
    template: { name: "promo", language: { code: "en" } },
  },
  {
    messaging_product: "whatsapp",
    to: "919876543210",
    type: "template",
    template: { name: "promo", language: { code: "en" } },
  },
  {
    messaging_product: "whatsapp",
    to: "919876543210",
    type: "template",
    template: { name: "promo", language: { code: "en" } },
  },
  {
    messaging_product: "whatsapp",
    to: "9876543210",
    type: "template",
    template: { name: "promo", language: { code: "en" } },
  },
];

const cfg = (o: Partial<DispatchConfig> = {}): DispatchConfig => ({
  ...DISPATCH_DEFAULTS,
  lane: 0,
  lanes: 1,
  budgetMs: 3_000,
  flushMs: 5,
  statusPollMs: 40,
  numberMps: 1_000,
  ...o,
});

beforeEach(() => resetDispatchCaches());
afterEach(() => vi.restoreAllMocks());
beforeAll(async () => {
  await Promise.all([
    import("./campaign-billing.server"),
    import("./templates"),
    import("./customer-cards.server"),
  ]);
});

describe("a scheduled campaign to existing contacts: byte-identical", () => {
  it("each stored number goes to the same digits, in the same request, as before", async () => {
    const w = world({
      campaigns: [
        {
          recipients: STORED.length,
          status: "scheduled",
          scheduledAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    const c = w.campaigns[0]!;
    for (const [i, r] of c.recipients.entries()) {
      r["phone"] = STORED[i];
      const contact = w.db.rows("contacts").find((x) => x["id"] === r["contact_id"])!;
      contact["phone"] = STORED[i];
    }
    const g = fakeMeta();
    await runCampaignDispatch(w.db.client, cfg(), { postMessage: g.postMessage });
    expect(g.sends.map((s) => s.to).sort()).toEqual([...META_TO].sort());
    const bodies = g.sends
      .map(({ body }) => {
        const { biz_opaque_callback_data: tag, ...rest } = body;
        expect(String(tag)).toMatch(/^aidwar:c:/);
        return rest;
      })
      .sort((a, b) => String(a["to"]).localeCompare(String(b["to"])));
    expect(bodies).toEqual(CAMPAIGN_BODIES);
    expect(w.db.rows("campaign_recipients").map((r) => r["status"])).toEqual(
      STORED.map(() => "sent"),
    );
  });
});

type Post = (a: { request: Request }) => Promise<Response>;
const post = (r: unknown) =>
  (r as { options: { server: { handlers: { POST: Post } } } }).options.server.handlers.POST;

async function appTemplateSend(phone: string) {
  h.db = fakeDb((op) => {
    if (op.table === "message_templates") return { data: { category: "UTILITY" }, error: null };
    if (op.table === "contacts" && op.kind === "upsert") return { data: { id: "c1" }, error: null };
    if (op.table === "contacts") return { data: { opt_in_status: "opted_in" }, error: null };
    if (op.table === "conversations" && op.kind === "select")
      return {
        data: {
          id: "cv1",
          contact_id: null,
          whatsapp_account_id: "acc",
          last_customer_message_at: new Date().toISOString(),
        },
        error: null,
      };
    if (op.table === "messages") return { data: { id: "m1", status: "pending" }, error: null };
    return undefined;
  });
  return post(SendRoute)({
    request: new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        organization_id: "org",
        phone,
        message_type: "template",
        template_name: "order_update",
        template_language: "en",
      }),
    }),
  });
}

describe("a template sent from the app: byte-identical", () => {
  beforeEach(() => h.graphFetch.mockClear());

  it("each number goes to Meta exactly as before, with the same request", async () => {
    for (const [i, phone] of STORED.entries()) {
      h.graphFetch.mockClear();
      const res = await appTemplateSend(phone);
      expect(res.status, phone).toBe(200);
      expect(h.graphFetch).toHaveBeenCalledTimes(1);
      const [path, , init] = h.graphFetch.mock.calls[0]! as [string, string, { body: unknown }];
      expect(path).toBe("pn/messages");
      expect(init.body).toEqual({
        messaging_product: "whatsapp",
        to: META_TO[i],
        type: "template",
        template: { name: "order_update", language: { code: "en" } },
      });
    }
  });
});

describe("only the audited places call the phone rule", () => {
  // Batch 65 pinned apiPhoneNumber to the two API sends; Batch 66 made it the
  // one rule (enteredPhone) for every place a person or integrator types a
  // number — the list below is the PR's audit — and still never the inbound
  // or status webhooks, campaigns, flows, the inbox or the app's template send.
  it("enteredPhone and its wrappers appear only in the audited files", () => {
    const root = join(import.meta.dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(root);
    // Batch 69 added typedPhone (the form wording) and its callers: the
    // billing WhatsApp (Super Admin, the customer's plan purchase), staff
    // alert numbers, the onboarding and sign-up numbers.
    const rule =
      /\b(enteredPhone|apiPhoneNumber|apiPhoneError|needsDefaultCountry|requestNeedsDefaultCountry|pathPhone|planImportRows|typedPhone|workspaceTypedPhone|alertPhonesNeedCountry|signupPhone)\b/;
    const callers = files
      .filter((f) => rule.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f))
      .sort();
    expect(callers).toEqual([
      "components/contacts/import-contacts-dialog.tsx",
      "components/contacts/import-phone-check.tsx",
      "components/customers-v2/import-guided.tsx",
      "components/settings/api-copies-card.tsx",
      "lib/add-contact-phone.ts",
      "lib/billing-admin.server.ts",
      "lib/contact-import.ts",
      "lib/default-country.ts",
      "lib/handoff-alerts.server.ts",
      // Batch 70: the owner's own phone, normalised before hashing for Meta.
      "lib/meta-events.ts",
      "lib/phone.ts",
      "lib/plan-purchase.server.ts",
      "lib/public-api-account.server.ts",
      "lib/public-api-campaigns.server.ts",
      "lib/public-api-cc.server.ts",
      "lib/public-api-cc.ts",
      "lib/public-api-console.server.ts",
      "lib/public-api-contacts.server.ts",
      "lib/public-api-inbox.server.ts",
      "lib/public-api-send.server.ts",
      "lib/public-api-session.server.ts",
      // Batch 75: the /start number rule (Batch 66's rule + fake numbers) lives
      // here; leads.server.ts and start-page.ts (Batch 72) call checkRealNumber.
      "lib/start-qualify.ts",
      "routes/api/ai/employee.ts",
      "routes/api/contacts/import.ts",
      "routes/api/onboarding/start.ts",
      "routes/signup.tsx",
    ]);
    for (const f of [
      "lib/whatsapp-webhook.server.ts",
      "lib/campaign-dispatch.server.ts",
      "lib/campaigns.server.ts",
      "lib/flow-engine.server.ts",
      "lib/wa-reachability.server.ts",
      "routes/api/whatsapp/send-message.ts",
    ])
      expect(callers, f).not.toContain(f);
  });
});
