import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";

/**
 * The one place the code, QR and "say hello" link are drawn. Used by the
 * sign-up step and by the dashboard reminder — never duplicated.
 */
export function AidenHandoff({
  code,
  waLink,
  compact = false,
}: {
  code: string;
  waLink: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (!waLink) return;
    let live = true;
    QRCode.toDataURL(waLink, { width: 320, margin: 1 })
      .then((url) => {
        if (live) setQr(url);
      })
      .catch(() => {
        if (live) setQr(null);
      });
    return () => {
      live = false;
    };
  }, [waLink]);

  return (
    <div className={compact ? "flex flex-col gap-4 sm:flex-row sm:items-center" : ""}>
      <div className={compact ? "flex-1" : ""}>
        <Button
          asChild
          size="lg"
          className={`${compact ? "h-12 w-full sm:w-auto" : "mt-8 h-14 w-full"} rounded-full text-base transition-all duration-200`}
        >
          <a href={waLink} target="_blank" rel="noreferrer">
            Say hello to Aiden
          </a>
        </Button>

        <div className={compact ? "mt-4" : "mt-6"}>
          <div className={`flex items-center gap-3 ${compact ? "" : "justify-center"}`}>
            <code className="rounded-xl bg-muted px-4 py-2 font-mono text-2xl font-bold tracking-widest text-foreground sm:text-3xl">
              {code}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(code);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
              className="rounded-md p-2 text-muted-foreground transition-colors duration-150 hover:text-foreground"
              aria-label="Copy your code"
            >
              {copied ? <Check className="h-5 w-5 text-primary" /> : <Copy className="h-5 w-5" />}
            </button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Send this to Aiden if the link doesn't open.
          </p>
        </div>
      </div>

      {qr ? (
        <div
          className={`rounded-2xl border border-border bg-card p-4 text-center ${compact ? "sm:w-48" : "mt-8 p-6"}`}
        >
          <img
            src={qr}
            alt={`QR code that opens a chat with Aiden using code ${code}`}
            className={`mx-auto rounded-lg ${compact ? "h-32 w-32" : "h-40 w-40"}`}
          />
          <p className="mt-3 text-xs text-muted-foreground sm:text-sm">
            On a laptop? Scan with your phone — the chat opens with your code filled in.
          </p>
        </div>
      ) : null}
    </div>
  );
}
