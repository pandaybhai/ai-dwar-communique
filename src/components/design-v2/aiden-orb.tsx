import { Ripple } from "@/components/magicui/ripple";
import { cn } from "@/lib/utils";

export type AidenOrbState = "replying" | "draft" | "off";

/**
 * Aiden, drawn (Batch 44, docs/design/spec.md): an emerald orb. "replying"
 * sends out rings (he is answering right now), "draft" breathes calmly (he
 * writes, you send), "off" is pale and breathes (your team answers).
 * Decorative unless given a label.
 */
export function AidenOrb({
  state = "replying",
  size = 72,
  label,
  className,
}: {
  state?: AidenOrbState;
  size?: 56 | 72 | 40;
  label?: string;
  className?: string;
}) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        "relative grid shrink-0 place-items-center",
        state === "draft" && "nd-orb-draft",
        state === "off" && "nd-orb-off",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {state === "replying" ? <Ripple numCircles={3} /> : null}
      <span
        className="nd-orb-core absolute rounded-full"
        style={{ inset: Math.round(size * 0.195) }}
      />
    </span>
  );
}
