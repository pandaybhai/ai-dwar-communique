import { Link } from "@tanstack/react-router";
import { COMPANY } from "@/lib/company";

/** Every public page's footer links, in this order. */
export const FOOTER_LINKS = [
  { to: "/pricing", label: "Pricing" },
  { to: "/ai-assistants", label: "AI assistants" },
  { to: "/contact", label: "Contact Us" },
  { to: "/terms", label: "Terms of Service" },
  { to: "/refunds", label: "Refunds & Cancellations" },
  { to: "/shipping", label: "Shipping & Delivery" },
  { to: "/privacy", label: "Privacy Policy" },
  { to: "/data-deletion", label: "Data Deletion" },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-secondary/40">
      <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-lg font-bold tracking-tight">
              Ai<span className="text-primary">Dwar</span>
            </div>
            <p className="mt-2 max-w-sm text-sm text-muted-foreground">
              AI-powered marketing on the official WhatsApp Business Platform.
            </p>
          </div>
          <nav
            aria-label="Footer"
            className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:flex sm:flex-col sm:items-end"
          >
            {FOOTER_LINKS.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className="text-muted-foreground hover:text-foreground"
              >
                {link.label}
              </Link>
            ))}
            <a
              href={`mailto:${COMPANY.email}`}
              className="text-muted-foreground hover:text-foreground"
            >
              {COMPANY.email}
            </a>
          </nav>
        </div>
        <p className="mt-10 border-t border-border pt-6 text-xs leading-relaxed text-muted-foreground">
          {COMPANY.brand} is a product of {COMPANY.legalName}, {COMPANY.city}. WhatsApp is a
          trademark of Meta Platforms, Inc. {COMPANY.brand} is an independent platform built on the
          WhatsApp Business Platform.
        </p>
      </div>
    </footer>
  );
}
