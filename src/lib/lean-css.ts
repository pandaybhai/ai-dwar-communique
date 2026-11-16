/**
 * Batch 81: pages that paint from their own inlined CSS (today only /999)
 * load the app stylesheet without blocking first paint: the root preloads it
 * and this attaches it as a stylesheet nobody else manages, so it stays when
 * the router swaps head tags on a client-side navigation.
 */
export const LEAN_CSS_ROUTES: ReadonlySet<string> = new Set(["/999"]);

export const LEAN_CSS_ID = "aidwar-app-css";

/** Inline script for the SSR head: attach the app stylesheet once, unless a blocking link already has it. */
export function leanCssLoader(href: string): string {
  const h = JSON.stringify(href);
  const id = JSON.stringify(LEAN_CSS_ID);
  return `(function(){if(document.getElementById(${id})||document.querySelector('link[rel="stylesheet"][href='+JSON.stringify(${h})+']'))return;var l=document.createElement('link');l.id=${id};l.rel='stylesheet';l.href=${h};document.head.appendChild(l);})();`;
}

/** The same, from a component (a client-side navigation into a lean page). */
export function ensureAppCss(href: string): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(LEAN_CSS_ID)) return;
  const l = document.createElement("link");
  l.id = LEAN_CSS_ID;
  l.rel = "stylesheet";
  l.href = href;
  document.head.appendChild(l);
}
