import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AidenOrb, NumberTicker } from "@/components/design-v2";
import { initials } from "@/components/inbox/inbox-utils";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { money } from "@/lib/billing";
import { percent, type CampaignRow } from "@/lib/campaigns";
import type { HomeMode } from "@/lib/new-home";
import { cn } from "@/lib/utils";

/**
 * Batch 45: the small pieces the new Home is drawn with
 * (docs/design/preview.html #home). Tokens only; motion stops under reduced
 * motion (NumberTicker, nd-bar-grow).
 */

export const count = new Intl.NumberFormat("en-IN");

const TONES = [
  "bg-av1 text-av1-ink",
  "bg-av2 text-av2-ink",
  "bg-av3 text-av3-ink",
  "bg-av4 text-av4-ink",
  "bg-av5 text-av5-ink",
] as const;

function toneOf(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length]!;
}

/** A contact's initials on one of the five avatar colours, the same one every time. */
export function HomeAvatar({ seed, label }: { seed: string; label: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-bold",
        toneOf(seed),
      )}
    >
      {initials(label)}
    </span>
  );
}

export function contactName(c: { name: string | null; phone: string } | null | undefined): string {
  return c?.name?.trim() || c?.phone || "A customer";
}

/** First name only, for a button ("Reply to Asha"). */
export function firstName(label: string): string {
  return label.startsWith("+") ? label : (label.split(/\s+/)[0] ?? label);
}

const MODE_OPTIONS: Array<{ key: HomeMode; label: string }> = [
  { key: "replying", label: "Aiden replying" },
  { key: "draft", label: "Aiden drafts" },
  { key: "off", label: "Aiden off" },
];

/**
 * Aiden’s mode, the preview's segmented switch: the same three modes as the
 * Employee page, and only ai.configure may change it. (set_mode keeps the
 * workspace AI switch equal to the mode, syncAiSwitch, so Off to Draft is one
 * press here too.)
 */
