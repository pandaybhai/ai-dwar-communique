import { Link } from "@tanstack/react-router";

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
          <div className="flex flex-col gap-3 text-sm sm:items-end">
            <Link to="/privacy" className="text-muted-foreground hover:text-foreground">
              Privacy Policy
            </Link>
            <Link to="/terms" className="text-muted-foreground hover:text-foreground">
              Terms of Service
            </Link>
            <a
              href="mailto:support@aidwar.in"
              className="text-muted-foreground hover:text-foreground"
            >
              support@aidwar.in
            </a>
          </div>
        </div>
        <p className="mt-10 border-t border-border pt-6 text-xs leading-relaxed text-muted-foreground">
          AiDwar is a product of Meezoy Ventures Private Limited, Hyderabad, India. WhatsApp is a
          trademark of Meta Platforms, Inc. AiDwar is an independent platform built on the WhatsApp
          Business Platform.
        </p>
      </div>
    </footer>
  );
}
