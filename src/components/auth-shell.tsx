import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  design = "classic",
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
  /** Batch 50: "new" with the new_site switch on (the app's new-design tokens are on). */
  design?: "classic" | "new";
}) {
  if (design === "new") {
    return (
      <main className="ob-stage flex min-h-[100dvh] items-center justify-center px-4 py-12 sm:py-14">
        <div className="w-full max-w-[26rem]">
          <div className="mb-8 text-center">
            <Link
              to="/"
              className="font-display text-[1.625rem] font-extrabold tracking-[-0.02em] text-foreground"
            >
              aidwar
            </Link>
          </div>
          <div className="rounded-[20px] border border-border bg-card p-7 shadow-lg sm:p-8">
            <h1 className="font-display text-[clamp(1.75rem,4vw,2.125rem)] font-extrabold leading-[1.05] tracking-[-0.03em] text-foreground">
              {title}
            </h1>
            <p className="mt-2 text-body text-muted-foreground">{subtitle}</p>
            <div className="mt-6">{children}</div>
          </div>
          <p className="mt-6 text-center text-body text-muted-foreground">{footer}</p>
        </div>
      </main>
    );
  }
  return (
    <main className="ob-stage flex min-h-[100dvh] items-center justify-center px-4 py-12 sm:px-5 sm:py-14">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link to="/" className="text-2xl font-bold tracking-tight text-foreground">
            Ai<span className="text-primary">Dwar</span>
          </Link>
        </div>
        <div className="rounded-2xl border border-border/70 bg-card p-7 shadow-lg shadow-primary/5 sm:p-8">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
        <p className="mt-6 text-center text-sm text-muted-foreground">{footer}</p>
      </div>
    </main>
  );
}
