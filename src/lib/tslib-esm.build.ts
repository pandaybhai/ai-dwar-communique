/**
 * Build-time only (vite.config.ts): where `import "tslib"` should point.
 *
 * tslib's "import" entry, modules/index.js, default-imports the CommonJS
 * tslib.js. The server bundle turns that default into undefined (tslib marks
 * itself __esModule), so pdf-lib died on load with "Cannot destructure
 * property '__extends' of '__toESM(...).default'" — every invoice PDF since
 * 22 Sep and the invoice notice's sample PDF. Each tslib also ships a pure
 * ESM file with the same helpers: tslib.es6.mjs (2.x) or tslib.es6.js (1.x).
 *
 * Given the id the normal resolver found, returns that same tslib's ESM file,
 * or null to keep the normal resolution.
 */
export function tslibEsmFile(resolvedId: string, exists: (path: string) => boolean): string | null {
  const id = (resolvedId.split("?")[0] ?? "").replace(/\\/g, "/");
  const at = id.lastIndexOf("/tslib/");
  if (at < 0) return null;
  const dir = id.slice(0, at + "/tslib".length);
  for (const file of ["tslib.es6.mjs", "tslib.es6.js"]) {
    const candidate = `${dir}/${file}`;
    if (exists(candidate)) return candidate;
  }
  return null;
}
