import { cn } from "@/lib/utils";

/**
 * Magic UI's avatar-circles (magicui.design), restyled for AiDwar (Batch 44):
 * contacts are initials on the five avatar tones (no photos, no outside
 * links), overlapping, with a "+N" for the rest.
 */
export type AvatarCircle = { initials: string; name: string; tone?: 1 | 2 | 3 | 4 | 5 };

const TONES = {
  1: "bg-av1 text-av1-ink",
  2: "bg-av2 text-av2-ink",
  3: "bg-av3 text-av3-ink",
  4: "bg-av4 text-av4-ink",
  5: "bg-av5 text-av5-ink",
} as const;

interface AvatarCirclesProps {
  className?: string;
  people: AvatarCircle[];
  /** How many more there are beyond the ones shown. */
  more?: number;
}

export const AvatarCircles = ({ more = 0, className, people }: AvatarCirclesProps) => (
  <div className={cn("flex -space-x-3", className)}>
    {people.map((p, i) => (
      <span
        key={`${p.initials}-${i}`}
        title={p.name}
        className={cn(
          "grid h-10 w-10 place-items-center rounded-full text-sm font-bold ring-2 ring-surface",
          TONES[p.tone ?? (((i % 5) + 1) as 1 | 2 | 3 | 4 | 5)],
        )}
      >
        <span aria-hidden="true">{p.initials}</span>
        <span className="sr-only">{p.name}</span>
      </span>
    ))}
    {more > 0 ? (
      <span className="grid h-10 w-10 place-items-center rounded-full bg-ink text-xs font-bold text-ink-foreground ring-2 ring-surface">
        +{more}
      </span>
    ) : null}
  </div>
);
