import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validateGraph } from "./flow-graph";
import {
  BASELINE,
  VALIDATE_OPTS,
  engineTranscript,
  label,
  liveShapes,
  manifestVersionCount,
  readBaseline,
  scriptsFor,
  simTranscript,
  writeBaseline,
  type Input,
} from "./test-support/live-flows";

/**
 * Batch 10C — live flows replay. No existing flow may change behaviour.
 *
 * Every published flow graph on the live database (137 versions, 17 shapes:
 * the chat flows — Zoori "zoori welcome flow", Ai Dwar "Welcome menu",
 * "Appointment request", "Demo: menu" — and every store/legacy flow) is run
 * through validateGraph, the editor simulator and the flow engine, and must
 * give exactly what main gave before this batch (live-flows/baseline.json,
 * recorded with REPLAY_WRITE=1 on main @ 22c1af6).
 *
 * ALLOWED lists the only differences, each caused by a Batch 10C item and
 * justified; anything else fails.
 */

vi.mock("@/lib/feature-flags.server", () => ({ enabledFlags: async () => new Set(["flows_v2"]) }));

const ALLOWED: Array<{ shape: string; part: "validate" | "sim" | "engine"; script: string; why: string }> = [
  // Item 6 (date answers validated) — Ai Dwar "Appointment request" ("Which
  // date suits you? (dd-mm-yyyy)", validation "date"). On main these answers
  // were saved as dates nobody meant: "1" → 2001-01-01, "2" → 2001-02-01,
  // "9" → 2001-09-01, "12" → 2001-12-01, "110001" → "+110001-01",
  // "31-02-2026" → 2026-03-03, "5 Nov" → 2001-11-05. Now the step asks again
  // (its normal retry), as it already did for "tomorrow" or "12/13/2026".
  // Real dates ("25-12-2026", "2026-12-25") give exactly what they gave.
  ...["\"1\"", "\"2\"", "\"9\"", "\"12\"", "\"110001\"", "\"31-02-2026\"", "\"5 Nov\""].flatMap((script) =>
    (["sim", "engine"] as const).map((part) => ({
      shape: "2beb029bc421ff9027c8b9551ac3ae0c",
      part,
      script,
      why: "date answer that isn't a real dd-mm-yyyy / yyyy-mm-dd date is asked again instead of saved",
    })),
  ),
];

/**
 * Batch 28 item 1 (hand-off alerts awaited): an Assign step that hands the
 * chat to the team now finishes its staff alert before the run moves on, so
 * the alert's own record — handoff_alert_at, then handoff_alert_result —
 * appears right after the flow's needs_human write. On main the alert was
 * fired and forgotten and never wrote anything (handoff_alert_at was NULL on
 * every live row). Sends, run state, events and every other write are
 * unchanged: only those two writes, in that place, are allowed.
 */
const ALERT_RECORDED: Array<{ shape: string; why: string }> = [
  { shape: "2beb029bc421ff9027c8b9551ac3ae0c", why: "Ai Dwar \"Appointment request\" ends with Assign → team: its staff alert is now recorded" },
  { shape: "53abdf009779d2e5122143632ad7bf32", why: "\"zoori welcome flow\": a menu option ending in Assign → team: its staff alert is now recorded" },
  { shape: "c2749820fd04d10ec09e783c16214eb0", why: "\"Welcome menu\": a menu option ending in Assign → team: its staff alert is now recorded" },
  { shape: "f6cb73e97e5799e787f00cb5c445317a", why: "\"Demo: menu\": a menu option ending in Assign → team: its staff alert is now recorded" },
];
const ASSIGN_WRITE = 'conversation:{"needs_human":true,"needs_human_reason":"flow_assign","needs_human_at":"<time>"}';

/** The transcript without the alert's two writes after each flow_assign hand-off (null when there were none). */
function withoutAlertRecord(t: unknown): unknown | null {
  const writes = (t as { writes?: string[] } | null)?.writes;
  if (!Array.isArray(writes)) return null;
  const kept: string[] = [];
  let stripped = false;
  for (let i = 0; i < writes.length; i++) {
    kept.push(writes[i]!);
    if (
      writes[i] === ASSIGN_WRITE &&
      writes[i + 1]?.startsWith('conversation:{"handoff_alert_at":') &&
      writes[i + 2]?.startsWith('conversation:{"handoff_alert_result":')
    ) {
      i += 2;
      stripped = true;
    }
  }
  return stripped ? { ...(t as object), writes: kept } : null;
}

