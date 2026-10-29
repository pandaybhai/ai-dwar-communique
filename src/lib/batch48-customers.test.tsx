import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Batch 48 — Customers in the new design (docs/design/preview.html
 * #customers), behind `new_design`. These lock: with the flag off the three
 * routes render today's views and the classic files are byte-identical; every
 * action of the new screens goes through the path the classic screens use;
 * the import moved, unchanged, into src/lib/contact-import.ts; and the new
 * columns (last chat, spent) and filters read existing data only.
 */

const h = vi.hoisted(() => ({ newDesign: false }));
vi.mock("@/lib/new-design", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/new-design")>()),
  useNewDesign: () => h.newDesign,
}));
vi.mock("@/hooks/use-feature-flag", () => ({
  useFeatureFlag: () => ({ enabled: true, loading: false }),
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ can: () => true, reasonFor: () => null, loading: false }),
}));
vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({
    loading: false,
    active: {
      role: "owner",
      organization: { id: "org-1", timezone: "Asia/Kolkata" },
    },
  }),
}));
vi.mock("@/components/contacts/contacts-view", () => ({
  ContactsView: () => <div data-testid="classic-contacts" />,
}));
vi.mock("@/components/segments/segments-view", () => ({
  SegmentsView: () => <div data-testid="classic-segments" />,
}));
vi.mock("@/components/receipts/receipts-view", () => ({
  ReceiptsView: () => <div data-testid="classic-receipts" />,
}));
vi.mock("@/components/customers-v2/new-contacts-view", () => ({
  NewContactsView: ({ initialOptIn }: { initialOptIn?: string }) => (
    <div data-testid="new-contacts" data-opt-in={initialOptIn ?? ""} />
  ),
}));
vi.mock("@/components/customers-v2/new-segments-view", () => ({
  NewSegmentsView: () => <div data-testid="new-segments" />,
}));
vi.mock("@/components/customers-v2/new-receipts-view", () => ({
  NewReceiptsView: () => <div data-testid="new-receipts" />,
}));

import {
  BOUGHT_DAYS,
  NO_FILTERS,
  OPT_IN_CHIP,
  boughtSince,
  clearFilter,
  filterChips,
  flowRunLabel,
  guidedStep,
  hasFilters,
  initialFilters,
  intersectIds,
  lastChatLabel,
  latestChatByContact,
  ratioText,
  selectedLabel,
  spentByContact,
  spentLabel,
  sumReceiptRows,
  tagLinks,
  withTax,
} from "@/components/customers-v2/customers-v2";
import {
  CHUNK,
  MAX_ROWS,
  attrKey,
  phoneColumnOf,
  readImportCsv,
  runContactImport,
} from "@/lib/contact-import";
import { normalizePhone } from "@/lib/phone";
import type { AttributionSourceRow } from "@/lib/analytics";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Page = React.ComponentType & { preload?: () => Promise<void> };
async function routePage(path: string, search: Record<string, unknown> = {}) {
  const mod = (await import(path)) as {
    Route: { options: { component: Page }; useSearch?: () => unknown };
  };
  (mod.Route as unknown as { useSearch: () => unknown }).useSearch = () => search;
  const Page = mod.Route.options.component;
  await Page.preload?.();
  return Page;
}

