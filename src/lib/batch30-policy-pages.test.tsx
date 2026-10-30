import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Batch 30: the policy pages for the payment-gateway review — Contact,
 * Refunds & Cancellations, Shipping & Delivery, the /terms fees section, the
 * /pricing rate table and the shared footer.
 */

let loaderData: unknown = null;

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      children,
      className,
    }: {
      to: string;
      children: ReactNode;
      className?: string;
    }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
    createFileRoute: () => (options: Record<string, unknown>) => ({
      options,
      useLoaderData: () => loaderData,
    }),
  };
});
vi.mock("@/hooks/use-session", () => ({ useSession: () => ({ session: null, loading: false }) }));
vi.mock("@/lib/public-plans.functions", () => ({ getPublicPlans: vi.fn() }));
vi.mock("@/lib/public-rates.functions", () => ({ getPublicRates: vi.fn() }));

import { COMPANY, telHref, type Company } from "@/lib/company";
import { FOOTER_LINKS, SiteFooter } from "@/components/site-footer";
import { MessageRatesTable } from "@/components/marketing/message-rates";
import { readDefaultRates } from "@/lib/public-rates.server";
import { ContactDetails } from "@/routes/contact";
import type { ClientRate } from "@/lib/billing";

type RouteLike = { options: { component?: ComponentType; beforeLoad?: () => unknown } };

