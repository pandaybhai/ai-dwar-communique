import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WaitlistDialog } from "@/components/waitlist-dialog";
import { useSession } from "@/hooks/use-session";

export function SiteHeader() {
  const { session, loading } = useSession();

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/70 bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link to="/" className="text-xl font-bold tracking-tight text-foreground">
          Ai<span className="text-primary">Dwar</span>
        </Link>
        <nav className="flex items-center gap-1 sm:gap-3">
          <Link
            to="/privacy"
            className="hidden rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
          >
            Privacy
          </Link>
          <Link
            to="/terms"
            className="hidden rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
          >
            Terms
          </Link>
          {loading ? (
            <div className="h-9 w-32 animate-pulse rounded-full bg-muted" />
          ) : session ? (
            <Link
              to="/app"
              className="inline-flex h-9 items-center justify-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Go to dashboard
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Log in
              </Link>
              <WaitlistDialog
                trigger={
                  <Button size="sm" className="rounded-full px-4">
                    Get Early Access
                  </Button>
                }
              />
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
