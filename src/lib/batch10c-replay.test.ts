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

const ALLOWED: Array<{ shape: string; part: "validate" | "sim" | "engine"; script: string; why: string }> = [];

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
    for (const [shape, cur] of Object.entries(now) as Array<[string, Record<string, Record<string, unknown>>]>) {
      const was = (base![shape] ?? {}) as Record<string, Record<string, unknown>>;
      if (JSON.stringify(cur["validate"]) !== JSON.stringify(was["validate"])) diffs.push(`${shape} validate`);
      for (const part of ["sim", "engine"] as const) {
        const keys = new Set([...Object.keys(cur[part] ?? {}), ...Object.keys(was[part] ?? {})]);
        for (const k of keys) {
          if (JSON.stringify(cur[part]![k]) === JSON.stringify(was[part]?.[k])) continue;
          if (ALLOWED.some((a) => a.shape === shape && a.part === part && a.script === k)) continue;
          diffs.push(`${shape} ${part} [${k}]\n  was: ${JSON.stringify(was[part]?.[k])}\n  now: ${JSON.stringify(cur[part]![k])}`);
        }
      }
    }
    expect(diffs.join("\n\n")).toBe("");
  });
});
