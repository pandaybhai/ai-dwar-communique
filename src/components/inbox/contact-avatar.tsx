import { cn } from "@/lib/utils";
import { initials } from "./inbox-utils";

/** A stable hue per contact, so the same person always has the same colour. */
export function avatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hues = [162, 200, 250, 290, 330, 25, 60, 120];
  return hues[h % hues.length]!;
}

/** Initials on a soft colour (Batch 39); the colours live in .avatar-tone. */
export function ContactAvatar({
  seed,
  label,
  className,
}: {
  seed: string;
  label: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "avatar-tone flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        className,
      )}
      style={{ ["--av-h" as string]: avatarHue(seed) }}
    >
      {initials(label)}
    </span>
  );
}