async function renderRoute(path: string): Promise<string> {
  const mod = (await import(`@/routes/${path}.tsx`)) as { Route: RouteLike };
  // The router plugin splits a route's component into a lazy chunk: load it first.
  const Page = mod.Route.options.component as ComponentType & { preload?: () => Promise<void> };
  await Page.preload?.();
  return renderToStaticMarkup(<Page />);
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

const RATES: ClientRate[] = [
  { category: "marketing", rate: 1.04, currency: "INR" },
  { category: "utility", rate: 0.14, currency: "INR" },
  { category: "authentication", rate: 0.14, currency: "INR" },
  { category: "service", rate: 0, currency: "INR" },
];

describe("the shared company details", () => {
  it("has the given legal name, brand, email and city; GSTIN is empty until set", () => {
    expect(COMPANY.legalName).toBe("Meezoy Ventures Private Limited");
    expect(COMPANY.brand).toBe("AiDwar");
    expect(COMPANY.email).toBe("support@aidwar.in");
    expect(COMPANY.city).toBe("Hyderabad, Telangana, India");
    expect(COMPANY.gstin).toBe("");
    expect(telHref(COMPANY)).toBe("tel:+917981223192");
  });
});

describe("new routes render with the legal name and email", () => {
  it.each(["refunds", "shipping", "contact"])("/%s", async (path) => {
    const html = await renderRoute(path);
    expect(html).toContain("Meezoy Ventures Private Limited");
    expect(html).toContain("mailto:support@aidwar.in");
    expect(html).toContain("support@aidwar.in");
    // The one shared footer, not a second one.
    expect(html.match(/<footer/g)).toHaveLength(1);
  });

  it("/contact shows every detail that is set, with mailto and tel links, and omits GSTIN while empty", async () => {
    const page = text(await renderRoute("contact"));
    expect(page).toContain("Contact Us");
    expect(page).toContain(
      "Registered address 3-3-303, Subric Street, Secunderabad, Telangana 500003, India",
    );
    expect(page).toContain("Phone +91 79812 23192");
    expect(page).toContain("Support hours 10:00 AM - 10:00 PM IST, all days");
    expect(page).toContain("We reply within 2 working days.");
    expect(page).not.toContain("GSTIN");
    expect(page).not.toMatch(/TBD|to be (added|confirmed)/i);
    const html = await renderRoute("contact");
    expect(html).toContain('href="tel:+917981223192"');
  });

  it("a page omits an empty address, phone, hours or GSTIN line — and shows GSTIN once set", () => {
    const empty: Company = {
      ...COMPANY,
      registeredAddress: "",
      phone: "",
      phoneTel: "",
      supportHours: "  ",
      gstin: "",
    };
    const html = renderToStaticMarkup(<ContactDetails company={empty} />);
    expect(html).not.toContain("Registered address");
    expect(html).not.toContain("Phone");
    expect(html).not.toContain("tel:");
    expect(html).not.toContain("Support hours");
    expect(html).not.toContain("GSTIN");
    // The city still says where we are; the legal name and email always show.
    expect(text(html)).toContain("City Hyderabad, Telangana, India");
    expect(html).toContain("Meezoy Ventures Private Limited");
    expect(html).toContain("mailto:support@aidwar.in");

    const withGst = renderToStaticMarkup(
      <ContactDetails company={{ ...COMPANY, gstin: "36ABCDE1234F1Z5" }} />,
    );
    expect(text(withGst)).toContain("GSTIN 36ABCDE1234F1Z5");
  });

  it("/refunds carries the agreed rules", async () => {
    const page = text(await renderRoute("refunds"));
    expect(page).toContain("Refunds & Cancellations");
    expect(page).toContain("cancel your plan at any time from Billing");
    expect(page).toContain("stays active until the end of the period you have already paid for");
    expect(page).toContain("Fees for a billing period that has already started are not refunded");
    expect(page).toContain("a yearly plan cancelled within 7 days of payment is refunded in full");
    expect(page).toContain("do not expire while your account is active");
    expect(page).toContain("within 30 days of closing");
    expect(page).toContain("Payment-gateway charges are deducted");
    expect(page).toContain("Credits used for messages already sent are not refundable");
    expect(page).toContain(
      "refund it in full to the original payment method within 5-7 working days",
    );
    expect(page).toContain("with your invoice number");
    expect(page).toContain("acknowledge every request within 2 working days");
    expect(page).toContain("The free trial is not charged, so there is nothing to refund.");
  });

  it("/refund-policy and /cancellation-policy redirect to /refunds", async () => {
    for (const path of ["refund-policy", "cancellation-policy"]) {
      const mod = (await import(`@/routes/${path}.tsx`)) as { Route: RouteLike };
      let thrown: unknown = null;
      try {
        mod.Route.options.beforeLoad!();
      } catch (e) {
        thrown = e;
      }
      expect(thrown, path).toMatchObject({ options: { to: "/refunds", statusCode: 301 } });
    }
  });

  it("/shipping says it is delivered online, at once, with nothing shipped", async () => {
    const page = text(await renderRoute("shipping"));
    expect(page).toContain("Shipping & Delivery");
    expect(page).toContain("activated immediately after a successful payment");
    expect(page).toContain("credits appear in your wallet immediately");
    expect(page).toContain("No physical goods are shipped");
    expect(page).toContain("not active within 24 hours");
  });
});

describe("/terms section 5", () => {
  it("no longer says paid plans will be introduced; states the billing terms and links /refunds", async () => {
    const html = await renderRoute("terms");
    const page = text(html);
    const s5 = page.slice(
      page.indexOf("5. Fees and billing"),
      page.indexOf("6. Third-party services"),
    );
    expect(s5).not.toContain("will be introduced");
    expect(page).not.toContain("will be introduced");
    expect(s5).toContain("INR");
    expect(s5).toContain("18%");
    expect(s5).toContain("monthly or yearly, in advance");
    expect(s5).toContain("Message credits are prepaid");
    expect(s5).toContain("GST invoice for every payment");
    expect(s5).toContain("Auto-pay is optional");
    expect(s5).toContain("pause your plan after giving you notice");
    expect(html).toContain('href="/refunds"');
    expect(html).toContain('href="/pricing"');
    // Every other section is still there.
    for (const h of [
      "1. The Service",
      "2. Account registration",
      "3. Acceptable use",
      "4. Your data",
      "6. Third-party",
      "7. Limitation of liability",
      "8. Termination",
      "9. Changes",
      "10. Governing law",
      "11. Contact",
    ])
      expect(page).toContain(h);
  });
});

describe("the footer", () => {
  const tree = readFileSync(join(__dirname, "..", "routeTree.gen.ts"), "utf8");
  const byFullPath = tree.slice(
    tree.indexOf("export interface FileRoutesByFullPath"),
    tree.indexOf("export interface FileRoutesByTo"),
  );

  it("lists the seven policy and pricing pages in order", () => {
    expect(FOOTER_LINKS.map((l) => l.to)).toEqual([
      "/pricing",
      "/ai-assistants", // Batch 53
      "/contact",
      "/terms",
      "/refunds",
      "/shipping",
      "/privacy",
      "/data-deletion",
    ]);
    const html = renderToStaticMarkup(<SiteFooter />);
    for (const link of FOOTER_LINKS) expect(html).toContain(`href="${link.to}"`);
    expect(text(html)).toContain("Refunds & Cancellations");
    expect(text(html)).toContain("Shipping & Delivery");
  });

  it("every footer link is a real route (no 404), and so are the two redirects", () => {
    for (const to of [...FOOTER_LINKS.map((l) => l.to), "/refund-policy", "/cancellation-policy"]) {
      expect(byFullPath, to).toContain(`'${to}': typeof`);
      expect(existsSync(join(__dirname, "..", "routes", `${to.slice(1)}.tsx`)), to).toBe(true);
    }
  });

  it("is the only footer on the public pages; /demo uses it too", () => {
    for (const page of ["index", "pricing", "demo"]) {
      const src = readFileSync(join(__dirname, "..", "routes", `${page}.tsx`), "utf8");
      expect(src, page).toContain("<SiteFooter />");
      expect(src, page).not.toMatch(/<footer\b/);
    }
  });

  it("the new pages are in the sitemap", () => {
    const sitemap = readFileSync(join(__dirname, "..", "routes", "sitemap[.]xml.ts"), "utf8");
    for (const path of ["/contact", "/refunds", "/shipping"])
      expect(sitemap).toContain(`path: "${path}"`);
  });
});

describe("/pricing message credit rates", () => {
  it("shows the four categories in INR per message", () => {
    const page = text(renderToStaticMarkup(<MessageRatesTable rates={RATES} />));
    expect(page).toContain("Message credit rates (India)");
    expect(page).toContain("Rate per message (INR)");
    expect(page).toContain("Marketing ₹1.04");
    expect(page).toContain("Utility ₹0.14");
    expect(page).toContain("Authentication ₹0.14");
    expect(page).toContain("Service replies inside the 24-hour window ₹0.00");
    expect(page).toContain(
      "Rates follow Meta's prices and may change; your exact rate is shown before every send.",
    );
  });

  it("shows no made-up numbers when the rates didn't load", () => {
    const page = text(renderToStaticMarkup(<MessageRatesTable rates={[]} />));
    expect(page).toContain("couldn't load the rates");
    expect(page).not.toContain("₹");
  });

  it("the pricing page renders the table under 'How message credits work' and links Refunds & Cancellations", async () => {
    loaderData = { plans: [], ok: false, rates: RATES };
    const html = await renderRoute("pricing");
    const page = text(html);
    expect(page.indexOf("How message credits work")).toBeGreaterThan(-1);
    expect(page.indexOf("Message credit rates (India)")).toBeGreaterThan(
      page.indexOf("How message credits work"),
    );
    expect(page).toContain("Marketing ₹1.04");
    expect(html).toContain('href="/refunds"');
  });

  it("reads the platform default card via client_rate_for (no workspace) and keeps only rate and currency", async () => {
    const calls: Record<string, unknown>[] = [];
    const meta: Record<string, number> = {
      marketing: 1.04,
      utility: 0.14,
      authentication: 0.14,
      service: 0,
    };
    const supabase = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, ...args });
        const category = String(args["p_category"]);
        return {
          data: [{ rate: meta[category], currency: "INR", meta_rate: 0.8631, mode: "markup" }],
          error: null,
        };
      },
    };
    const rates = await readDefaultRates(supabase as never);
    expect(
      calls.every(
        (c) => c["name"] === "client_rate_for" && c["p_org"] === null && c["p_country"] === "IN",
      ),
    ).toBe(true);
    expect(rates).toEqual(RATES);
    for (const r of rates) expect(Object.keys(r).sort()).toEqual(["category", "currency", "rate"]);
  });
});
