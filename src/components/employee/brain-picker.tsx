import { useState } from "react";
import { Brain, Sparkles } from "lucide-react";
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
import {
  employeeApi,
  moneyText,
  TASK_LABELS,
  type BrainModel,
  type EmployeeSettings,
  type TaskModel,
} from "@/lib/employee-client";

const TASKS = ["agent_reply", "suggest_reply", "summarise", "auto_tag"] as const;

/** Which brain does which job, and the monthly ceiling on spend. */
export function BrainPicker({
  organizationId,
  models,
  taskModels,
  settings,
  spendThisMonth,
  canConfigure,
  onChanged,
}: {
  organizationId: string;
  models: BrainModel[];
  taskModels: TaskModel[];
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
    const row = taskModels.find((t) => t.task === task && !t.agent_id);
    return row ? `${row.provider}::${row.model_id}` : "recommended";
  };

  const setBrain = async (task: string, value: string) => {
    if (value === "recommended") {
      const { error } = await employeeApi({
        organization_id: organizationId,
        action: "save_settings",
        brain_choice: "recommended",
      });
      if (error) toast.error(error);
      else {
        toast.success("Back to our recommendation.");
        await onChanged();
      }
      return;
    }
    const [provider, ...rest] = value.split("::");
    const { error } = await employeeApi({
      organization_id: organizationId,
      action: "set_brain",
      task,
      provider,
      model_id: rest.join("::"),
    });
    if (error) toast.error(error);
    else {
      toast.success("Brain changed.");
      await onChanged();
    }
  };

  const saveCap = async () => {
    setSavingCap(true);
    const { error } = await employeeApi({
      organization_id: organizationId,
      action: "save_settings",
      ai_monthly_cap_amount: cap.trim() === "" ? 0 : Number(cap),
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
      aria-labelledby="brains-heading"
      className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="brains-heading" className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <Brain className="h-5 w-5 text-primary" />
            Which brain does which job
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Leave these on our recommendation unless you have a reason. Talking to customers
            deserves the best one; tagging does not.
          </p>
        </div>
        <Badge variant="secondary">
          {moneyText(spendThisMonth, currency)} spent this month
        </Badge>
      </div>

      <div className="mt-6 space-y-4">
        {TASKS.map((task) => {
          const label = TASK_LABELS[task];
          return (
            <div
              key={task}
              className="grid gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 md:grid-cols-[1fr_18rem] md:items-center"
            >
              <div>
                <p className="text-sm font-medium text-foreground">{label?.title ?? task}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{label?.blurb}</p>
              </div>
              <Select
                value={chosen(task)}
                onValueChange={(v) => void setBrain(task, v)}
                disabled={!canConfigure}
              >
                <SelectTrigger aria-label={`Brain for ${label?.title ?? task}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="recommended">
                    <span className="flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                      Our recommendation
                    </span>
                  </SelectItem>
                  {models.map((m) => (
                    <SelectItem key={`${m.provider}::${m.model_id}`} value={`${m.provider}::${m.model_id}`}>
                      {m.display_name}
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
            When it hits this, the employee stops spending and hands everything to your team. Zero
            means no limit.
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
              placeholder="0"
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
