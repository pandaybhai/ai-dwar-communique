import {
  INSTRUCTIONS,
  PRODUCTS,
  ZOORI_SHOP,
  productsIn,
  zooriWorld,
  type Case,
  type ModelCtx,
  type ReplayShop,
  type Turn,
} from "./zoori-replay";

/**
 * Test-only: the Batch 60 eval. Sixteen fixed customer questions through the
 * real reply path (runAgentOnInbound → executeRun → guards → WhatsApp send)
 * for two shops, with only the model scripted. The same script runs on main
 * and on this branch, so every difference in the table is the pipeline's:
 * the claim gate, the model check, main's rewrite call, the confirm line, the
 * warm line, the prompt and the reasoning field.
 *
 * Measured from the real requests: AI calls per reply, the system prompt's
 * size, the reply text, whether a sentence was taken out, links and amounts.
 * Modelled (no live model may be called): output tokens = the visible words
 * (~4 characters a token) plus hidden thinking when the request carries no
 * reasoning setting — 600 tokens for a reply and 300 for the check, inside
 * the 300–900 seen live on gemini-3.6-flash (Zoori, ai_runs metadata) — and
 * latency = 0.8 s + output tokens ÷ 40 per second for each call, in order
 * (which puts 600 thinking tokens at ~16 s, inside the live 8–30 s).
 */

const THINKING = { reply: 600, check: 300 } as const;
const SECONDS = (outputTokens: number) => 0.8 + outputTokens / 40;
const tokens = (text: string) => Math.ceil(text.length / 4);

// ------------------------------------------------------------------ shops

/**
 * A Zoori-like shop that sells through its website only: no catalogue, no
 * prices anywhere in its material — its instructions point to the site.
 * Zoori's own instructions, with the website line such a shop writes in
 * place of the product-showing rules (it has no catalogue to show from).
 */
const LINK_ONLY_INSTRUCTIONS = {
  ...INSTRUCTIONS,
  instructions:
    INSTRUCTIONS.instructions.replace(/\n\nShowing products:[\s\S]*?(?=\n\nBuying:)/, "") +
    "\n\nOur full collection, with live prices, is on our website https://myzoori.com — share it whenever a customer asks to see designs or prices.",
};

export const LINK_ONLY_SHOP: ReplayShop = {
  ...ZOORI_SHOP,
  products: [],
  instructions: LINK_ONLY_INSTRUCTIONS,
  // Zoori's own pages without a single price (no product listings).
  chunks: ZOORI_SHOP.chunks.filter((k) => !/₹/.test(k.text)),
};

/** Zoori itself: the live catalogue with prices, its real instructions and pages. */
export const CATALOGUE_SHOP: ReplayShop = ZOORI_SHOP;

// ------------------------------------------------------------------ model

type Facts = Record<string, unknown>;
const priceOf = (f: Facts) =>
  typeof f["price"] === "string"
    ? (f["price"] as string)
    : `₹${new Intl.NumberFormat("en-IN").format(Math.round(Number(f["price"])))}`;
const nameOf = (f: Facts) => String(f["name"] ?? f["title"]);
const linkOf = (f: Facts) => String(f["link"] ?? f["product_url"] ?? "");
const done = (text: string): Turn => ({ text: `${text}\n{"needs_owner": false}` });

/**
 * A product reply as the tool schema lets a model write it (Batch 15C): with
 * the early search's products already in hand it sends them and closes in
 * the same call (send_products' `closing`); otherwise it searches first.
 */
function browse(args: Record<string, unknown>, intro: string, closing: string) {
  return (ctx: ModelCtx): Turn => {
    const found = productsIn(ctx.seen).slice(0, 2);
    if (found.length === 0) return { calls: [{ name: "catalog_search", args }] };
    if (ctx.seen.some((s) => s.name === "send_products")) return done(closing);
    if (!ctx.offers("send_products")) {
      return done(
        `${intro}\n${found.map((f) => `• ${nameOf(f)} — ${priceOf(f)} ${linkOf(f)}`).join("\n")}\n${closing}`,
      );
    }
    return {
      text: intro,
      calls: [
        {
          name: "send_products",
          args: {
            products: found.map((f) => ({
              product_id: String(f["product_id"] ?? f["id"]),
              caption: `${nameOf(f)} — ${priceOf(f)}\n${linkOf(f)}`,
            })),
            closing: `${closing}\n{"needs_owner": false}`,
          },
        },
      ],
    };
  };
}

