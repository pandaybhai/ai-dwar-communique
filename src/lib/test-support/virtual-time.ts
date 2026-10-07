import { vi } from "vitest";

/**
 * Test-only: runs `work` on a virtual clock (setTimeout/Date faked). The clock
 * moves to the next timer only once every pending promise and cached import
 * has settled, so a latency world's "N round trips" is exact on any machine,
 * however loaded — never a wall-clock race.
 */
export async function inVirtualTime<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  let settled = false;
  const run = work().finally(() => {
    settled = true;
  });
  run.catch(() => {});
  try {
    while (!settled) {
      // Quiesce: let promise chains and (already loaded) dynamic imports finish.
      for (let i = 0; i < 50 && !settled; i += 1) await new Promise<void>((r) => setImmediate(r));
      if (!settled) await vi.advanceTimersToNextTimerAsync();
    }
    return await run;
  } finally {
    vi.useRealTimers();
  }
}
