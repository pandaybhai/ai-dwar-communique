import { Outlet, createFileRoute } from "@tanstack/react-router";
import docsCss from "@/components/developers/docs.css?url";
import { DocsShell } from "@/components/developers/docs-shell";
import { THEME_SCRIPT } from "@/components/developers/theme-script";

/**
 * The developer portal (Batch 38 item 9): every page under /developers, in
 * one frame — sidebar, search, light and dark. The theme is set before first
 * paint, so a dark-mode reader never sees a flash of light.
 */
export const Route = createFileRoute("/developers")({
  head: () => ({
    links: [{ rel: "stylesheet", href: docsCss }],
    scripts: [{ children: THEME_SCRIPT }],
  }),
  component: () => (
    <DocsShell>
      <Outlet />
    </DocsShell>
  ),
});
