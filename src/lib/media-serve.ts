/**
 * Headers for a customer's WhatsApp file served from our origin. Only types a
 * browser shows without running anything are inline; anything else (HTML,
 * SVG, XML, unknown) is a download, sandboxed, and never content-sniffed —
 * a customer can't send a page that runs as us.
 */
const INLINE = /^(image\/(jpeg|png|webp|gif)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf)$/;

export function mediaResponseHeaders(mime: string): Record<string, string> {
  const base = (mime.split(";")[0] ?? "").trim().toLowerCase();
  const inline = INLINE.test(base);
  return {
    "content-type": inline ? base : "application/octet-stream",
    "x-content-type-options": "nosniff",
    "content-disposition": inline ? "inline" : "attachment",
    ...(inline ? {} : { "content-security-policy": "sandbox" }),
    // Private per user session — never shared caches.
    "cache-control": "private, max-age=300",
  };
}
