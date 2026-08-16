// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { Plugin } from "vite";
import { validateFeatureRegistry } from "./src/lib/feature-registry.check";

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

export default defineConfig({
  vite: { plugins: [featureRegistryGuard()] },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
