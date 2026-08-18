import { useState } from "react";
import { Gauge, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TierInternalBadge } from "@/components/employee/tier-internal-badge";
import {
  employeeApi,
  moneyText,
  TASK_LABELS,
  type AiTier,
  type EmployeeSettings,
  type TaskTier,
  type TierInternal,
} from "@/lib/employee-client";

const TASKS = ["agent_reply", "suggest_reply", "summarise", "auto_tag"] as const;

/** How careful I should be on each job, and the monthly ceiling on spend. */
export function BrainPicker({
  organizationId,
  tiers,
  internals,
  taskTiers,
  settings,
  spendThisMonth,
  canConfigure,
  onChanged,
}: {
  organizationId: string;
  tiers: AiTier[];
  internals?: TierInternal[] | null;
  taskTiers: TaskTier[];
  settings: EmployeeSettings | null;
  spendThisMonth: number;
  canConfigure: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const currency = settings?.currency ?? "INR";
  const [cap, setCap] = useState(
    settings?.ai_monthly_cap_amount === null || settings?.ai_monthly_cap_amount === undefined
      ? ""
      : String(settings.ai_monthly_cap_amount),
  );
  const [savingCap, setSavingCap] = useState(false);

  const chosen = (task: string) => {
    const row = taskTiers.find((t) => t.task === task && !t.agent_id);
    return row ? row.tier : "recommended";
  };

  const setTier = async (task: string, value: string) => {
    if (value === "recommended") {
      const { error } = await employeeApi({
        organization_id: organizationId,
        action: "save_settings",
        brain_choice: "recommended",
      });
      if (error) toast.error(error);
      else {
        toast.success("Back to my recommendation.");
        await onChanged();
      }
      return;
    }
    const { error } = await employeeApi({
      organization_id: organizationId,
      action: "set_tier",
      task,
      tier: value,
    });
    if (error) toast.error(error);
    else {
      toast.success("Saved. I'll work that way from now on.");
      await onChanged();
    }
  };

  const saveCap = async () => {
    setSavingCap(true);
    const { error } = await employeeApi({
      organization_id: organizationId,
      action: "save_settings",
      ai_monthly_cap_amount: Number(cap),
    });
    setSavingCap(false);
    if (error) toast.error(error);
    else {
      toast.success("Spending limit saved.");
      await onChanged();
    }
  };

  return (
    <section
      aria-labelledby="tiers-heading"
      className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="tiers-heading" className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <Gauge className="h-5 w-5 text-primary" />
            How careful I should be on each job
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Leave these on my recommendation unless you have a reason. Talking to customers
            deserves my most careful work; tagging does not.
          </p>
        </div>
        <Badge variant="secondary">
          {moneyText(spendThisMonth, currency)} spent this month
        </Badge>
      </div>

      {tiers.length > 0 ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {tiers.map((t) => (
            <div key={t.key} className="rounded-xl border border-border/70 bg-muted/20 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-foreground">{t.display_name}</p>
                <TierInternalBadge tier={t.key} internals={internals} />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t.plain_description}</p>
              <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                {t.speed_text ? <li>{t.speed_text}</li> : null}
                {t.quality_text ? <li>{t.quality_text}</li> : null}
                {t.relative_cost_text ? <li>{t.relative_cost_text}</li> : null}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-6 space-y-4">
        {TASKS.map((task) => {
          const label = TASK_LABELS[task];
          return (
            <div
              key={task}
              className="grid gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 md:grid-cols-[1fr_18rem] md:items-center"
            >
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-foreground">{label?.title ?? task}</p>
                  {chosen(task) !== "recommended" ? (
                    <TierInternalBadge tier={chosen(task)} internals={internals} />
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{label?.blurb}</p>
              </div>
              <Select
                value={chosen(task)}
                onValueChange={(v) => void setTier(task, v)}
                disabled={!canConfigure}
              >
                <SelectTrigger aria-label={`How careful I should be when ${label?.title ?? task}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="recommended">
                    <span className="flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                      My recommendation
                    </span>
                  </SelectItem>
                  {tiers.map((t) => (
                    <SelectItem key={t.key} value={t.key}>
                      {t.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>

      <div className="mt-6 grid gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 md:grid-cols-[1fr_18rem] md:items-end">
        <div>
          <p className="text-sm font-medium text-foreground">Monthly spending limit</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            When it hits this, I stop spending and hand everything to your team. There's no
            unlimited option — if this isn't set, I stop rather than spend without a limit.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="ai-cap" className="text-xs">
              Limit ({currency})
            </Label>
            <Input
              id="ai-cap"
              inputMode="decimal"
              value={cap}
              disabled={!canConfigure}
              onChange={(e) => setCap(e.target.value)}
              placeholder="500"
            />
          </div>
          <Button variant="outline" disabled={!canConfigure || savingCap} onClick={() => void saveCap()}>
            Save
          </Button>
        </div>
      </div>
    </section>
  );
}
