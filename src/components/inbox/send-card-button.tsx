import { useEffect, useMemo, useState } from "react";
import { IdCard, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CardPreview, RealCardPreview } from "@/components/cards/card-preview";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import { CUSTOMER_CARD_DESIGNS, cardDesign, type CustomerCardKind } from "@/lib/customer-cards";
import { callApi } from "@/lib/whatsapp-client";

export const CARD_WINDOW_CLOSED =
  "Cards can only be sent within 24 hours of the customer's last message. Send a template first.";

type ProductPick = { id: string; title: string; price: number | null; currency: string | null; image_url: string | null };

function money(p: ProductPick): string {
  if (p.price === null) return "";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: p.currency || "INR", maximumFractionDigits: 0 }).format(p.price);
}

/**
 * "Send card" in the inbox composer. Hidden when cards are off for the
 * workspace or the teammate can't reply; inside the 24-hour window only —
 * outside it the button stays visible but disabled, saying why.
 */
export function SendCardButton({
  organizationId,
  conversationId,
  windowOpen,
}: {
  organizationId: string | null;
  conversationId: string;
  windowOpen: boolean;
}) {
  const { enabled, loading } = useFeatureFlag("cards");
  const { can } = usePermissions();
  const [open, setOpen] = useState(false);

  if (loading || !enabled || !organizationId || !can("inbox.reply")) return null;

  if (!windowOpen) {
    return (
      <span title={CARD_WINDOW_CLOSED} className="inline-flex">
        <Button size="sm" variant="outline" className="shrink-0 rounded-full" disabled aria-label={`Send card — ${CARD_WINDOW_CLOSED}`}>
          <IdCard className="mr-2 h-4 w-4" /> Send card
        </Button>
      </span>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        className="h-11 w-11 shrink-0 rounded-full p-0"
        aria-label="Send card"
        title="Send a picture card"
        onClick={() => setOpen(true)}
      >
        <IdCard className="h-4 w-4" />
      </Button>
      {open ? (
        <SendCardDialog
          organizationId={organizationId}
          conversationId={conversationId}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}

function SendCardDialog({
  organizationId,
  conversationId,
  open,
  onOpenChange,
}: {
  organizationId: string;
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [kind, setKind] = useState<CustomerCardKind>("customer_offer");
  const [vars, setVars] = useState<Record<string, string>>({});
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const design = cardDesign(kind)!;
  const filled = useMemo(
    () => design.vars.some((v) => v.key !== "image_url" && String(vars[v.key] ?? "").trim()),
    [design, vars],
  );

  const pickDesign = (k: CustomerCardKind) => {
    setKind(k);
    setVars({});
  };

  const send = async () => {
    setBusy(true);
    const { data, error } = await callApi<{ sent: "card" | "fallback" }>("/api/cards", {
      body: { action: "send", organization_id: organizationId, conversation_id: conversationId, kind, vars, caption },
    });
    setBusy(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(
      data?.sent === "fallback"
        ? "The card couldn't be drawn, so its details went as a plain message."
        : "Card sent.",
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send a card</DialogTitle>
          <DialogDescription>
            A branded picture card with your logo and colours. If it can't be drawn, its details go as a plain message.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Card design">
          {CUSTOMER_CARD_DESIGNS.map((d) => (
            <button
              key={d.kind}
              type="button"
              role="radio"
              aria-checked={kind === d.kind}
              onClick={() => pickDesign(d.kind)}
              className={`rounded-full border px-3 py-1.5 text-sm transition ${
                kind === d.kind ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-primary/50"
              }`}
            >
              {d.title}
            </button>
          ))}
        </div>
        <div className="grid gap-5 sm:grid-cols-[1fr_220px]">
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{design.blurb}</p>
            {kind === "customer_product" ? (
              <ProductPicker
                organizationId={organizationId}
                onPick={(p) =>
                  setVars((v) => ({ ...v, name: p.title, price: money(p), image_url: p.image_url ?? "" }))
                }
              />
            ) : null}
            {design.vars.map((v) => (
              <div key={v.key} className="space-y-1">
                <Label htmlFor={`inbox-card-${v.key}`} className="text-xs">{v.label}</Label>
                <Input
                  id={`inbox-card-${v.key}`}
                  className="min-h-10"
                  placeholder={v.placeholder.includes("{{") ? "" : v.placeholder}
                  value={vars[v.key] ?? ""}
                  onChange={(e) => setVars((cur) => ({ ...cur, [v.key]: e.target.value }))}
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label htmlFor="inbox-card-caption" className="text-xs">Words under the card (optional)</Label>
              <Textarea id="inbox-card-caption" rows={2} value={caption} onChange={(e) => setCaption(e.target.value)} />
            </div>
          </div>
          <div className="space-y-3">
            <Label className="text-xs">Preview</Label>
            <CardPreview kind={kind} vars={vars} />
            {filled ? <RealCardPreview organizationId={organizationId} kind={kind} vars={vars} /> : null}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" className="rounded-full" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="rounded-full" disabled={!filled || busy} onClick={() => void send()}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <IdCard className="mr-2 h-4 w-4" />}
            Send card
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Pick one of the workspace's products to fill the Product card's photo, name and price. */
function ProductPicker({ organizationId, onPick }: { organizationId: string; onPick: (p: ProductPick) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ProductPick[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      let query = aidwar
        .from("products")
        .select("id, title, price, currency, image_url")
        .eq("organization_id", organizationId)
        .eq("is_visible", true)
        .order("title")
        .limit(20);
      const term = q.trim().replace(/[%,()]/g, " ");
      if (term) query = query.ilike("title", `%${term}%`);
      void query.then(({ data }) => {
        if (!live) return;
        setRows((data ?? []) as ProductPick[]);
        setLoading(false);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [organizationId, q]);

  return (
    <div className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3">
      <Label htmlFor="inbox-card-product" className="text-xs">Fill from your products</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input id="inbox-card-product" className="min-h-10 pl-9" placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="max-h-40 space-y-1 overflow-y-auto">
        {loading && rows.length === 0 ? (
          <li className="text-xs text-muted-foreground">Loading…</li>
        ) : rows.length === 0 ? (
          <li className="text-xs text-muted-foreground">No products found.</li>
        ) : (
          rows.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-muted"
              >
                {p.image_url ? (
                  <img src={p.image_url} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                ) : (
                  <span className="h-8 w-8 shrink-0 rounded bg-muted" />
                )}
                <span className="min-w-0 flex-1 truncate">{p.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{money(p)}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
