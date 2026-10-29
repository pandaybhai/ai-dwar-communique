/**
 * The public pages' server-side reads, faked (Batch 43). /pricing and / load
 * the plan list and the message rates on the server, so the browser's request
 * router can't answer them; this answers them instead, on 127.0.0.1:54399.
 *
 *   node scripts/ui-shots/fake-public.mjs &
 *   AIDWAR_SUPABASE_URL=http://127.0.0.1:54399 AIDWAR_SUPABASE_SERVICE_ROLE_KEY=fake \
 *   VITE_AIDWAR_SUPABASE_URL=http://fake-backend.test VITE_AIDWAR_SUPABASE_ANON_KEY=fake \
 *     npx vite dev --port 5199 --host 127.0.0.1
 *
 * Made-up plans (PLANS in fake-backend.mjs) and example rates; nothing here
 * reaches a live database.
 */
import { createServer } from "node:http";
import { PLANS } from "./fake-backend.mjs";

const RATES = { marketing: 1.04, utility: 0.14, authentication: 0.14, service: 0 };
const PORT = Number(process.env.PORT ?? 54399);

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const send = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/rest/v1/plans") {
    return send(
      PLANS.map((p, i) => ({
        key: p.key,
        name: p.name,
        tagline: p.tagline,
        sort_order: i,
        plan_versions: [
          {
            price_monthly: p.price_monthly,
            price_annual: p.price_annual,
            currency: p.currency,
            limits: p.limits,
            highlights: p.highlights,
            is_current: true,
          },
        ],
      })),
    );
  }
  if (url.pathname === "/rest/v1/rpc/client_rate_for") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const category = JSON.parse(body || "{}").p_category;
      send([{ rate: RATES[category] ?? null, currency: "INR" }]);
    });
    return;
  }
  return send([]);
}).listen(PORT, "127.0.0.1", () => console.log(`fake public reads on :${PORT}`));
