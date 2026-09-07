// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { Plugin } from "vite";
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateFeatureRegistry } from "./src/lib/feature-registry.check";

/**
 * Writes src/build-info.ts with the current git short SHA and an ISO build
 * timestamp as literal constants, so build identity ships inside the bundle.
 */
function buildInfoGenerator(): Plugin {
  return {
    name: "aidwar-build-info",
    enforce: "pre",
    buildStart() {
      let commit =
        process.env["COMMIT_SHA"] ??
        process.env["VERCEL_GIT_COMMIT_SHA"] ??
        process.env["CF_PAGES_COMMIT_SHA"] ??
        process.env["GIT_COMMIT"] ??
        "";
      if (!commit) {
        try {
          commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
        } catch {
          commit = "";
        }
      }
      const target = resolve(import.meta.dirname, "src/build-info.ts");
      let existing = "";
      try {
        existing = readFileSync(target, "utf8");
      } catch {
        existing = "";
      }

      // The deploy builder has no git checkout, so a SHA resolved here is
      // authoritative and a missing one must never clobber the committed value.
      if (!commit) {
        const previous = /COMMIT_SHA = "([^"]+)"/.exec(existing)?.[1];
        commit = previous && previous !== "dev" ? previous : "unknown";
      }
      commit = commit.slice(0, 12);

      const contents = `// AUTO-GENERATED at build time by the build-info Vite plugin. Do not edit.
export const COMMIT_SHA = ${JSON.stringify(commit)};
export const BUILT_AT = ${JSON.stringify(new Date().toISOString())} as string | null;
`;
      if (existing === contents) return;
      writeFileSync(target, contents);
    },
  };
}


/**
 * Fails the build when a feature manifest is incomplete — a feature with no
 * flag, a permission with no role default, a nav entry with no permission
 * gate, or an activity action emitted but never declared.
 */
function featureRegistryGuard(): Plugin {
  return {
    name: "aidwar-feature-registry-guard",
    apply: "build",
    buildStart() {
      const issues = validateFeatureRegistry();
      if (issues.length > 0) {
        this.error(
          `Feature registry is out of sync:\n${issues.map((i) => ` - ${i}`).join("\n")}`,
        );
      }
    },
  };
}

/**
 * Applies the feature manifests to the database on every build: merge-only
 * upserts, never a blanking write. Without database access (local builds,
 * previews) it steps aside quietly; a real failure stops the build.
 */
function featureRegistrySync(): Plugin {
  return {
    name: "aidwar-feature-registry-sync",
    apply: "build",
    async buildStart() {
      const url = process.env["AIDWAR_MUMBAI_DB_URL"];
      if (!url) return;

      const { spawnSync } = await import("node:child_process");
      const generated = spawnSync("bun", ["run", "scripts/sync-feature-registry.ts"], {
        encoding: "utf8",
        env: process.env,
      });
      if (generated.status !== 0) {
        this.error(`Feature registry sync could not be generated:\n${generated.stderr}`);
        return;
      }

      const applied = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"], {
        encoding: "utf8",
        input: generated.stdout,
        env: process.env,
      });
      if (applied.status !== 0) {
        this.error(`Feature registry sync failed to apply:\n${applied.stderr}`);
      }
    },
  };
}

export default defineConfig({
  vite: { plugins: [buildInfoGenerator(), featureRegistryGuard(), featureRegistrySync()] },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
