import { renderToStaticMarkup } from "react-dom/server";
import { allPages, type Page } from "@/lib/developer-portal";
import { DocPage } from "@/components/developers/doc-page";
import { OverviewPage } from "@/components/developers/overview-page";

/**
 * The developer portal's pages as the browser gets them (server-rendered),
 * for the docs tests. The test file mocks @tanstack/react-router's Link as a
 * plain <a>.
 */

/** The page's words; highlighted code is joined back (its tokens are inline spans). */
export const htmlText = (html: string) =>
  html
    .replace(/<\/?span\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

export function renderDocPage(page: Page): string {
  return renderToStaticMarkup(
    page.kind === "overview" ? <OverviewPage rates={[]} /> : <DocPage page={page} />,
  );
}

/** Every page, by path. */
export function renderPortal(): Map<string, string> {
  return new Map(allPages().map((p) => [p.path, renderDocPage(p)]));
}
