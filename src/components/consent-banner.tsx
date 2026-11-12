import { Link } from "@tanstack/react-router";

/**
 * Batch 71: the cookie banner itself. Two equal buttons: Accept (filled, the
 * brand colour) and Decline (a plain text button of the same size and tap
 * target, in full-strength text, never hidden or greyed out). Decline is one
 * click and is respected: the pixel never loads.
 */
export function ConsentBanner({
  onChoose,
}: {
  onChoose: (value: "accepted" | "declined") => void;
}) {
  return (
    <div
      role="region"
      aria-label="Cookies"
      data-testid="meta-consent-banner"
      // Batch 72: above /start's bottom bar when it is on screen (0 elsewhere).
      style={{ bottom: "var(--aidwar-bottom-bar, 0px)" }}
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 px-4 py-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-foreground">
          We use cookies to show you relevant offers and improve AiDwar.{" "}
          <Link to="/privacy" className="text-primary underline underline-offset-2">
            Privacy
          </Link>
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            data-testid="consent-decline"
            onClick={() => onChoose("declined")}
            className="min-h-11 min-w-28 flex-1 rounded-full px-5 text-sm font-semibold text-foreground underline-offset-4 hover:bg-muted hover:underline sm:flex-none"
          >
            Decline
          </button>
          <button
            type="button"
            data-testid="consent-accept"
            onClick={() => onChoose("accepted")}
            className="min-h-11 min-w-28 flex-1 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 sm:flex-none"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
