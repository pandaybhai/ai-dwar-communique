import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The preview's phone (Batch 44): an ink frame round a dotted chat wall, for
 * showing what a customer will get (a campaign, a card, a flow).
 */
export function PhoneFrame({
  children,
  label = "Message preview",
  className,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <figure
      aria-label={label}
      className={cn(
        "m-0 w-full max-w-[260px] rounded-[36px] bg-ink p-2.5 shadow-2xl wide:max-w-[300px]",
        className,
      )}
    >
      <div className="nd-wall flex min-h-[430px] flex-col gap-0.5 rounded-[28px] px-3 pb-5 pt-10">
        {children}
      </div>
    </figure>
  );
}

/** A template-style message inside a PhoneFrame: optional picture, text, buttons. */
export function PhoneMessage({
  image,
  text,
  buttons = [],
}: {
  image?: ReactNode;
  text: ReactNode;
  buttons?: string[];
}) {
  return (
    <div className="overflow-hidden rounded-[12px] bg-surface shadow-xs">
      {image}
      <p className="m-0 px-2.5 py-2 text-sm text-foreground">{text}</p>
      {buttons.map((b) => (
        <span
          key={b}
          className="block border-t border-line p-[9px] text-center text-sm font-bold text-aiden-deep"
        >
          {b}
        </span>
      ))}
    </div>
  );
}
