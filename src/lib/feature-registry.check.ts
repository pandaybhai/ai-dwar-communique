/**
 * Build-time enforcement for the feature registry.
 *
 * Runs from the Vite build (see vite.config.ts) and fails the build when a
 * manifest is incomplete. Without this the registry quietly decays into
 * documentation. Node-only: it reads the source tree, so never import it from
 * client or server runtime code.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FEATURES, ROLE_RANK, allActivityActions, allPermissionKeys, allAiTools } from "./feature-registry";
import { declaredEventTypes, declaredMeterKeys } from "./events";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith("feature-registry.check.ts"))
      out.push(full);
  }
  return out;
}

/** Activity actions actually emitted anywhere in the source tree. */
function emittedActivityActions(srcDir: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/logActivity\(\s*"([a-z0-9_.]+)"/g)) {
      const key = m[1] ?? "";
      if (key && !found.has(key)) found.set(key, file);
    }
    for (const m of text.matchAll(/action:\s*"([a-z0-9_.]+)"\s*(?:,|\n)/g)) {
      const key = m[1] ?? "";
      if (key && /activity_log/.test(text) && !found.has(key)) found.set(key, file);
    }
  }
  return found;
}

/** Event types and meter keys actually emitted anywhere in the source tree. */
function emittedKeys(srcDir: string): { events: Map<string, string>; meters: Map<string, string> } {
  const events = new Map<string, string>();
  const meters = new Map<string, string>();
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/emit(?:Client)?Event\(\s*(?:supabase\s*,\s*)?"([a-z0-9_.]+)"/g)) {
      const key = m[1] ?? "";
      if (key && !events.has(key)) events.set(key, file);
    }
    for (const m of text.matchAll(/eventType:\s*"([a-z0-9_.]+)"/g)) {
      const key = m[1] ?? "";
      if (key && !events.has(key)) events.set(key, file);
    }
    for (const m of text.matchAll(/record(?:Client)?Usage\(\s*(?:supabase\s*,\s*)?"([a-z0-9_]+)"/g)) {
      const key = m[1] ?? "";
      if (key && !meters.has(key)) meters.set(key, file);
    }
  }
  return { events, meters };
}

