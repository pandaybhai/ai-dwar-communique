import { useMemo, useState } from "react";
import { CalendarDays } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { localDate, periodBetween, periodForDays, type Period } from "@/lib/analytics";

/**
 * Date range for the Receipts page. Quick presets cover the everyday reads;
 * the calendar handles anything else. Whatever is picked is turned into the
 * same `Period` the reporting functions already take, so nothing downstream
 * changes — the dates are always the organization's own calendar days.
 */

type Preset = { id: string; label: string; build: (timezone: string) => Period };

export const PRESETS: Preset[] = [
  { id: "7d", label: "Last 7 days", build: (tz) => periodForDays(tz, 7, "Last 7 days") },
  { id: "30d", label: "Last 30 days", build: (tz) => periodForDays(tz, 30, "Last 30 days") },
  { id: "90d", label: "Last 90 days", build: (tz) => periodForDays(tz, 90, "Last 90 days") },
  {
    id: "month",
    label: "This month",
    build: (tz) => {
      const today = localDate(tz, 0);
      const from = `${today.slice(0, 7)}-01`;
      return periodBetween(from, today, "This month");
    },
  },
  {
    id: "last-month",
    label: "Last month",
    build: (tz) => {
      const today = localDate(tz, 0);
      const [y, m] = today.split("-").map(Number);
      const prevYear = m === 1 ? (y as number) - 1 : (y as number);
      const prevMonth = m === 1 ? 12 : (m as number) - 1;
      const mm = String(prevMonth).padStart(2, "0");
      const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
      return periodBetween(
        `${prevYear}-${mm}-01`,
        `${prevYear}-${mm}-${String(lastDay).padStart(2, "0")}`,
        "Last month",
      );
    },
  },
];

const toDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date((y as number), (m as number) - 1, (d as number));
};

const fromDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;

export function formatRange(period: Period): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  const from = toDate(period.from).toLocaleDateString("en-IN", opts);
  const to = toDate(period.to).toLocaleDateString("en-IN", opts);
  return from === to ? from : `${from} – ${to}`;
}

export function DateRangePicker({
  timezone,
  period,
  onChange,
}: {
  timezone: string;
  period: Period;
  onChange: (period: Period) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>();

  const activePreset = useMemo(
    () => PRESETS.find((p) => p.label === period.label)?.id ?? null,
    [period.label],
  );

  const selected: DateRange = draft ?? { from: toDate(period.from), to: toDate(period.to) };

  const applyDraft = (next: DateRange | undefined) => {
    setDraft(next);
    if (next?.from && next.to) {
      const from = fromDate(next.from);
      const to = fromDate(next.to);
      onChange(periodBetween(from, to, "Custom range"));
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setDraft(undefined);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="min-w-56 justify-start rounded-full"
          aria-label="Date range"
        >
          <CalendarDays className="mr-2 h-4 w-4" aria-hidden="true" />
          <span className="truncate">
            {activePreset ? period.label : formatRange(period)}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <div className="flex flex-col gap-3 p-3 sm:flex-row">
          <div className="flex shrink-0 flex-col gap-1 sm:w-40">
            {PRESETS.map((preset) => (
              <Button
                key={preset.id}
                variant="ghost"
                size="sm"
                className={cn(
                  "justify-start rounded-lg",
                  activePreset === preset.id && "bg-primary/10 text-primary",
                )}
                onClick={() => {
                  setDraft(undefined);
                  onChange(preset.build(timezone));
                  setOpen(false);
                }}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <div className="border-t border-border/60 pt-3 sm:border-l sm:border-t-0 sm:pl-3 sm:pt-0">
            <Calendar
              mode="range"
              numberOfMonths={1}
              defaultMonth={toDate(period.from)}
              selected={selected}
              onSelect={applyDraft}
              disabled={{ after: toDate(localDate(timezone, 0)) }}
              className={cn("p-0 pointer-events-auto")}
            />
            <p className="px-1 pt-2 text-xs text-muted-foreground">
              Pick a start and end day for a custom range.
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
