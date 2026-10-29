import { cn } from "@/lib/utils";

/**
 * Magic UI's animated-circular-progress-bar (magicui.design), restyled for
 * AiDwar (Batch 44): a ring on the gold tokens by default that moves only its
 * stroke offset (never `transition: all`); reduced motion makes it jump.
 * The value is drawn, not read: give the label to the parent (role="img").
 */
interface AnimatedCircularProgressBarProps {
  max?: number;
  min?: number;
  value: number;
  gaugePrimaryColor?: string;
  gaugeSecondaryColor?: string;
  /** Diameter in px. */
  size?: number;
  strokeWidth?: number;
  className?: string;
  children?: React.ReactNode;
}

export function AnimatedCircularProgressBar({
  max = 100,
  min = 0,
  value = 0,
  gaugePrimaryColor = "var(--gold)",
  gaugeSecondaryColor = "var(--gold-line)",
  size = 56,
  strokeWidth = 6,
  className,
  children,
}: AnimatedCircularProgressBarProps) {
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const share = Math.min(1, Math.max(0, (value - min) / (max - min || 1)));
  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={gaugeSecondaryColor}
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={gaugePrimaryColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - share)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="transition-[stroke-dashoffset] duration-1000 ease-out motion-reduce:transition-none"
        />
      </svg>
      {children ? (
        <span className="absolute inset-0 grid place-items-center">{children}</span>
      ) : null}
    </div>
  );
}
