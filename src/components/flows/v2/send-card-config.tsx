import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CardPreview } from "@/components/cards/card-preview";
import { CUSTOMER_CARD_DESIGNS, cardDesign, isCardKind, type CustomerCardKind } from "@/lib/customer-cards";

const sel = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

/** Fill a value with the test customer's name so the preview reads naturally. */
function sample(text: string): string {
  return text.replace(/\{\{\s*(contact\.)?name\s*\}\}/g, "Test customer");
}

/**
 * Settings of a flow's "Send card" step: the design, its details (each can use
 * {{variables}}), optional words under the card and the plain message sent
 * instead if the card can't be drawn. The preview is local — nothing is sent.
 */
export function SendCardConfig({
  d,
  onChange,
  variables,
}: {
  d: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  variables: string[];
}) {
  const kind: CustomerCardKind = isCardKind(d["kind"]) ? d["kind"] : "customer_offer";
  const design = cardDesign(kind)!;
  const vars = (d["vars"] as Record<string, string> | undefined) ?? {};
  const setVar = (key: string, value: string) => onChange({ ...d, kind, vars: { ...vars, [key]: value } });
  const chips = ["name", ...variables];
  const previewVars = Object.fromEntries(design.vars.map((v) => [v.key, sample(String(vars[v.key] ?? ""))]));

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>Card design</Label>
        <select className={sel} value={kind} onChange={(e) => onChange({ ...d, kind: e.target.value, vars: {} })}>
          {CUSTOMER_CARD_DESIGNS.map((x) => (
            <option key={x.kind} value={x.kind}>{x.title}</option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{design.blurb}</p>
      </div>
      {design.vars.map((v) => (
        <div key={v.key} className="space-y-1">
          <Label className="text-xs">{v.label}</Label>
          <Input placeholder={v.placeholder} value={String(vars[v.key] ?? "")} onChange={(e) => setVar(v.key, e.target.value)} />
        </div>
      ))}
      <div className="flex flex-wrap gap-1">
        {chips.map((c) => (
          <span key={c} className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">{`{{${c}}}`}</span>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Type any of these into a detail to fill it with the customer's own answer.</p>
      <div className="space-y-1.5">
        <Label>Words under the card (optional)</Label>
        <Textarea rows={2} value={String(d["caption"] ?? "")} onChange={(e) => onChange({ ...d, kind, caption: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label>If the card can't be drawn, send this instead (optional)</Label>
        <Textarea rows={2} placeholder="e.g. Your booking: {{date}} at {{time}}" value={String(d["fallback_text"] ?? "")} onChange={(e) => onChange({ ...d, kind, fallback_text: e.target.value })} />
        <p className="text-xs text-muted-foreground">Goes as a plain message (with the product photo on a Product card). The flow then follows “Failed” if it's connected, otherwise carries on.</p>
      </div>
      <div className="space-y-1.5">
        <Label>Preview</Label>
        <CardPreview kind={kind} vars={previewVars} className="max-w-[240px]" />
        <p className="text-xs text-muted-foreground">The real card wears your logo and colours from the Cards page.</p>
      </div>
    </div>
  );
}
