import { notFound } from "@tanstack/react-router";

/**
 * A docs page's <head> (title, description, canonical), for its route's
 * loader (Batch 38 item 9). The content is imported here on demand: a route's
 * loader and head stay in the app's main bundle (only its component is split
 * off), and the docs' content must not ride along into every app page.
 */
export async function docHeadFor(path: string) {
  const [{ pageByPath }, { docHead }] = await Promise.all([
    import("@/lib/developer-portal"),
    import("./doc-head"),
  ]);
  const page = pageByPath(path);
  if (!page) throw notFound();
  return docHead(page);
}

export type DocHead = Awaited<ReturnType<typeof docHeadFor>>;
