import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BUTTON_OPTIONS,
  MAX_BUTTONS,
  MAX_CARD_BUTTONS,
  newButton,
  validateButtons,
  type ButtonKind,
  type DraftButton,
} from "@/lib/templates";

/** Adding and editing the tappable buttons under a message. */
export function ButtonEditor({
  buttons,
  onChange,
  context = "template",
  idPrefix,
}: {
  buttons: DraftButton[];
  onChange: (next: DraftButton[]) => void;
  context?: "template" | "card";
  idPrefix: string;
}) {
  const limit = context === "card" ? MAX_CARD_BUTTONS : MAX_BUTTONS;
  const problems = validateButtons(buttons, context);
  const options = context === "card"
    ? BUTTON_OPTIONS.filter((o) => o.value === "QUICK_REPLY" || o.value === "URL")
    : BUTTON_OPTIONS;

  const update = (index: number, patch: Partial<DraftButton>) =>
    onChange(buttons.map((b, i) => (i === index ? { ...b, ...patch } : b)));

  return (
    <div className="grid gap-3">
      {buttons.map((button, index) => {
        const option = BUTTON_OPTIONS.find((o) => o.value === button.type);
        return (
          <div key={index} className="grid gap-3 rounded-xl border border-border/70 p-3">
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium">{option?.label ?? button.type}</p>
              <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {option?.blurb}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-full"
                aria-label={`Remove ${option?.label ?? "button"}`}
                onClick={() => onChange(buttons.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor={`${idPrefix}-text-${index}`} className="text-xs">
                  Button label
                </Label>
                <Input
                  id={`${idPrefix}-text-${index}`}
                  value={button.text}
                  maxLength={25}
                  onChange={(e) => update(index, { text: e.target.value })}
                  className="mt-1"
                />
              </div>

              {button.type === "URL" ? (
                <>
                  <div>
                    <Label htmlFor={`${idPrefix}-url-${index}`} className="text-xs">
                      Link
                    </Label>
                    <Input
                      id={`${idPrefix}-url-${index}`}
                      value={button.url ?? ""}
                      placeholder="https://yourshop.com/offer/{{1}}"
                      onChange={(e) => update(index, { url: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  {(button.url ?? "").includes("{{1}}") ? (
                    <div className="sm:col-span-2">
                      <Label htmlFor={`${idPrefix}-urlex-${index}`} className="text-xs">
                        Example of the full link
                      </Label>
                      <Input
                        id={`${idPrefix}-urlex-${index}`}
                        value={button.urlExample ?? ""}
                        placeholder="https://yourshop.com/offer/abc123"
                        onChange={(e) => update(index, { urlExample: e.target.value })}
                        className="mt-1"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        Meta reviews a real example. The personalised part is filled in when you send.
                      </p>
                    </div>
                  ) : null}
                </>
              ) : null}

              {button.type === "PHONE_NUMBER" ? (
                <div>
                  <Label htmlFor={`${idPrefix}-phone-${index}`} className="text-xs">
                    Phone number
                  </Label>
                  <Input
                    id={`${idPrefix}-phone-${index}`}
                    value={button.phone_number ?? ""}
                    placeholder="+919876543210"
                    onChange={(e) => update(index, { phone_number: e.target.value })}
                    className="mt-1"
                  />
                </div>
              ) : null}

              {button.type === "COPY_CODE" ? (
                <div>
                  <Label htmlFor={`${idPrefix}-code-${index}`} className="text-xs">
                    Example coupon code
                  </Label>
                  <Input
                    id={`${idPrefix}-code-${index}`}
                    value={button.example ?? ""}
                    placeholder="SAVE20"
                    onChange={(e) => update(index, { example: e.target.value })}
                    className="mt-1"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    The real code is set when you send.
                  </p>
                </div>
              ) : null}

              {button.type === "FLOW" ? (
                <>
                  <div>
                    <Label htmlFor={`${idPrefix}-flow-${index}`} className="text-xs">
                      Form ID
                    </Label>
                    <Input
                      id={`${idPrefix}-flow-${index}`}
                      value={button.flow_id ?? ""}
                      onChange={(e) => update(index, { flow_id: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor={`${idPrefix}-screen-${index}`} className="text-xs">
                      First screen (optional)
                    </Label>
                    <Input
                      id={`${idPrefix}-screen-${index}`}
                      value={button.navigate_screen ?? ""}
                      onChange={(e) => update(index, { navigate_screen: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                </>
              ) : null}
            </div>
          </div>
        );
      })}

      {problems.length > 0 ? (
        <ul className="grid gap-1 text-xs text-destructive">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}

      {buttons.length < limit ? (
        <div className="flex items-center gap-2">
          <Select
            value=""
            onValueChange={(value) => onChange([...buttons, newButton(value as ButtonKind)])}
          >
            <SelectTrigger className="h-9 w-56 rounded-full text-sm" aria-label="Add a button">
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              <SelectValue placeholder="Add a button" />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {buttons.length} of {limit} used
          </p>
        </div>
      ) : null}
    </div>
  );
}
