import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import { handPickedName, handPickedSummary, saveHandPicked } from "./hand-picked";
import {
  FIELD_LABELS,
  describeCondition,
  handPickedFilters,
  isHandPicked,
  usableConditions,
} from "./segments";
import { segmentExpressions } from "./segments.server";
import { audienceSummary, resolveAudienceContacts } from "./campaigns.server";

/**
 * Batch 51, gap 3 — "Send campaign" from the Customers bulk bar. The ticked
 * customers are saved through the existing segment model (one "picked by
 * hand" rule + segment_members), opted-out ones left out, and the existing
 * campaign wizard opens with that segment: its audience (opted in only),
 * estimate, wallet and launch are unchanged. No new send path.
 */

const ORG = "org-51";
const SEG = "5e600000-0000-4000-8000-000000000051";
const NOW = new Date("2026-10-29T08:35:31Z");

function contactsWorld(
  statuses: Record<string, string>,
  opts: { membersTable?: boolean; failMembersInsert?: boolean } = {},
) {
  return fakeDb((op: FakeOp) => {
    if (op.table === "contacts" && op.kind === "select") {
      const ids = (op.filters.find(([m]) => m === "in")?.[1]?.[1] as string[]) ?? [];
      return {
        data: ids.filter((id) => id in statuses).map((id) => ({ id, opt_in_status: statuses[id] })),
        error: null,
      };
    }
    if (op.table === "segment_members" && op.kind === "select")
      return opts.membersTable === false
        ? { data: null, error: { code: "PGRST205", message: "no table" } }
        : { data: null, error: null, count: 0 };
    if (op.table === "segment_members" && op.kind === "insert" && opts.failMembersInsert)
      return { data: null, error: { code: "23503", message: "fk" } };
    return undefined;
  });
}

const save = (db: ReturnType<typeof contactsWorld>, ids: string[]) =>
  saveHandPicked(db.supabase, {
    organizationId: ORG,
    userId: "u-1",
    contactIds: ids,
    segmentId: SEG,
    now: NOW,
    timezone: "Asia/Kolkata",
  });

describe("saving the ticked customers as a segment", () => {
  it("opted-out customers are left out and the count says so", async () => {
    const db = contactsWorld({ a: "opted_in", b: "unknown", c: "opted_out", d: "opted_out" });
    const res = await save(db, ["a", "b", "c", "d", "a"]);
    expect(res).toEqual({ ok: true, segmentId: SEG, saved: 2, optedOut: 2 });
    expect(handPickedSummary(2, 2)).toBe(
      "2 customers saved for this campaign. 2 opted out and were left out.",
    );
    expect(handPickedSummary(1, 1)).toBe(
      "1 customer saved for this campaign. 1 opted out and was left out.",
    );
    expect(handPickedSummary(5, 0)).toBe("5 customers saved for this campaign.");

    const seg = db.ops.find((o) => o.table === "segments" && o.kind === "insert")!;
    expect(seg.payload).toEqual({
      id: SEG,
      organization_id: ORG,
      name: handPickedName(2, NOW, "Asia/Kolkata"),
      description: "Picked by hand in Customers.",
      filters: { match: "all", conditions: [{ field: "list", operator: "in", value: SEG }] },
      created_by: "u-1",
    });
    expect(handPickedName(2, NOW, "Asia/Kolkata")).toBe(
      "Picked by hand, 2 customers, 29 Oct, 14:05:31",
    );
    const members = db.ops.find((o) => o.table === "segment_members" && o.kind === "insert")!;
    expect((members.payload as Array<{ contact_id: string }>).map((m) => m.contact_id)).toEqual([
      "a",
      "b",
    ]);
    expect(members.payload).toContainEqual({
      segment_id: SEG,
      contact_id: "a",
      organization_id: ORG,
      added_by: "u-1",
    });
  });

  it("everyone ticked opted out: nothing is saved", async () => {
    const db = contactsWorld({ c: "opted_out" });
    const res = await save(db, ["c"]);
    expect(res).toEqual({
      ok: false,
      error: "Everyone you ticked has opted out, so there is no one to send a campaign to.",
    });
    expect(db.ops.filter((o) => o.kind === "insert")).toEqual([]);
  });

  it("before 20261250 (no segment_members) it says so and saves nothing", async () => {
    const db = contactsWorld({ a: "opted_in" }, { membersTable: false });
    const res = await save(db, ["a"]);
    expect(res).toEqual({
      ok: false,
      error: "Sending to hand-picked customers isn't switched on for this workspace yet.",
    });
    expect(db.ops.filter((o) => o.kind === "insert")).toEqual([]);
  });

  it("a member write that fails removes the segment again: never a half list", async () => {
    const db = contactsWorld({ a: "opted_in" }, { failMembersInsert: true });
    const res = await save(db, ["a"]);
    expect(res.ok).toBe(false);
    const removed = db.ops.find((o) => o.table === "segments" && o.kind === "delete")!;
    expect(db.has(removed, "eq", "id", SEG)).toBe(true);
  });
});

