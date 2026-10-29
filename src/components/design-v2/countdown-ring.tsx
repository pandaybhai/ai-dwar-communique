import { AnimatedCircularProgressBar } from "@/components/magicui/animated-circular-progress-bar";
import { cn } from "@/lib/utils";

/**
 * Time left on something that closes (Batch 44): WhatsApp's free 24-hour
 * reply window. A gold ring that empties as time runs out; `label` says it in
 * words for screen readers ("1 hour 40 minutes left").
 */
export function CountdownRing({
  remaining,
  total = 24 * 60,
  label,
  size = 56,
  className,
}: {
  /** Minutes left. */
  remaining: number;
  /** Minutes in the whole window. */
  total?: number;
  label: string;
  size?: number;
  className?: string;
}) {
  return (
    <span role="img" aria-label={label} className={cn("inline-flex", className)}>
      <AnimatedCircularProgressBar value={Math.max(0, remaining)} max={total} size={size} />
    </span>
  );
}
