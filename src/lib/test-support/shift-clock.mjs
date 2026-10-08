/**
 * Test-only: moves the wall clock of every process that preloads it, so the
 * whole suite can be run "on another day" to prove no test depends on the
 * real date or time of day. Time keeps ticking from the chosen instant;
 * timers, performance.now() and explicit dates are untouched.
 *
 *   AIDWAR_TEST_NOW=2026-10-31T23:55:00Z TZ=America/Los_Angeles \
 *   NODE_OPTIONS="--import ./src/lib/test-support/shift-clock.mjs" bun run test
 *
 * Vitest's fake timers capture this Date when installed and restore it after,
 * so vi.useFakeTimers / vi.setSystemTime inside a test still win.
 */
const target = process.env["AIDWAR_TEST_NOW"];
if (target) {
  const RealDate = globalThis.Date;
  const at = RealDate.parse(target);
  if (Number.isNaN(at)) throw new Error(`AIDWAR_TEST_NOW is not a date: ${target}`);
  const offset = at - RealDate.now();
  const now = () => RealDate.now() + offset;

  function ShiftedDate(...args) {
    if (!new.target) return new RealDate(now()).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [now()] : args, new.target);
  }
  ShiftedDate.prototype = RealDate.prototype;
  ShiftedDate.now = now;
  ShiftedDate.parse = RealDate.parse;
  ShiftedDate.UTC = RealDate.UTC;
  Object.defineProperty(ShiftedDate, "name", { value: "Date" });
  globalThis.Date = ShiftedDate;
}
