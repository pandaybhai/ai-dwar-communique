import { useState } from "react";
import { Eye, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/whatsapp-client";
import { cardDesign, type CustomerCardKind } from "@/lib/customer-cards";

/**
 * A quick, local picture of a card while its fields are being filled in — no
 * request, nothing drawn or billed. The real card (logo, colours) is drawn by
 * the renderer; RealCardPreview asks for it on demand, unmetered.
 */
export function CardPreview({
  kind,
  vars,
  className = "",
}: {
  kind: CustomerCardKind;
  vars: Record<string, string>;
  className?: string;
}) {
  const design = cardDesign(kind);
  if (!design) return null;
  const v = (key: string) => String(vars[key] ?? "").trim();
  const photo = v("image_url");
  const showPhoto = /^https:\/\/\S+$/i.test(photo);
  const rows = design.vars.filter((f) => f.key !== "image_url" && v(f.key));

  return (
    <div
      className={`overflow-hidden rounded-2xl border border-border/70 bg-card text-left shadow-sm ${className}`}
      aria-label={`${design.title} card preview`}
    >
      <div className="bg-gradient-to-r from-primary to-teal-600 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-primary-foreground">
        {design.title}
      </div>
      {kind === "customer_product" && showPhoto ? (
        <img src={photo} alt="" className="aspect-[4/3] w-full bg-muted object-cover" />
      ) : null}
      <div className="space-y-1.5 px-4 py-3">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">Fill in the details to see them here.</p>
        ) : (
          rows.map((f, i) => (
            <p
              key={f.key}
              className={
                i === 0
                  ? "text-base font-semibold leading-snug text-foreground"
                  : f.key === "code" || f.key === "total" || f.key === "price"
                    ? "text-sm font-semibold text-primary"
                    : "text-sm text-muted-foreground"
              }
            >
              {i === 0 ? v(f.key) : `${f.label}: ${v(f.key)}`}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

/** "See the real card" — draws it with the workspace's logo and colours (free, never sent). */
export function RealCardPreview({
  organizationId,
  kind,
  vars,
}: {
  organizationId: string;
  kind: CustomerCardKind;
  vars: Record<string, string>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const draw = async () => {
    setBusy(true);
    const { data, error } = await callApi<{ url: string }>("/api/cards", {
      body: { action: "preview", organization_id: organizationId, kind, vars },
    });
    setBusy(false);
    if (error || !data?.url) {
      toast.error(error ?? "The card couldn't be drawn just now — try again in a moment.");
      return;
    }
    setUrl(data.url);
  };

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" size="sm" className="rounded-full" disabled={busy} onClick={() => void draw()}>
        {busy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Eye className="mr-2 h-3.5 w-3.5" />}
        {url ? "Draw again" : "See the real card"}
      </Button>
      {url ? <img src={url} alt="Card as the customer will see it" className="w-full max-w-xs rounded-xl border border-border/60" /> : null}
    </div>
  );
}
