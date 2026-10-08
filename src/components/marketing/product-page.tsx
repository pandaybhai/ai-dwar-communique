import { Link } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { trackMarketing } from "@/lib/marketing-analytics";

import type { ProductPageContent } from "@/lib/marketing-seo";

export function ProductPage({ content, path }: { content: ProductPageContent; path: string }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex-1">
        <section className="border-b border-border bg-gradient-to-b from-primary/10 to-background">
          <div className="mx-auto max-w-4xl px-5 py-16 sm:px-8 sm:py-24">
            <Link to="/" className="text-sm font-medium text-primary">
              AiDwar / Product guide
            </Link>
            <h1 className="mt-6 text-4xl font-extrabold tracking-tight sm:text-5xl">
              {content.heading}
            </h1>
            <p className="mt-6 max-w-3xl text-lg leading-relaxed text-muted-foreground">
              {content.intro}
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link
                to="/signup"
                onClick={() => trackMarketing("signup_link_clicked", { placement: path })}
                className="rounded-full bg-primary px-6 py-3 font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Start free
              </Link>
              <Link
                to="/demo"
                className="rounded-full border border-border px-6 py-3 font-semibold hover:bg-secondary"
              >
                See a demo
              </Link>
            </div>
          </div>
        </section>
        <div className="mx-auto max-w-4xl divide-y divide-border px-5 sm:px-8">
          {content.sections.map(([heading, body]) => (
            <section key={heading} className="py-9 sm:py-12">
              <h2 className="text-2xl font-bold tracking-tight">{heading}</h2>
              <p className="mt-4 text-base leading-relaxed text-muted-foreground">{body}</p>
            </section>
          ))}
          <section className="py-12">
            <h2 className="text-2xl font-bold">Choose the right fit for your business</h2>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              Review the current plans and usage allowances, or see an example before you start.
            </p>
            <nav
              aria-label="Related product pages"
              className="mt-6 flex flex-wrap gap-x-6 gap-y-3 text-primary underline underline-offset-4"
            >
              <Link to="/pricing">Compare plans</Link>
              <Link to="/demo">Product demonstration</Link>
              {[
                ["/whatsapp-ai-employee", "AI employee"],
                ["/whatsapp-marketing", "WhatsApp marketing"],
                ["/whatsapp-ai-chatbot-for-shopify", "Shopify"],
                ["/faq", "FAQs"],
              ]
                .filter(([href]) => href !== path)
                .map(([href, label]) => (
                  <a key={href} href={href}>
                    {label}
                  </a>
                ))}
            </nav>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
