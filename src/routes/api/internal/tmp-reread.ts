import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/internal/tmp-reread")({
  server: { handlers: { POST: async ({ request }) => {
    if (request.headers.get("x-cron-secret") !== process.env["CRON_SECRET"]) return new Response("no", { status: 401 });
    const org = "75aed2f5-4a6c-43be-bff0-bbfee37f3faf";
    const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
    const { readPages, engineOrder } = await import("@/lib/web-reader.server");
    const { loadReadingSettings } = await import("@/lib/reading.server");
    const sb = getServiceClient();
    const r = await loadReadingSettings(sb);
    const xml = await (await fetch("https://aidwar.in/sitemap.xml")).text();
    const urls = Array.from(new Set(["https://aidwar.in/", ...Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1]!)]));
    const pages = await readPages(urls, { order: engineOrder(r.reader_primary, r.reader_fallback_order), tavilyDepth: r.tavily_extract_depth, budget: { supabase: sb, organizationId: org }, tavilyBudget: { supabase: sb, organizationId: org }, allowReader: false });
    return Response.json(urls.map((u) => { const p = pages.get(u); return { url: u, engine: p?.engine ?? null, chars: p?.text.length ?? 0, has2499: Boolean(p?.text.includes("₹2,499")), credits: p?.credits ?? 0 }; }));
  } } },
});
