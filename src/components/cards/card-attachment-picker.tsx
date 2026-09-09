import { ImageIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { CUSTOMER_CARD_DESIGNS, type CardAttachment, type CustomerCardKind } from "@/lib/customer-cards";

const NONE = "__none__";

/**
 * Attach a branded picture card to a campaign or a flow step.
 *
 * The card travels after the message itself, so if it can't be drawn the
 * words still arrive. Hidden entirely when cards are switched off.
 */
export function CardAttachmentPicker({
  idPrefix,
  value,
  onChange,
  disabled,
  hint,
}: {
  idPrefix: string;
  value: CardAttachment | null;
  onChange: (next: CardAttachment | null) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const { enabled, loading } = useFeatureFlag("cards");
  if (loading || !enabled) return null;

  const design = CUSTOMER_CARD_DESIGNS.find((d) => d.kind === value?.kind) ?? null;

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-4 sm:col-span-2">
      <div className="flex items-center gap-2">
        <ImageIcon className="h-4 w-4 text-primary" aria-hidden="true" />
        <Label htmlFor={`${idPrefix}-card-kind`} className="text-sm font-semibold">
          Add a picture card (optional)
        </Label>
      </div>
      <Select
        value={value?.kind ?? NONE}
        onValueChange={(v) =>
          onChange(v === NONE ? null : { kind: v as CustomerCardKind, vars: {} })
        }
        disabled={disabled}
      >
        <SelectTrigger id={`${idPrefix}-card-kind`} className="min-h-11">
          <SelectValue placeholder="No card" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>No card</SelectItem>
          {CUSTOMER_CARD_DESIGNS.map((d) => (
            <SelectItem key={d.kind} value={d.kind}>
              {d.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {design ? (
        <>
          <p className="text-xs text-muted-foreground">{design.blurb}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {design.vars.map((v) => (
              <div key={v.key} className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-card-${v.key}`} className="text-xs">
                  {v.label}
                </Label>
                <Input
                  id={`${idPrefix}-card-${v.key}`}
                  className="min-h-11"
                  placeholder={v.placeholder}
                  value={value?.vars[v.key] ?? ""}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange({
                      kind: design.kind,
                      vars: { ...(value?.vars ?? {}), [v.key]: e.target.value },
                    })
                  }
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {hint ??
              "Write {{1}}, {{2}} and so on to reuse the same details you filled into the message."}{" "}
            The card is sent right after the message — if it can't be drawn, the message still goes.
          </p>
        </>
      ) : null}
    </div>
  );
}
