import { useState } from "react";
import { Loader2, Wallet } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";
import { money } from "@/lib/billing";

export type TopupTask = {
  id: string;
  organization_id: string;
  trigger: string;
  credits_amount: number | null;
  meta_amount: number | null;
  margin_amount: number | null;
  due_at: string | null;
  reminders_sent: number | null;
  organizations?: { name?: string } | null;
  whatsapp_accounts?: { display_phone_number?: string; waba_id?: string } | null;
};

const TRIGGER_LABEL: Record<string, string> = {
  credit_purchase: "Client bought credits",
  float_low: "Float running low",
  onboarding_float: "Onboarding float",
  manual: "Added by hand",
};

function due(at: string | null): { label: string; late: boolean } {
  if (!at) return { label: "No due time", late: false };
  const diff = new Date(at).getTime() - Date.now();
  const hours = Math.round(Math.abs(diff) / 3600e3);
  if (diff >= 0) return { label: `Due in ${hours}h`, late: false };
  return { label: `${hours}h overdue`, late: true };
}

export function TopupsDrawer({
  open,
  tasks,
  onClose,
  onDone,
}: {
  open: boolean;
  tasks: TopupTask[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [refs, setRefs] = useState<Record<string, string>>({});

  async function markDone(task: TopupTask) {
    const amount = Number(amounts[task.id] ?? task.meta_amount ?? 0);
    if (!(amount > 0)) {
      toast.error("Enter how much you topped up.");
      return;
    }
    setBusy(task.id);
    const result = await callApi<{ ok?: boolean; error?: string }>("/api/admin/billing", {
      body: {
        action: "complete_topup",
        task_id: task.id,
        amount,
        meta_txn_ref: refs[task.id] ?? null,
      },
    });
    setBusy(null);
    if (result.error || result.data?.error) {
      toast.error(result.error ?? result.data?.error ?? "That didn't work.");
      return;
    }
    toast.success("Top-up recorded.");
    onDone();
  }

  async function skip(task: TopupTask) {
    const reason = window.prompt("Why are you skipping this top-up?")?.trim();
    if (!reason) return;
    setBusy(task.id);
    const result = await callApi<{ ok?: boolean; error?: string }>("/api/admin/billing", {
      body: { action: "skip_topup", task_id: task.id, reason },
    });
    setBusy(null);
    if (result.error || result.data?.error) {
      toast.error(result.error ?? result.data?.error ?? "That didn't work.");
      return;
    }
    toast.success("Top-up skipped.");
    onDone();
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Top-ups due</SheetTitle>
          <SheetDescription>
            Money we've taken from clients that still has to be placed with Meta.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4">
          {tasks.length === 0 ? (
            <EmptyState
              icon={Wallet}
              title="Nothing to top up"
              description="Every credit purchase has been matched with a Meta top-up. Enjoy the quiet."
            />
          ) : (
            tasks.map((task) => {
              const timing = due(task.due_at);
              return (
                <div
                  key={task.id}
                  className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-foreground">
                        {task.organizations?.name ?? "Unknown workspace"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {task.whatsapp_accounts?.display_phone_number ??
                          task.whatsapp_accounts?.waba_id ??
                          "No number linked"}{" "}
                        · {TRIGGER_LABEL[task.trigger] ?? task.trigger}
                      </p>
                    </div>
                    <span
                      className={
                        timing.late
                          ? "rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive"
                          : "rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground"
                      }
                    >
                      {timing.label}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Credits bought</p>
                      <p className="font-medium">{money(task.credits_amount ?? 0)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Top up</p>
                      <p className="font-medium text-primary">{money(task.meta_amount ?? 0)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Margin</p>
                      <p className="font-medium">{money(task.margin_amount ?? 0)}</p>
                    </div>
                  </div>

                  {Number(task.reminders_sent ?? 0) > 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {task.reminders_sent} reminder{Number(task.reminders_sent) === 1 ? "" : "s"} sent
                    </p>
                  ) : null}

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`amt_${task.id}`}>Amount topped up</Label>
                      <Input
                        id={`amt_${task.id}`}
                        inputMode="decimal"
                        value={amounts[task.id] ?? String(task.meta_amount ?? "")}
                        onChange={(e) =>
                          setAmounts((prev) => ({ ...prev, [task.id]: e.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`ref_${task.id}`}>Meta transaction ref</Label>
                      <Input
                        id={`ref_${task.id}`}
                        value={refs[task.id] ?? ""}
                        onChange={(e) => setRefs((prev) => ({ ...prev, [task.id]: e.target.value }))}
                        placeholder="Optional"
                      />
                    </div>
                  </div>

                  <div className="mt-4 flex gap-2">
                    <Button onClick={() => void markDone(task)} disabled={busy === task.id}>
                      {busy === task.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Mark done
                    </Button>
                    <Button variant="ghost" onClick={() => void skip(task)} disabled={busy === task.id}>
                      Skip
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
