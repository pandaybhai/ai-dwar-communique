import { Check } from "lucide-react";
import {
  renderTemplate,
  templateBodyText,
  templateFooterText,
  type TemplateComponent,
} from "@/lib/templates";

/** Friendly stand-ins so a merchant sees a real message, not {{1}}. */
const SAMPLES: Record<number, string> = {
  1: "Priya",
  2: "₹1,499",
  3: "ORD-1024",
  4: "Blue Cotton Kurta",
  5: "tomorrow",
};

/**
 * The message exactly as the customer will see it. Showing this is what makes
 * a shop owner comfortable switching a flow on, so it is never hidden.
 */
export function MessageBubble({
  components,
  emptyHint = "No message chosen yet.",
}: {
  components: unknown;
  emptyHint?: string;
}) {
  const parts = (components as TemplateComponent[] | null) ?? null;
  const body = renderTemplate(templateBodyText(parts), SAMPLES);
  const footer = templateFooterText(parts);
  // Quick replies are part of what the customer sees, and for cash-on-delivery
  // they are the whole point — show them, don't just describe them.
  const buttons = ((parts ?? []).find(
    (part) => String((part as { type?: string }).type ?? "").toUpperCase() === "BUTTONS",
  ) as { buttons?: { text?: string }[] } | undefined)?.buttons?.filter((b) => b?.text) ?? [];


  if (!body) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
        {emptyHint}
      </p>
    );
  }

  return (
    <div className="rounded-2xl bg-[#ECE5DD] p-3 dark:bg-muted/40">
      <p className="mb-2 text-xs font-medium text-neutral-600 dark:text-muted-foreground">
        This is what your customer sees
      </p>
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#D9FDD3] px-3 py-2 text-left shadow-sm dark:bg-emerald-900/50">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-900 dark:text-foreground">
            {body}
          </p>
          {footer ? (
            <p className="mt-1 text-xs text-neutral-600 dark:text-muted-foreground">{footer}</p>
          ) : null}
          <p className="mt-1 flex items-center justify-end gap-1 text-[11px] text-neutral-600 dark:text-muted-foreground">
            <span>10:24 am</span>
            <Check className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only">Example message, already read</span>
          </p>
          {buttons.length > 0 ? (
            <ul className="-mx-3 mt-2 list-none space-y-px border-t border-neutral-900/10 p-0 pt-1 dark:border-white/10">
              {buttons.map((button) => (
                <li
                  key={button.text}
                  className="px-3 py-1.5 text-center text-sm font-medium text-emerald-700 dark:text-emerald-300"
                >
                  {button.text}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <p className="mt-2 text-xs text-neutral-600 dark:text-muted-foreground">
        Example details shown — real customer names and orders are filled in when it sends.
      </p>
    </div>
  );
}
