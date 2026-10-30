import { cn } from "@/lib/utils";

/**
 * Batch 57 (approved preview): three dots that bubble while Aiden is writing
 * a reply. Live state only; under reduced motion the dots stand still.
 */
export function TypingDots({
  label = "Aiden is typing",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span role="img" aria-label={label} className={cn("nd-dots", className)}>
      <i />
      <i />
      <i />
    </span>
  );
}
