/**
 * Batch 52: Supabase builds the OAuth consent link from the Site URL, saved
 * as "https://aidwar.in/" — so users arrive at https://aidwar.in//oauth/consent.
 * A path that starts with several slashes is sent (308, query kept) to the
 * same path with one. The Location is always "/x", never "//x", which a
 * browser would read as another host.
 */
export function collapseLeadingSlashes(request: Request): Response | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (!url.pathname.startsWith("//")) return null;
  const path = url.pathname.replace(/^\/{2,}/, "/");
  return new Response(null, {
    status: 308,
    headers: { location: `${path}${url.search}`, "cache-control": "no-store" },
  });
}
