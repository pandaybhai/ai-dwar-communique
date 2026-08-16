/** Build identity, resolved from whatever the host provides at runtime. */
export function buildInfo() {
  const commit =
    process.env["COMMIT_SHA"] ??
    process.env["VERCEL_GIT_COMMIT_SHA"] ??
    process.env["CF_PAGES_COMMIT_SHA"] ??
    process.env["GIT_COMMIT"] ??
    "unknown";
  const built_at = process.env["BUILD_TIME"] ?? null;
  const env = process.env["NODE_ENV"] ?? "development";
  return { commit, built_at, env };
}