describe("flag off: today's Customers screens", () => {
  it("Contacts, Segments and Receipts render the classic views off, the new ones on", async () => {
    const Contacts = await routePage("../routes/app/contacts", {});
    h.newDesign = false;
    let html = renderToStaticMarkup(<Contacts />);
    expect(html).toContain("classic-contacts");
    expect(html).not.toContain("new-contacts");
    h.newDesign = true;
    html = renderToStaticMarkup(<Contacts />);
    expect(html).toContain("new-contacts");
    expect(html).not.toContain("classic-contacts");

    const Segments = await routePage("../routes/app/contacts", { tab: "segments" });
    h.newDesign = true;
    expect(renderToStaticMarkup(<Segments />)).toContain("new-segments");
    h.newDesign = false;
    expect(renderToStaticMarkup(<Segments />)).toContain("classic-segments");

    const Receipts = await routePage("../routes/app/receipts");
    h.newDesign = false;
    html = renderToStaticMarkup(<Receipts />);
    expect(html).toContain("classic-receipts");
    expect(html).not.toContain("new-receipts");
    h.newDesign = true;
    html = renderToStaticMarkup(<Receipts />);
    expect(html).toContain("new-receipts");
    expect(html).not.toContain("classic-receipts");
  });

  it("?opt_in=unknown still reaches the list (the flows reachability link)", async () => {
    const Contacts = await routePage("../routes/app/contacts", { opt_in: "unknown" });
    h.newDesign = true;
    expect(renderToStaticMarkup(<Contacts />)).toContain('data-opt-in="unknown"');
    expect(initialFilters("unknown")).toEqual({ ...NO_FILTERS, optIn: "unknown" });
    expect(initialFilters("nonsense")).toEqual(NO_FILTERS);
  });

  it("the classic list, bulk opt-in, segments and receipts files are byte-identical to Batch 46's main", () => {
    const pinned: Record<string, string> = {
      "components/contacts/contacts-view.tsx":
        "80c2428e20f6c4744bab7c6086908f99c546807175280fdc31ee7173a4700a45",
      "components/contacts/bulk-opt-in.tsx":
        "bdfdceb9f6924c62169bd8f596c91b037f174c6352fce3d9bde13ff092a518ab",
      "components/segments/segments-view.tsx":
        "e6dbe1e68d105c09c655823878e596d2cf5fa2b4547ccb3f93437172460123cd",
      "components/segments/segment-builder-dialog.tsx":
        "1fb54d89648f3f2e35754344988c0fea51bdc884bcb4dc9fb6a6e793bb6e2a55",
      "components/receipts/receipts-view.tsx":
        "ba5ce550a6997c7f6c12b744c7a1822dae2079f646abd68845ed24e6cf546a2b",
    };
    for (const [file, hash] of Object.entries(pinned))
      expect([file, sha(src(file))]).toEqual([file, hash]);
  });

  it("the drawer and the add dialog only gained optional, new-design-only props", () => {
    const drawer = src("components/contacts/contact-drawer.tsx");
    expect(drawer).toContain("extra?: ReactNode;");
    expect(drawer).toContain('side?: "bottom";');
    // Unset, the drawer is the classic right-hand sheet with its own conversation link.
    expect(drawer).toContain(': { className: "w-full overflow-y-auto sm:max-w-md" })}');
    expect(drawer).toContain("{extra ? null : (");
    expect(drawer).toContain('<Link to="/app/inbox">');
    const add = src("components/contacts/add-contact-dialog.tsx");
    expect(add).toContain("trigger?: ReactNode;");
    expect(add).toContain("{trigger ?? (");
    // No classic Contacts file knows about the new design.
    for (const f of [
      "components/contacts/contacts-view.tsx",
      "components/contacts/contact-drawer.tsx",
      "components/contacts/add-contact-dialog.tsx",
      "components/contacts/import-contacts-dialog.tsx",
    ]) {
      expect(src(f)).not.toMatch(/new-design|useNewDesign|customers-v2/);
    }
  });
});