const NOW = new Date("2026-10-05T05:30:00Z"); // Monday 11:00 in Asia/Kolkata

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.spyOn(Math, "random").mockReturnValue(0.25);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * The conversations are the baseline's own (recorded with it on main), so the
 * code under test never picks what it is tested with.
 */
async function replay(base: Record<string, unknown> | null) {
  const engine = await import("./flow-engine.server");
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const s of liveShapes()) {
    const validate: Record<string, unknown> = {};
    for (const [k, opts] of Object.entries(VALIDATE_OPTS)) validate[k] = validateGraph(s.graph, { ...opts, now: NOW });
    const sim: Record<string, unknown> = {};
    const eng: Record<string, unknown> = {};
    const scripts = ((base?.[s.shape] as { scripts?: Input[][] } | undefined)?.scripts ?? scriptsFor(s.graph));
    for (const script of scripts) {
      const key = label(script);
      sim[key] = simTranscript(s.graph, script);
      eng[key] = await engineTranscript(engine, s.graph, script, `org-replay-${++n}`);
    }
    out[s.shape] = { flow: s.flow, key: s.key, versions: s.versions, enabled: s.enabledVersions, scripts, validate, sim, engine: eng };
  }
  return out;
}

describe("live flows replay", () => {
  it("fixtures are the live graphs, byte for byte", () => {
    const shapes = liveShapes();
    expect(shapes).toHaveLength(17);
    expect(shapes.every((s) => s.md5Ok)).toBe(true);
    expect(manifestVersionCount()).toBe(137);
    const names = shapes.map((s) => s.flow);
    for (const f of ["zoori welcome flow", "Welcome menu", "Appointment request"]) expect(names).toContain(f);
  });

  it("validateGraph, simulator and engine give what main gave", { timeout: 120_000 }, async () => {
    if (process.env["REPLAY_WRITE"]) {
      const fresh = await replay(null);
      writeBaseline({ _about: `Recorded by batch10c-replay.test.ts (REPLAY_WRITE=1). File: ${BASELINE.split("/src/")[1]}`, ...fresh });
      return;
    }
    const base = readBaseline();
    expect(base, "baseline.json is missing — record it on main with REPLAY_WRITE=1").not.toBeNull();
    const now = await replay(base);
    const diffs: string[] = [];
    const used = new Set<string>();
    for (const [shape, cur] of Object.entries(now) as Array<[string, Record<string, Record<string, unknown>>]>) {
      const was = (base![shape] ?? {}) as Record<string, Record<string, unknown>>;
      if (JSON.stringify(cur["validate"]) !== JSON.stringify(was["validate"])) diffs.push(`${shape} validate`);
      for (const part of ["sim", "engine"] as const) {
        const keys = new Set([...Object.keys(cur[part] ?? {}), ...Object.keys(was[part] ?? {})]);
        for (const k of keys) {
          if (part === "engine" && ALERT_RECORDED.some((a) => a.shape === shape)) {
            const plain = withoutAlertRecord(cur[part]![k]);
            if (plain) {
              used.add(`${shape} alert`);
              cur[part]![k] = plain;
            }
          }
          if (JSON.stringify(cur[part]![k]) === JSON.stringify(was[part]?.[k])) continue;
          if (ALLOWED.some((a) => a.shape === shape && a.part === part && a.script === k)) {
            used.add(`${shape} ${part} ${k}`);
            // An allowed date difference is always the step asking again.
            expect((cur[part]![k] as { node?: string; run?: { node?: string; status?: string } }).node ?? (cur[part]![k] as { run: { node: string } }).run.node).toBe("date");
            continue;
          }
          diffs.push(`${shape} ${part} [${k}]\n  was: ${JSON.stringify(was[part]?.[k])}\n  now: ${JSON.stringify(cur[part]![k])}`);
        }
      }
    }
    expect(diffs.join("\n\n")).toBe("");
    // Every allowed difference really happened (the list never goes stale).
    expect([...used].sort()).toEqual(
      [...ALLOWED.map((a) => `${a.shape} ${a.part} ${a.script}`), ...ALERT_RECORDED.map((a) => `${a.shape} alert`)].sort(),
    );
  });
});