export type Question = {
  key: string;
  ask: string;
  /** What the model writes for the website-only shop. */
  linkOnly: (ctx: ModelCtx) => Turn;
  /** What it writes for the shop with a priced catalogue. */
  catalogue: (ctx: ModelCtx) => Turn;
};

const same = (text: string) => () => done(text);

/**
 * The 16 questions. The model's words follow what each shop told it, and
 * carry the faults seen live: a figure it guessed (gold rate, timings,
 * delivery days, a price), links next to a topic word, the instructions'
 * own promises, and (Zoori's instructions ask for it) "let me confirm".
 */
export const QUESTIONS: Question[] = [
  {
    key: "hi",
    ask: "Hi",
    linkOnly: same("Hi! 😊 Welcome to Zoori. Looking for something special today?"),
    catalogue: same("Hi! 😊 Welcome to Zoori. Looking for something special today?"),
  },
  {
    key: "ring-price",
    ask: "diamond ring price?",
    linkOnly: same(
      "Great choice 💍 You can see every design with its latest price right here: https://myzoori.com",
    ),
    // A guessed price next to the real ones: the number guard must still catch it.
    catalogue: browse(
      { category: "rings", limit: 2 },
      "Here are two of our diamond rings 💍 Most of our diamond rings are around ₹35,000.",
      "Want a different budget?",
    ),
  },
  {
    key: "gold-rate",
    ask: "today's gold rate?",
    linkOnly: same("Today's 22K gold rate is ₹6,850 per gram. Want to see our gold pieces?"),
    catalogue: same("Today's 22K gold rate is ₹6,850 per gram. Want to see our gold pieces?"),
  },
  {
    key: "ring-under-50k",
    ask: "Diamond ring under 50000 dikhao",
    linkOnly: same(
      "Haan ji! 50000 ke andar ke diamond rings yahan dekhiye: https://myzoori.com 💍 Koi khaas design pasand hai?",
    ),
    catalogue: browse(
      { category: "rings", max_price: 50000, limit: 2 },
      "Ye rahe 50000 ke andar diamond rings 💍",
      "Koi khaas design pasand hai?",
    ),
  },
  {
    key: "offer",
    ask: "any discount or offer?",
    linkOnly: same(
      "All current offers are on our website: https://myzoori.com 😊 Website prices are the price to pay — no showroom markup.",
    ),
    catalogue: same(
      "Website prices are the price to pay — no showroom markup 😊\nFor any current offer, let me confirm that for you.",
    ),
  },
  {
    key: "emi",
    ask: "EMI milega?",
    linkOnly: same("EMI ke options aap checkout par dekh sakte hain: https://myzoori.com 😊"),
    catalogue: same("Let me confirm that for you."),
  },
  {
    key: "showroom",
    ask: "showroom kahan hai aur timings?",
    linkOnly: same(
      "We have two showrooms — Somajiguda (GF 1, Olbee Centre, Rajbhavan Road) and Bolarum, Secunderabad (GF06 Fairmount Square). Both are open 10:30 am to 8:30 pm, all days.",
    ),
    catalogue: same(
      "We have two showrooms — Somajiguda (GF 1, Olbee Centre, Rajbhavan Road) and Bolarum, Secunderabad (GF06 Fairmount Square). Timings — let me confirm that for you.",
    ),
  },
  {
    key: "manager-number",
    ask: "store manager number?",
    linkOnly: same("You can call our Somajiguda showroom on +91 98000 00011 😊"),
    catalogue: same("You can call our Somajiguda showroom on +91 98000 00011 😊"),
  },
  {
    key: "ring-size",
    ask: "how do I know my ring size?",
    linkOnly: same(
      "Our size guide makes it easy: myzoori.com/size-guide 😊 You can also choose your size at checkout.",
    ),
    catalogue: same(
      "Our size guide makes it easy: myzoori.com/size-guide 😊 You can also choose your size at checkout.",
    ),
  },
  {
    key: "delivery-bangalore",
    ask: "delivery to Bangalore kitne din mein?",
    linkOnly: same("Bangalore delivery usually takes 5-7 days."),
    catalogue: same("Bangalore delivery usually takes 5-7 days."),
  },
  {
    key: "returns",
    ask: "what is your return policy?",
    linkOnly: same("We offer 20-day no-questions returns, plus lifelong free maintenance 💍"),
    catalogue: same("We offer 20-day no-questions returns, plus lifelong free maintenance 💍"),
  },
  {
    key: "custom-ring",
    ask: "can you make a custom engagement ring?",
    linkOnly: same(
      "Yes! Our team designs custom engagement rings 💍 Share your idea and they'll take it from here.",
    ),
    catalogue: same(
      "Yes! Our team designs custom engagement rings 💍 Share your idea and they'll take it from here.",
    ),
  },
  {
    key: "mangalsutra-price",
    ask: "Mujhe mangalsutra chahiye, kitne ka hai?",
    linkOnly: same(
      "Hamare mangalsutra designs aur unki latest prices yahan dekhiye: https://myzoori.com 😊 Aapka budget kya hai?",
    ),
    catalogue: browse(
      { category: "tanmaniya", limit: 2 },
      "Ye rahe hamare mangalsutra:",
      "Aapka budget kya hai?",
    ),
  },
  {
    key: "stone-fell-refund",
    ask: "my earring stone fell off, I want a refund",
    linkOnly: same(
      "I'm so sorry about that! Please share a photo — our team will sort out a repair or refund for you.",
    ),
    catalogue: same(
      "I'm so sorry about that! Please share a photo — our team will sort out a repair or refund for you.",
    ),
  },
  {
    key: "vs-tanishq",
    ask: "are you better than Tanishq?",
    linkOnly: same(
      "I can't compare with other jewellers, but every Zoori piece has certified stones, real gold and lifelong free maintenance 😊",
    ),
    catalogue: same(
      "I can't compare with other jewellers, but every Zoori piece has certified stones, real gold and lifelong free maintenance 😊",
    ),
  },
  {
    key: "certified-lab",
    ask: "is the diamond certified? which lab?",
    linkOnly: same(
      "Yes, every Zoori diamond is certified 💎 For the lab on a particular piece, our team can share its certificate.",
    ),
    catalogue: same(
      "Yes, every Zoori diamond is certified 💎 For the lab on a particular piece, our team can share its certificate.",
    ),
  },
];