describe("the import: the classic logic, moved unchanged and shared", () => {
  const csv =
    'phone,Full name,Tags,City\n+919876543210,Priya Sharma,"vip,repeat",Hyderabad\nbad,Nope,,Pune\n+919876543210,Dup,,Delhi\n+919812345678,,,\n';

  it("guesses the columns as before", () => {
    const parsed = readImportCsv(csv)!;
    expect(parsed.headers).toEqual(["phone", "Full name", "Tags", "City"]);
    expect(parsed.mapping).toEqual({ "0": "phone", "1": "name", "2": "tags", "3": "attr:city" });
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.truncated).toBe(false);
    expect(phoneColumnOf(parsed.mapping)).toBe("0");
    expect(readImportCsv("phone\n")).toBeNull();
    expect(attrKey("  Last Purchase!! ", 4)).toBe("last_purchase");
    expect(attrKey("***", 4)).toBe("column_5");
    expect(MAX_ROWS).toBe(10000);
    expect(CHUNK).toBe(200);
  });

  it("sends start, the chunks and finish with exactly the classic dialog's bodies", async () => {
    const parsed = readImportCsv(csv)!;
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const call = (async (path: string, init: { body: Record<string, unknown> }) => {
      calls.push({ path, body: init.body });
      if (init.body["action"] === "start") return { data: { import_id: "imp-1" }, error: null };
      if (init.body["action"] === "chunk")
        return {
          data: { created: 1, updated: 1, opted_in: 2, stayed_opted_out: 0, errors: [] },
          error: null,
        };
      return { data: {}, error: null };
    }) as unknown as typeof import("@/lib/whatsapp-client").callApi;
    const progress: number[] = [];
    const out = await runContactImport(
      {
        organizationId: "org-1",
        filename: "list.csv",
        rows: parsed.rows,
        mapping: parsed.mapping,
        consent: true,
        startFlows: false,
        onProgress: (p) => progress.push(p),
      },
      call,
    );
    const phone = normalizePhone("+919876543210");
    const errors = [
      { row: 3, phone: "bad", reason: "Invalid phone number" },
      { row: 4, phone, reason: "Duplicate row in file" },
    ];
    expect(calls).toEqual([
      {
        path: "/api/contacts/import",
        body: {
          action: "start",
          organization_id: "org-1",
          filename: "list.csv",
          total_rows: 4,
          consent: true,
        },
      },
      {
        path: "/api/contacts/import",
        body: {
          action: "chunk",
          organization_id: "org-1",
          consent: true,
          start_flows: false,
          import_id: "imp-1",
          rows: [
            {
              row_number: 2,
              phone,
              name: "Priya Sharma",
              tags: ["vip", "repeat"],
              attributes: { city: "Hyderabad" },
            },
            {
              row_number: 5,
              phone: normalizePhone("+919812345678"),
              name: "",
              tags: [],
              attributes: {},
            },
          ],
        },
      },
      {
        path: "/api/contacts/import",
        body: {
          action: "finish",
          organization_id: "org-1",
          import_id: "imp-1",
          created_count: 1,
          updated_count: 1,
          skipped_count: 2,
          opted_in_count: 2,
          stayed_opted_out_count: 0,
          error_report: errors,
          status: "completed",
        },
      },
    ]);
    expect(out).toEqual({
      results: { created: 1, updated: 1, skipped: 2, stayedOptedOut: 0, errors },
    });
    expect(progress).toEqual([100]);
  });

  it("a start that fails sends nothing more", async () => {
    const calls: string[] = [];
    const call = (async (_p: string, init: { body: Record<string, unknown> }) => {
      calls.push(String(init.body["action"]));
      return { data: null, error: "No permission" };
    }) as unknown as typeof import("@/lib/whatsapp-client").callApi;
    const parsed = readImportCsv(csv)!;
    const out = await runContactImport(
      {
        organizationId: "o",
        filename: "f",
        rows: parsed.rows,
        mapping: parsed.mapping,
        consent: false,
        startFlows: false,
        onProgress: () => {},
      },
      call,
    );
    expect(out).toEqual({ startError: "No permission" });
    expect(calls).toEqual(["start"]);
  });

  it("both dialogs run the shared import and keep the consent box (ticked by default)", () => {
    const classic = src("components/contacts/import-contacts-dialog.tsx");
    const guided = src("components/customers-v2/import-guided.tsx");
    for (const file of [classic, guided]) {
      expect(file).toContain("runContactImport(");
      expect(file).toContain("readImportCsv(");
      expect(file).toContain("const [consent, setConsent] = useState(true);");
      expect(file).toContain("IMPORT_CONSENT_LABEL");
      expect(file).not.toContain('"/api/contacts/import"');
    }
    expect(guidedStep(1)).toBe(1);
    expect(guidedStep(2)).toBe(2);
    for (const s of [3, 4, 5]) expect(guidedStep(s)).toBe(3);
  });
});

