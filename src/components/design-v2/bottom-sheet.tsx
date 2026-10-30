import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

/**
 * The phone's bottom sheet (Batch 44): rises from the bottom over a peacock
 * scrim, rounded 24px on top, padded for the home indicator. A real dialog
 * (focus stays inside, Esc and a tap outside close it).
 */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="nd-scrim-in fixed inset-0 z-50 bg-[var(--scrim)]" />
        <DialogPrimitive.Content
          className={cn(
            "nd-sheet-up fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col gap-1 overflow-y-auto rounded-t-[24px] bg-surface pt-5 text-foreground shadow-2xl focus:outline-none",
            "pb-[calc(24px+env(safe-area-inset-bottom))] pl-[max(16px,env(safe-area-inset-left))] pr-[max(16px,env(safe-area-inset-right))]",
            className,
          )}
        >
          <span aria-hidden="true" className="nd-grab" />
          <DialogPrimitive.Title className="px-2 pb-2.5 pt-1 font-display text-xl font-extrabold">
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="sr-only">
              {description}
            </DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          )}
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** One row in a BottomSheet: a big tap target (48px+). */
export const sheetRowClass =
  "flex w-full items-center gap-3 rounded-xl px-2.5 py-3.5 text-left text-base text-foreground transition-colors hover:bg-ground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-aiden";
