import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, MoonStar } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_SEND_SETTINGS, type SendSettingsRow } from "@/lib/flows";

const TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

/**
 * The sending policy for scheduled messages. It lives in Settings because it is
 * configuration, not a flow — /app/flows links here rather than duplicating it.
 */
export function SendSettingsTab() {
  const { active, reload } = useOrg();
  const { can } = usePermissions();
  const canManage = can("flows.manage");
  const orgId = active?.organization.id ?? null;

  const [row, setRow] = useState<Omit<SendSettingsRow, "organization_id"> | null>(null);
  const [timezone, setTimezone] = useState(active?.organization.timezone || "Asia/Kolkata");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    const { data } = await aidwar
      .from("organization_send_settings")
      .select(
        "quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_exempt_transactional, marketing_cap_per_day, marketing_cap_per_week",
      )
      .eq("organization_id", orgId)
      .maybeSingle();
    setRow((data as Omit<SendSettingsRow, "organization_id">) ?? { ...DEFAULT_SEND_SETTINGS });
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setTimezone(active?.organization.timezone || "Asia/Kolkata");
  }, [active?.organization.timezone]);

  async function save() {
    if (!orgId || !row) return;
    setSaving(true);
    const [{ error: settingsErr }, { error: tzErr }] = await Promise.all([
      aidwar
        .from("organization_send_settings")
        .upsert({ organization_id: orgId, ...row }, { onConflict: "organization_id" }),
      aidwar.from("organizations").update({ timezone }).eq("id", orgId),
    ]);
    setSaving(false);
    if (settingsErr || tzErr) {
      toast.error("We couldn't save your sending settings. Please try again.");
      return;
    }
    void logActivity("send_settings_updated", orgId, {
      quiet_hours: row.quiet_hours_enabled,
      timezone,
    });
    toast.success("Sending settings saved.");
    await reload();
  }

  if (!row) return <Skeleton className="h-80 w-full rounded-2xl" />;

  const set = (patch: Partial<Omit<SendSettingsRow, "organization_id">>) =>
    setRow((prev) => (prev ? { ...prev, ...patch } : prev));

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm sm:p-8">
        <div className="flex items-start gap-3">
          <MoonStar className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <h2 className="text-base font-semibold text-foreground">Quiet hours</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A scheduled message that falls inside this window waits until the window opens — it is
              never dropped.
            </p>
          </div>
        </div>

        <div className="mt-6 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="quiet_enabled">Respect quiet hours</Label>
            <Switch
              id="quiet_enabled"
              checked={row.quiet_hours_enabled}
              disabled={!canManage}
              onCheckedChange={(v) => set({ quiet_hours_enabled: v })}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Starts at</Label>
              <Select
                value={String(row.quiet_hours_start)}
                disabled={!canManage || !row.quiet_hours_enabled}
                onValueChange={(v) => set({ quiet_hours_start: Number(v) })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {hourLabel(h)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Ends at</Label>
              <Select
                value={String(row.quiet_hours_end)}
                disabled={!canManage || !row.quiet_hours_enabled}
                onValueChange={(v) => set({ quiet_hours_end: Number(v) })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {hourLabel(h)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Timezone</Label>
              <Select value={timezone} disabled={!canManage} onValueChange={setTimezone}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from(new Set([timezone, ...TIMEZONES])).map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="exempt">Let transactional messages ignore quiet hours</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Order confirmations and shipping updates go out immediately. Marketing messages
                always wait.
              </p>
            </div>
            <Switch
              id="exempt"
              checked={row.quiet_hours_exempt_transactional}
              disabled={!canManage || !row.quiet_hours_enabled}
              onCheckedChange={(v) => set({ quiet_hours_exempt_transactional: v })}
            />
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm sm:p-8">
        <h2 className="text-base font-semibold text-foreground">Marketing frequency caps</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          How often one contact may receive a marketing message from a flow. Transactional messages
          are never capped.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="cap_day">Maximum per 24 hours</Label>
            <Input
              id="cap_day"
              type="number"
              min={0}
              value={row.marketing_cap_per_day}
              disabled={!canManage}
              onChange={(e) => set({ marketing_cap_per_day: Math.max(0, Number(e.target.value)) })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cap_week">Maximum per 7 days</Label>
            <Input
              id="cap_week"
              type="number"
              min={0}
              value={row.marketing_cap_per_week}
              disabled={!canManage}
              onChange={(e) => set({ marketing_cap_per_week: Math.max(0, Number(e.target.value)) })}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {canManage ? (
          <Button className="rounded-full" disabled={saving} onClick={() => void save()}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save sending settings
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only owners and admins with the “Manage flows” permission can change these.
          </p>
        )}
        <Button asChild variant="outline" size="sm" className="rounded-full">
          <Link to="/app/flows">Back to flows</Link>
        </Button>
      </div>
    </div>
  );
}