describe("every action goes through its existing path", () => {
  const view = src("components/customers-v2/new-contacts-view.tsx");
  const classic = src("components/contacts/contacts-view.tsx");
  const bulk = src("components/contacts/bulk-opt-in.tsx");
  const drawer = src("components/contacts/contact-drawer.tsx");

  it("Mark as opted in sends Batch 36's bulk request, word for word", () => {
    const body =
      'body: { action: "bulk", organization_id: organizationId, contact_ids: selectedIds },';
    expect(bulk).toContain(body);
    expect(view).toContain(body);
    expect(view).toContain('callApi<BulkOptInResult>("/api/contacts/opt-in"');
    expect(view).toContain("bulkOptInSummary(res.data)");
    // Mark all unknown is the classic component itself.
    expect(view).toContain("<MarkAllUnknownOptedIn");
  });

  it("Add tag is the drawer's contact_tags upsert, only for customers without the tag", () => {
    expect(drawer).toContain('{ onConflict: "contact_id,tag_id" }');
    expect(view).toContain('.upsert(links, { onConflict: "contact_id,tag_id" })');
    const links = tagLinks("org", "t1", ["a", "b", "c"], { a: ["t1"], b: ["t2"] });
    expect(links).toEqual([
      { contact_id: "b", tag_id: "t1", organization_id: "org" },
      { contact_id: "c", tag_id: "t1", organization_id: "org" },
    ]);
  });

  it("the new screens write nothing the classic screens don't", () => {
    const writes = (s: string) =>
      Array.from(s.matchAll(/\.from\("[a-z_]+"\)\s*\.(insert|update|upsert|delete)\(/g)).map(
        (m) => m[1],
      );
    expect(writes(view)).toEqual(["upsert"]);
    expect(writes(src("components/customers-v2/customer-summary.tsx"))).toEqual([]);
    expect(writes(src("components/customers-v2/new-receipts-view.tsx"))).toEqual([]);
    expect(writes(src("components/customers-v2/import-guided.tsx"))).toEqual([]);
    const segments = src("components/customers-v2/new-segments-view.tsx");
    expect(writes(segments)).toEqual(["delete"]);
    const classicSegments = src("components/segments/segments-view.tsx");
    const del = 'await aidwar.from("segments").delete().eq("id", segment.id);';
    expect(classicSegments).toContain(del);
    expect(segments).toContain(del);
    expect(segments).toContain(
      'void logActivity("segment_deleted", organizationId, { name: segment.name });',
    );
    // The only endpoints called: the classic ones.
    const endpoints = (s: string) => Array.from(s.matchAll(/"(\/api\/[^"]+)"/g)).map((m) => m[1]);
    expect(new Set(endpoints(view))).toEqual(
      new Set(["/api/contacts/evaluate-segment", "/api/contacts/opt-in"]),
    );
    for (const e of endpoints(view)) expect(classic + bulk).toContain(`"${e}"`);
    // The list's query and export are the classic ones.
    expect(view).toContain(
      '"id, name, phone, wa_id, opt_in_status, attributes, source, source_detail, created_at"',
    );
    expect(classic).toContain(
      '.select("id, name, phone, wa_id, opt_in_status, attributes, source, source_detail, created_at"',
    );
    expect(view).toContain('void logActivity("contacts_exported", organizationId, {');
    // Add customer is the classic dialog; the drawer is the classic drawer.
    expect(view).toContain("<AddContactDialog");
    expect(view).toContain("<ContactDrawer");
  });

  it("Sales from chats reads the same attribution functions and adds up the same totals", () => {
    const receipts = src("components/customers-v2/new-receipts-view.tsx");
    for (const fn of [
      "fetchAttributionSources",
      "fetchAttributionSteps",
      "fetchAttributionSummary",
      "fetchCostSettings",
      "buildReceiptsCsv",
    ]) {
      expect(receipts).toContain(`${fn}(`);
    }
    const row = (o: Partial<AttributionSourceRow>): AttributionSourceRow => ({
      source_type: "campaign",
      source_id: "x",
      name: "x",
      created_at: "",
      messages_sent: 10,
      delivered: 9,
      read_count: 7,
      clicked: 1,
      orders: 2,
      revenue: 1000,
      spent: 10,
      cost_complete: true,
      median_hours: null,
      currency: "INR",
      ...o,
    });
    const t = sumReceiptRows([row({}), row({ revenue: 500, spent: 5, cost_complete: false })]);
    expect(t).toMatchObject({
      messages_sent: 20,
      orders: 4,
      revenue: 1500,
      spent: 15,
      cost_complete: false,
    });
    expect(withTax(100, 18)).toBeCloseTo(118);
    expect(ratioText(1500, 15)).toBe("₹100 back per ₹1");
    expect(ratioText(15, 10)).toBe("₹1.5 back per ₹1");
    expect(ratioText(5, 0)).toBeNull();
  });
});

describe("the list's chips, columns and bulk bar", () => {
  it("chips say what is filtered, in the preview's words, and each clears on its own", () => {
    const f = { optIn: "opted_in" as const, tagId: "t2", segmentId: "s1", boughtDays: 90 as const };
    const chips = filterChips(f, { tags: { t2: "bridal" }, segments: { s1: "VIP" } });
    expect(chips.map((c) => c.label)).toEqual([
      "Opted in",
      "Tag: bridal",
      "Bought in last 90 days",
      "Segment: VIP",
    ]);
    expect(clearFilter(f, "tagId")).toEqual({ ...f, tagId: "all" });
    expect(clearFilter(f, "boughtDays")).toEqual({ ...f, boughtDays: null });
    expect(hasFilters(NO_FILTERS, "")).toBe(false);
    expect(hasFilters(NO_FILTERS, "asha")).toBe(true);
    expect(BOUGHT_DAYS).toEqual([30, 90, 180]);
    expect(OPT_IN_CHIP.unknown.label).toBe("Not yet");
  });

  it("bought in the last N days counts back from now", () => {
    const now = Date.UTC(2026, 9, 29, 12);
    expect(boughtSince(90, now)).toBe(new Date(now - 90 * 86_400_000).toISOString());
    expect(intersectIds(null, null)).toBeNull();
    expect(intersectIds(["a", "b", "c"], null, ["c", "a"])).toEqual(["a", "c"]);
    expect(intersectIds(["a"], ["b"])).toEqual([]);
  });

  it("Last chat is the newest of the customer's chats", () => {
    const now = Date.UTC(2026, 9, 29, 12);
    expect(lastChatLabel(null, now)).toBe("No chat yet");
    expect(lastChatLabel(new Date(now - 20_000).toISOString(), now)).toBe("now");
    expect(lastChatLabel(new Date(now - 26 * 60_000).toISOString(), now)).toBe("26 min ago");
    expect(lastChatLabel(new Date(now - 60 * 60_000).toISOString(), now)).toBe("1 hour ago");
    expect(lastChatLabel(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe("3 days ago");
    expect(
      latestChatByContact([
        { contact_id: "a", last_message_at: "2026-10-01T00:00:00Z" },
        { contact_id: "a", last_message_at: "2026-10-05T00:00:00Z" },
        { contact_id: null, last_message_at: "2026-10-09T00:00:00Z" },
        { contact_id: "b", last_message_at: null },
      ]),
    ).toEqual({ a: "2026-10-05T00:00:00Z" });
  });

  it("Spent sums the shop's orders per currency, leaving out cancelled ones", () => {
    const spent = spentByContact([
      { contact_id: "a", total: 30000, currency: "INR" },
      { contact_id: "a", total: "11200", currency: "INR" },
      { contact_id: "a", total: 9999, currency: "INR", cancelled_at: "2026-10-01T00:00:00Z" },
      { contact_id: "a", total: 120, currency: "USD" },
      { contact_id: "b", total: null, currency: "INR" },
      { contact_id: null, total: 5, currency: "INR" },
    ]);
    expect(spent).toEqual({ a: { INR: 41200, USD: 120 } });
    expect(spentLabel(spent["a"]!.INR ? { INR: 41200 } : {})).toBe("₹41,200");
    expect(spentLabel(undefined)).toBe("—");
    expect(spentLabel(spent["a"])).toMatch(/^₹41,200 \+ (US\$|\$)120$/);
  });

  it("the Spent column and bought filter show only when shop orders can be read and exist", () => {
    const view = src("components/customers-v2/new-contacts-view.tsx");
    expect(view).toContain('const canSeeOrders = can("integrations.view");');
    expect(view).toContain("const showSpent = canSeeOrders && hasOrders;");
    expect(view).toContain("{hasOrders ? (");
    expect(selectedLabel(1240)).toBe("1,240 selected");
  });

  it("the bulk bar slides up only without reduced motion and sits above the phone's bottom bar", () => {
    const view = src("components/customers-v2/new-contacts-view.tsx");
    expect(view).toContain("slide-in-from-bottom-4");
    expect(view).toContain("motion-reduce:animate-none");
    expect(view).toContain("phone:bottom-[calc(84px+env(safe-area-inset-bottom))]");
    expect(view).not.toMatch(/transition-all|transition: all/);
  });

  it("flow runs read in plain words", () => {
    expect(flowRunLabel("waiting")).toBe("Waiting for a reply");
    expect(flowRunLabel("done")).toBe("Finished");
    expect(flowRunLabel("ended")).toBe("Ended");
  });
});

describe("Hallmark floor on the new files", () => {
  const files = [
    "components/customers-v2/new-contacts-view.tsx",
    "components/customers-v2/customer-summary.tsx",
    "components/customers-v2/import-guided.tsx",
    "components/customers-v2/new-segments-view.tsx",
    "components/customers-v2/new-receipts-view.tsx",
  ];
  it("no transition-all, no tracked capitals, no middle dots, no raw colours", () => {
    for (const f of files) {
      const s = src(f);
      expect([f, /transition-all/.test(s)]).toEqual([f, false]);
      expect([f, /uppercase|tracking-wide|tracking-wider|tracking-widest/.test(s)]).toEqual([
        f,
        false,
      ]);
      expect([f, s.includes(" · ")]).toEqual([f, false]);
      expect([
        f,
        /#[0-9a-fA-F]{6}\b|\b(?:bg|text|border)-(?:red|green|blue|amber|emerald|gray|slate)-\d/.test(
          s,
        ),
      ]).toEqual([f, false]);
    }
  });
});