// ------------------------------------------------------------------ run

export type EvalRow = {
  shop: "link-only" | "catalogue";
  key: string;
  ask: string;
  reply: string;
  status: string | null;
  aiCalls: number;
  calls: string[];
  outputTokens: number;
  latencySeconds: number;
  systemPromptTokens: number;
  stripped: boolean;
  cold: boolean;
  /** Links in the reply that are in none of the shop's instructions, pages or products. */
  foreignLinks: string[];
  /** Amounts in the reply that no instruction, page or product states. */
  inventedAmounts: string[];
};

type Body = {
  messages?: Array<{ role: string; content: unknown }>;
  reasoning_effort?: string;
  reasoning?: unknown;
};

/** What the model was given as true for this shop: instructions, pages, products. */
function materialOf(shop: ReplayShop): string {
  return [
    String(shop.instructions["instructions"] ?? ""),
    ...shop.chunks.map((k) => `${k.ref}\n${k.text}`),
    ...shop.products.map((p) => `${String(p["product_url"] ?? "")} ${String(p["price"] ?? "")}`),
  ].join("\n");
}

const linksIn = (text: string) =>
  text.match(/\bhttps?:\/\/[^\s)]+|\b[a-z0-9-]+\.com\/[^\s)]*/gi) ?? [];
const bare = (link: string) =>
  link
    .replace(/^https?:\/\/(www\.)?/i, "")
    .replace(/[.,;:!?]+$/, "")
    .replace(/\/$/, "");

/** The scripted final words, as written (needs_owner line off), for "was anything taken out". */
function scriptedWords(turns: Turn[]): string[] {
  return turns
    .map((t) => (t.text ?? "").replace(/\{"needs_owner":\s*(true|false)\}\s*$/, "").trim())
    .filter(Boolean)
    .flatMap((t) => t.split(/(?<=[.!?])\s+|\n+/))
    .map((s) => s.trim())
    .filter((s) => s && !/^•/.test(s));
}