export function ModeSwitch({
  mode,
  canChange,
  busy,
  onChange,
}: {
  mode: HomeMode;
  canChange: boolean;
  busy: HomeMode | null;
  onChange: (mode: HomeMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Aiden"
      className="inline-flex self-end rounded-[14px] border border-line bg-surface p-1 phone:grid phone:grid-cols-3 phone:self-stretch"
    >
      {MODE_OPTIONS.map((o) => {
        const pressed = o.key === mode;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={pressed}
            aria-busy={busy === o.key || undefined}
            disabled={!canChange || busy !== null}
            title={
              canChange
                ? undefined
                : "Only someone who can change Aiden’s settings can switch this."
            }
            onClick={() => {
              if (!pressed) onChange(o.key);
            }}
            className={cn(
              "rounded-[10px] px-3.5 py-2 text-sm font-semibold transition-[background-color,color] duration-[250ms] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden active:scale-[0.98] disabled:cursor-not-allowed phone:px-1 phone:py-[9px] phone:text-[13px]",
              pressed
                ? "bg-ink text-ink-foreground"
                : "text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground",
              !pressed && !canChange && "opacity-60",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** "Test Aiden first?": the Employee page's gate before Replying, said from Home. */
export function TestFirstDialog({
  gate,
  onClose,
  onSwitchAnyway,
}: {
  gate: { mode: HomeMode; message: string } | null;
  onClose: () => void;
  onSwitchAnyway: (mode: HomeMode) => void;
}) {
  const navigate = useNavigate();
  return (
    <AlertDialog open={gate !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Test Aiden first?</AlertDialogTitle>
          <AlertDialogDescription>{gate?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <Button
            variant="outline"
            onClick={() => {
              const mode = gate?.mode;
              onClose();
              if (mode) onSwitchAnyway(mode);
            }}
          >
            Switch anyway
          </Button>
          <Button
            onClick={() => {
              onClose();
              void navigate({ to: "/app/employee" });
            }}
          >
            Test on Aiden’s page
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type StatRow = {
  label: string;
  value: number;
  /** Set for money: shown with its currency. */
  currency?: string;
};

/** Today's numbers, each counting up once (final number under reduced motion). */
export function TodayStats({ rows }: { rows: StatRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="home-today" className="flex flex-col gap-2.5">
      <h2 id="home-today" className="font-display text-lg font-semibold">
        Today
      </h2>
      <dl className="m-0">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 last:border-b-0"
          >
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="m-0 font-display text-2xl font-semibold tabular-nums">
              {r.currency && r.currency !== "INR" ? (
                money(r.value, r.currency)
              ) : (
                <NumberTicker
                  value={r.currency ? Math.round(r.value) : r.value}
                  prefix={r.currency ? "₹" : ""}
                />
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** A bar that grows once to its share; the number beside it says it in words. */
export function Bar({ value, tone = "aiden" }: { value: number; tone?: "aiden" | "gold" }) {
  const w = Math.max(0, Math.min(100, value));
  return (
    <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-line">
      <i
        className={cn(
          "nd-bar-grow block h-full rounded-full",
          tone === "gold" ? "bg-gold" : "bg-aiden",
        )}
        style={{ width: `${w}%` }}
      />
    </div>
  );
}

export function SideSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2.5">
      <h2 id={id} className="font-display text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The latest campaign's read and replied shares (of everyone it went to). */
export function LatestCampaign({ campaign }: { campaign: CampaignRow }) {
  const read = percent(campaign.read_count, campaign.total_recipients);
  const replied = percent(campaign.replied_count, campaign.total_recipients);
  return (
    <SideSection id="home-campaign" title={campaign.name}>
      <div className="flex justify-between text-sm text-muted-foreground">
        <span>Read</span>
        <span className="tabular-nums">{read}%</span>
      </div>
      <Bar value={read} />
      <div className="flex justify-between text-sm text-muted-foreground">
        <span>Replied</span>
        <span className="tabular-nums">
          {count.format(campaign.replied_count)}{" "}
          {campaign.replied_count === 1 ? "person" : "people"}
        </span>
      </div>
      <Bar value={replied} />
    </SideSection>
  );
}

/**
 * The preview's two columns: the signature (live work) on the left, at most
 * three quiet supports on the right; one column under 900px.
 */
export function HomeGrid({
  orb,
  headline,
  lede,
  children,
  side,
}: {
  orb: ReactNode;
  headline: string;
  lede: string;
  children: ReactNode;
  side: ReactNode;
}) {
  return (
    <div className="grid items-start gap-10 min-[901px]:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
      <section aria-labelledby="home-headline" className="flex min-w-0 flex-col gap-[22px]">
        <div aria-live="polite" className="flex flex-col gap-[22px]">
          <div className="flex items-center gap-5 phone:gap-3.5">
            {orb}
            <h1
              id="home-headline"
              className="m-0 min-w-0 font-display text-[clamp(32px,4.6vw,52px)] font-extrabold leading-[1.02] tracking-[-1.6px] text-balance [overflow-wrap:break-word] phone:text-[30px] phone:tracking-[-1px]"
            >
              {headline}
            </h1>
          </div>
          <p className="m-0 max-w-[44ch] text-[17px] text-muted-foreground phone:text-base">
            {lede}
          </p>
        </div>
        {children}
      </section>
      <aside aria-label="Today and what needs you" className="flex min-w-0 flex-col gap-7">
        {side}
      </aside>
    </div>
  );
}

/** The orb at the preview's sizes: 72px, 56px on a phone. */
export function HomeOrb({ state, label }: { state: "replying" | "draft" | "off"; label: string }) {
  return (
    <>
      <AidenOrb state={state} size={72} label={label} className="phone:hidden" />
      <AidenOrb state={state} size={56} label={label} className="wide:hidden" />
    </>
  );
}