describe("the wizard reads it like any segment", () => {
  const segmentsDb = (members: { data: unknown; error: unknown }) =>
    fakeDb((op: FakeOp) => {
      if (op.table === "segments")
        return { data: { id: SEG, filters: handPickedFilters(SEG) }, error: null };
      if (op.table === "segment_members") return members as never;
      if (op.table === "contacts") return { data: [], error: null, count: 0 };
      return undefined;
    });

  it("the rule is exactly the saved customers", async () => {
    const db = segmentsDb({ data: [{ contact_id: "a" }, { contact_id: "b" }], error: null });
    expect(await segmentExpressions(db.supabase, ORG, handPickedFilters(SEG))).toEqual({
      match: "all",
      expressions: ["id.in.(a,b)"],
    });
    const read = db.ops.find((o) => o.table === "segment_members")!;
    expect(db.has(read, "eq", "organization_id", ORG)).toBe(true);
    expect(db.has(read, "eq", "segment_id", SEG)).toBe(true);
  });

  it("an empty or unreadable list matches nobody, never everyone", async () => {
    const NEVER = "id.eq.00000000-0000-0000-0000-000000000000";
    for (const members of [
      { data: [], error: null },
      { data: null, error: { code: "PGRST205", message: "no table" } },
    ]) {
      const db = segmentsDb(members);
      expect(
        (await segmentExpressions(db.supabase, ORG, handPickedFilters(SEG))).expressions,
      ).toEqual([NEVER]);
    }
    // A list rule without its id still counts (and matches nobody).
    const db = segmentsDb({ data: [], error: null });
    const blank = {
      match: "all" as const,
      conditions: [{ field: "list" as const, operator: "in", value: "" }],
    };
    expect(usableConditions(blank)).toHaveLength(1);
    expect((await segmentExpressions(db.supabase, ORG, blank)).expressions).toEqual([NEVER]);
  });

  it("the audience estimate and the launch take only opted-in customers from it (unchanged)", async () => {
    const db = segmentsDb({ data: [{ contact_id: "a" }], error: null });
    await audienceSummary(db.supabase, ORG, SEG);
    await resolveAudienceContacts(db.supabase, ORG, SEG);
    const reads = db.ops.filter((o) => o.table === "contacts");
    expect(reads.length).toBeGreaterThan(2);
    for (const r of reads) expect(db.has(r, "or", "id.in.(a)")).toBe(true);
    const launch = reads.at(-1)!;
    expect(db.has(launch, "eq", "opt_in_status", "opted_in")).toBe(true);
  });

  it("Customers → Send campaign only saves the list and opens the existing wizard", () => {
    const view = readFileSync("src/components/customers-v2/new-contacts-view.tsx", "utf8");
    const fn = view.slice(
      view.indexOf("async function sendCampaign"),
      view.indexOf("/** The drawer's own tag write"),
    );
    expect(fn).toContain("saveHandPicked(aidwar, {");
    expect(fn).toContain('navigate({ to: "/app/campaigns", search: { segment: res.segmentId } })');
    for (const banned of ["callApi", "/api/campaigns", "launch"]) expect(fn).not.toContain(banned);
    expect(view).toContain(
      'campaignsFlag.enabled && can("segments.manage") && can("campaigns.create")',
    );

    const route = readFileSync("src/routes/app/campaigns.index.tsx", "utf8");
    expect(route).toContain("initialSegmentId={segment}");
    const wizard = readFileSync("src/components/campaigns/campaign-wizard.tsx", "utf8");
    expect(wizard).toContain('setSegmentId(initialSegmentId ?? "all");');
    // The wizard's audience and launch requests are the ones it always made.
    expect(wizard).toContain('segment_id: segmentId === "all" ? null : segmentId,');
    // The classic Campaigns page never gets the segment.
    expect(route).toMatch(
      /<CampaignsView\s+organizationId=\{active\.organization\.id\}\s+timezone=\{active\.organization\.timezone\}\s+role=\{active\.role\}\s+\/>/,
    );
  });
});

describe("segment screens", () => {
  it("the builder never offers the hand-picked rule; lists describe themselves", () => {
    expect(Object.keys(FIELD_LABELS)).not.toContain("list");
    expect(describeCondition({ field: "list", operator: "in", value: SEG })).toBe("Picked by hand");
    expect(isHandPicked(handPickedFilters(SEG))).toBe(true);
    expect(
      isHandPicked({ match: "all", conditions: [{ field: "tag", operator: "has", value: "t" }] }),
    ).toBe(false);
    const segs = readFileSync("src/components/customers-v2/new-segments-view.tsx", "utf8");
    // Batch 57: copy (the screen's words moved to copy.ts; the card still says it for a list).
    const copy = readFileSync("src/components/customers-v2/copy.ts", "utf8");
    expect(copy).toContain('pickedByHand: "Picked by hand"');
    expect(segs).toContain("isHandPicked(s.filters)\n                    ? t.pickedByHand");
  });
});