/**
 * One question for one shop. `runAgentOnInbound` is passed in (the caller
 * imports it after its mocks); `stubFetch` installs the world's fetch.
 */
export async function evalOne(
  shopName: EvalRow["shop"],
  q: Question,
  runAgentOnInbound: (supabase: never, args: never) => Promise<unknown>,
  stubFetch: (fn: (url: string, init?: RequestInit) => Promise<Response>) => void,
): Promise<EvalRow> {
  const shop = shopName === "link-only" ? LINK_ONLY_SHOP : CATALOGUE_SHOP;
  const turns: Turn[] = [];
  const script = shopName === "link-only" ? q.linkOnly : q.catalogue;
  const c: Case = {
    id: `b60-${shopName}-${q.key}`,
    ask: q.ask,
    model: (ctx) => {
      const t = script(ctx);
      turns.push(t);
      return t;
    },
  };
  const world = zooriWorld(c, shop);
  const calls: string[] = [];
  let outputTokens = 0;
  let latency = 0;
  let systemPromptTokens = 0;

  stubFetch(async (url, init) => {
    const u = String(url);
    if (u.endsWith("/embeddings") || u.includes("graph.facebook.com"))
      return world.fetchStub(u, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    const system = String(body.messages?.[0]?.content ?? "");
    const thinkingOff = Boolean(body.reasoning_effort) || Boolean(body.reasoning);
    let res: Response;
    let kind: "reply" | "check" | "rewrite";
    if (system.startsWith("You edit a shop assistant")) {
      // main's rewrite call, answered the way its prompt asks: each claim
      // that answered the question becomes "I don't have that detail right now."
      kind = "rewrite";
      const input = String(body.messages?.at(-1)?.content ?? "");
      const claims = (input.split("UNSUPPORTED CLAIMS:\n")[1] ?? "")
        .split("\n\nREPLY PARTS:")[0]!
        .split("\n")
        .map((l) => l.replace(/^- /, "").trim())
        .filter(Boolean);
      const parts = JSON.parse(
        input.slice(input.indexOf("REPLY PARTS:\n") + "REPLY PARTS:\n".length),
      ) as string[];
      const out = parts.map((p) =>
        claims.reduce((t, claim) => t.split(claim).join("I don't have that detail right now."), p),
      );
      res = new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ parts: out }) } }] }),
      );
    } else {
      kind = system.startsWith("You check whether sentences") ? "check" : "reply";
      if (kind === "reply" && !systemPromptTokens) systemPromptTokens = tokens(system);
      res = await world.fetchStub(u, init);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] } }>;
    };
    const message = json.choices?.[0]?.message;
    const visible = tokens(
      String(message?.content ?? "") + JSON.stringify(message?.tool_calls ?? []),
    );
    const out = visible + (thinkingOff ? 0 : kind === "check" ? THINKING.check : THINKING.reply);
    calls.push(kind);
    outputTokens += out;
    latency += SECONDS(out);
    return new Response(
      JSON.stringify({
        ...json,
        usage: { prompt_tokens: tokens(String(init?.body ?? "")), completion_tokens: out },
      }),
    );
  });
  await runAgentOnInbound(world.supabase as never, world.args as never);
  const r = world.result();

  const reply = r.sent.map((s) => (s.type === "image" ? `🖼 ${s.text}` : s.text)).join(" ‖ ");
  const material = materialOf(shop);
  const flatMaterial = material.replace(/(\d),(?=\d)/g, "$1");
  const foreignLinks = linksIn(reply).filter((l) => !material.includes(bare(l)));
  const inventedAmounts = (
    reply.replace(/\bhttps?:\/\/\S+/g, " ").match(/₹\s?[\d,]+(?:\.\d+)?/g) ?? []
  ).filter((m) => {
    const n = m.replace(/[₹,\s]/g, "");
    if (q.ask.replace(/,/g, "").includes(n)) return false;
    // Prices shown rounded to the rupee (Batch 14) are the product's own.
    return (
      !flatMaterial.includes(n) &&
      !shop.products.some((p) => Math.round(Number(p["price"])) === Number(n))
    );
  });
  const sentText = r.sent.map((s) => s.text).join("\n");
  const stripped = scriptedWords(turns).some((s) => !sentText.includes(s));
  return {
    shop: shopName,
    key: q.key,
    ask: q.ask,
    reply,
    status: r.status,
    aiCalls: calls.length,
    calls,
    outputTokens,
    latencySeconds: Math.round(latency * 10) / 10,
    systemPromptTokens,
    stripped,
    cold: /don.t have that detail|let me confirm/i.test(reply),
    foreignLinks,
    inventedAmounts,
  };
}