/** Handler keys implemented in the AI tool broker. */
function implementedHandlers(srcDir: string): Set<string> {
  const out = new Set<string>();
  try {
    const text = readFileSync(join(srcDir, "lib", "ai-tools.server.ts"), "utf8");
    const start = text.indexOf("AI_TOOL_HANDLERS");
    if (start >= 0) {
      for (const m of text.slice(start).matchAll(/^\s{2}async\s+([A-Za-z0-9_]+)\s*\(/gm)) {
        out.add(m[1] ?? "");
      }
    }
  } catch {
    // handled by the caller: an unreadable broker means no handlers exist
  }
  return out;
}

export function validateFeatureRegistry(srcDir = join(process.cwd(), "src")): string[] {
  const issues: string[] = [];
  const seenFeature = new Set<string>();
  const seenPermission = new Set<string>();
  const seenFlag = new Set<string>();
  const seenNav = new Set<string>();

  for (const f of FEATURES) {
    const at = `feature "${f.key}"`;
    if (!/^[a-z][a-z0-9_]*$/.test(f.key)) issues.push(`${at}: key must be snake_case.`);
    if (seenFeature.has(f.key)) issues.push(`${at}: duplicate feature key.`);
    seenFeature.add(f.key);

    if (!f.name.trim() || !f.description.trim()) issues.push(`${at}: needs a name and description.`);
    if (!f.flag_key) issues.push(`${at}: has no feature flag — every feature must be flaggable.`);
    if (f.flag_key && seenFlag.has(f.flag_key)) issues.push(`${at}: duplicate flag key.`);
    seenFlag.add(f.flag_key);

    if (f.permissions.length === 0) issues.push(`${at}: declares no permissions.`);
    for (const p of f.permissions) {
      const pat = `${at} permission "${p.key}"`;
      if (seenPermission.has(p.key)) issues.push(`${pat}: declared by more than one feature.`);
      seenPermission.add(p.key);
      if (!p.name.trim() || !p.description.trim()) issues.push(`${pat}: needs a name and description.`);
      if (!ROLE_RANK[p.min_role]) issues.push(`${pat}: has no valid role default (min_role).`);
    }

    if (f.nav_path) {
      if (seenNav.has(f.nav_path)) issues.push(`${at}: duplicate nav path ${f.nav_path}.`);
      seenNav.add(f.nav_path);
      if (typeof f.nav_order !== "number") issues.push(`${at}: nav entry needs a nav_order.`);
      if (!f.nav_permission) {
        issues.push(`${at}: nav entry ${f.nav_path} has no permission gate.`);
      } else if (!f.permissions.some((p) => p.key === f.nav_permission)) {
        issues.push(
          `${at}: nav gate "${f.nav_permission}" is not a permission this feature declares.`,
        );
      }
    } else if (f.nav_permission) {
      issues.push(`${at}: declares a nav gate but no nav_path.`);
    }

    if (f.analytics.dashboard_section && (!f.analytics.section_id || !f.analytics.section_label)) {
      issues.push(`${at}: declares an analytics section without a section id and label.`);
    }
  }

  const declaredActions = new Set(allActivityActions());
  const declaredPermissions = new Set(allPermissionKeys());

  let emitted: Map<string, string>;
  try {
    emitted = emittedActivityActions(srcDir);
  } catch {
    emitted = new Map();
  }
  for (const [action, file] of emitted) {
    if (!declaredActions.has(action)) {
      issues.push(
        `activity action "${action}" is emitted in ${file.replace(process.cwd() + "/", "")} but no feature declares it.`,
      );
    }
  }

  // Permission keys referenced by UI gates must exist in the registry.
  try {
    for (const file of walk(srcDir)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bcan\(\s*"([a-z0-9_]+\.[a-z0-9_]+)"\s*\)/g)) {
        const key = m[1] ?? "";
        if (key && !declaredPermissions.has(key)) {
          issues.push(
            `permission "${key}" is checked in ${file.replace(process.cwd() + "/", "")} but not declared in any manifest.`,
          );
        }
      }
    }
  } catch {
    // source scan is best-effort; manifest checks above still apply
  }

  // ---- event spine, usage meters and AI tools ----
  const declaredEvents = new Set(declaredEventTypes());
  const declaredMeters = new Set(declaredMeterKeys());
  try {
    const { events, meters } = emittedKeys(srcDir);
    const rel = (f: string) => f.replace(process.cwd() + "/", "");
    for (const [key, file] of events) {
      if (!declaredEvents.has(key)) {
        issues.push(
          `event type "${key}" is emitted in ${rel(file)} but no feature declares it in analytics.event_types.`,
        );
      }
    }
    for (const [key, file] of meters) {
      if (!declaredMeters.has(key)) {
        issues.push(
          `usage meter "${key}" is recorded in ${rel(file)} but no feature declares it in usage_meters.`,
        );
      }
    }
  } catch {
    // source scan is best-effort; manifest checks still apply
  }

  const handlers = implementedHandlers(srcDir);
  const seenTool = new Set<string>();
  for (const tool of allAiTools()) {
    const at = `feature "${tool.feature}" ai_tool "${tool.name}"`;
    if (seenTool.has(tool.name)) issues.push(`${at}: duplicate tool name.`);
    seenTool.add(tool.name);
    if (!tool.description.trim()) issues.push(`${at}: needs a description a model can read.`);
    if (!declaredPermissions.has(tool.required_permission)) {
      issues.push(`${at}: required_permission "${tool.required_permission}" is not declared by any feature.`);
    }
    if (!handlers.has(tool.handler)) {
      issues.push(`${at}: handler "${tool.handler}" is not implemented in src/lib/ai-tools.server.ts.`);
    }
    if (tool.parameters.properties["organization_id"]) {
      issues.push(`${at}: organization_id is bound by the broker and must never be a model parameter.`);
    }
  }

  return issues;
}
