import { COMMIT_SHA, BUILT_AT } from "@/build-info";

/**
 * Build identity. The values come from src/build-info.ts, a file generated at
 * build time and compiled into the bundle — it cannot be missing at runtime
 * the way an unset environment variable can.
 */
export function buildInfo() {
  return {
    commit: COMMIT_SHA,
    built_at: BUILT_AT,
    env: process.env["NODE_ENV"] ?? "development",
  };
}