/** The markdown table for the PR: main vs this branch, one row per shop and question. */
export function evalTable(main: EvalRow[], branch: EvalRow[]): string {
  const cell = (t: string) => t.replace(/\|/g, "/").replace(/\n/g, " ⏎ ");
  const lines = [
    "| Shop | Customer | main: reply | calls | out tok | s | stripped | branch: reply | calls | out tok | s | stripped |",
    "| --- | --- | --- | --: | --: | --: | :-: | --- | --: | --: | --: | :-: |",
  ];
  for (const b of branch) {
    const m = main.find((x) => x.shop === b.shop && x.key === b.key);
    const side = (r: EvalRow | undefined) =>
      r
        ? `${cell(r.reply)} | ${r.aiCalls} | ${r.outputTokens} | ${r.latencySeconds} | ${r.stripped ? "yes" : "no"}`
        : "— | — | — | — | —";
    lines.push(`| ${b.shop} | ${cell(b.ask)} | ${side(m)} | ${side(b)} |`);
  }
  const sum = (rows: EvalRow[], f: (r: EvalRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  const stat = (rows: EvalRow[]) => ({
    calls: sum(rows, (r) => r.aiCalls),
    maxCalls: Math.max(...rows.map((r) => r.aiCalls)),
    threeCalls: rows.filter((r) => r.aiCalls >= 3).length,
    oneCall: rows.filter((r) => r.aiCalls === 1).length,
    tokens: sum(rows, (r) => r.outputTokens),
    seconds: Math.round(sum(rows, (r) => r.latencySeconds) * 10) / 10,
    cold: rows.filter((r) => r.cold).length,
    stripped: rows.filter((r) => r.stripped).length,
    foreign: sum(rows, (r) => r.foreignLinks.length),
    invented: sum(rows, (r) => r.inventedAmounts.length),
  });
  const sm = stat(main);
  const sb = stat(branch);
  const promptFor = (rows: EvalRow[], shop: string, key: string) =>
    rows.find((r) => r.shop === shop && r.key === key)?.systemPromptTokens ?? 0;
  const prompt = (rows: EvalRow[], shop: string) => promptFor(rows, shop, "hi");
  lines.push(
    "",
    "| Totals (32 replies) | main | branch |",
    "| --- | --: | --: |",
    `| AI calls (sum / max per reply) | ${sm.calls} / ${sm.maxCalls} | ${sb.calls} / ${sb.maxCalls} |`,
    `| Replies with 1 AI call / with 3+ | ${sm.oneCall} / ${sm.threeCalls} | ${sb.oneCall} / ${sb.threeCalls} |`,
    `| Output tokens (modelled) | ${sm.tokens} | ${sb.tokens} |`,
    `| Latency, seconds (modelled) | ${sm.seconds} | ${sb.seconds} |`,
    `| Cold lines ("I don't have that detail" / "Let me confirm") | ${sm.cold} | ${sb.cold} |`,
    `| Replies with a sentence taken out | ${sm.stripped} | ${sb.stripped} |`,
    `| Links not from instructions/material | ${sm.foreign} | ${sb.foreign} |`,
    `| Invented amounts sent | ${sm.invented} | ${sb.invented} |`,
    `| System prompt tokens, link-only shop ("Hi", ~4 chars/token) | ${prompt(main, "link-only")} | ${prompt(branch, "link-only")} |`,
    `| System prompt tokens, catalogue shop ("Hi") | ${prompt(main, "catalogue")} | ${prompt(branch, "catalogue")} |`,
    `| System prompt tokens with website material (catalogue shop, "what is your return policy?") | ${promptFor(main, "catalogue", "returns")} | ${promptFor(branch, "catalogue", "returns")} |`,
    "",
  );
  return lines.join("\n");
}

export const EVAL_PRODUCTS = PRODUCTS;
