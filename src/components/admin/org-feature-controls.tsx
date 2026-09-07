import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { aidwar } from "@/integrations/aidwar/client";
import { FEATURES } from "@/lib/feature-registry";
import { FEATURE_ICONS } from "@/lib/feature-icons";

/**
 * The single feature-state surface for Super Admin. Mounted both from the
 * per-organization features sheet and from the Features tab of the billing
 * sheet, so the two can never disagree.
 *
 * Effective state = hand-set override → plan → global default.
 */
export function OrgFeatureControls({
  organizationId,
  compact = false,
  onChanged,
}: {
  organizationId: string;
  compact?: boolean;
  onChanged?: () => void;
}) {
  const [defaults, setDefaults] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [planFeatures, setPlanFeatures] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState<{
    flagKey: string;
    name: string;
    dependents: string[];
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: flags }, { data: ov }, { data: org }] = await Promise.all([
      aidwar.from("feature_flags").select("key, default_enabled"),
      aidwar
        .from("organization_feature_overrides")
        .select("flag_key, enabled")
        .eq("organization_id", organizationId),
      aidwar
        .from("organizations")
        .select("plan_version_id, plan_versions(features)")
        .eq("id", organizationId)
        .maybeSingle(),
    ]);

    const d: Record<string, boolean> = {};
    for (const f of (flags ?? []) as { key: string; default_enabled: boolean }[]) {
      d[f.key] = f.default_enabled;
    }
    const o: Record<string, boolean> = {};
    for (const r of (ov ?? []) as { flag_key: string; enabled: boolean }[]) {
      o[r.flag_key] = r.enabled;
    }

    const row = (org ?? null) as Record<string, unknown> | null;
    const version = (row?.["plan_versions"] ?? null) as Record<string, unknown> | null;
    const list = version ? ((version["features"] ?? []) as string[]) : null;

    setDefaults(d);
    setOverrides(o);
    setPlanFeatures(row?.["plan_version_id"] && Array.isArray(list) ? list : null);
    setLoading(false);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setOverride(flagKey: string, enabled: boolean) {
    setBusy(flagKey);
    const { error } = await aidwar
      .from("organization_feature_overrides")
      .upsert(
        { organization_id: organizationId, flag_key: flagKey, enabled },
        { onConflict: "organization_id,flag_key" },
      );
    setBusy(null);
    if (error) {
      toast.error("We couldn't change that feature. Please try again.");
      return;
    }
    setOverrides((prev) => ({ ...prev, [flagKey]: enabled }));
    onChanged?.();
  }

  async function clearOverride(flagKey: string) {
    setBusy(flagKey);
    const { error } = await aidwar
      .from("organization_feature_overrides")
      .delete()
      .eq("organization_id", organizationId)
      .eq("flag_key", flagKey);
    setBusy(null);
    if (error) {
      toast.error("We couldn't reset that feature. Please try again.");
      return;
    }
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[flagKey];
      return next;
    });
    onChanged?.();
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className={compact ? "h-12 w-full rounded-lg" : "h-20 w-full rounded-xl"} />
        ))}
      </div>
    );
  }

  return (
    <div className={compact ? "divide-y divide-border/60" : "space-y-3"}>
      {FEATURES.map((feature) => {
        const Icon = FEATURE_ICONS[feature.icon];
        const hasOverride = feature.flag_key in overrides;
        const fromPlan = planFeatures ? planFeatures.includes(feature.flag_key) : null;
        const globalDefault = Boolean(defaults[feature.flag_key]);
        const enabled = hasOverride
          ? Boolean(overrides[feature.flag_key])
          : fromPlan !== null
            ? fromPlan
            : globalDefault;

        const baseline = fromPlan !== null ? fromPlan : globalDefault;
        const source = hasOverride
          ? `Set by hand — ${enabled ? "on" : "off"}${
              enabled === baseline
                ? ""
                : ` (differs from ${fromPlan !== null ? "plan" : "default"})`
            }`
          : fromPlan !== null
            ? `From plan — ${fromPlan ? "on" : "off"}`
            : `Global default — ${globalDefault ? "on" : "off"}`;

        const reset = hasOverride ? (
          <button
            type="button"
            className="ml-2 inline-flex items-center underline underline-offset-2 transition-colors hover:text-foreground"
            onClick={() => void clearOverride(feature.flag_key)}
          >
            <RotateCcw className="mr-1 h-3 w-3" /> Reset
          </button>
        ) : null;

        const control =
          busy === feature.flag_key ? (
            <Loader2 className="mt-1 h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Switch
              checked={enabled}
              onCheckedChange={(v) => {
                if (!v) {
                  const dependents = FEATURES.filter((f) =>
                    f.depends_on.includes(feature.key),
                  ).map((f) => f.name);
                  if (dependents.length > 0) {
                    setConfirmOff({
                      flagKey: feature.flag_key,
                      name: feature.name,
                      dependents,
                    });
                    return;
                  }
                }
                void setOverride(feature.flag_key, v);
              }}
            />
          );

        if (compact) {
          return (
            <div key={feature.key} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{feature.name}</p>
                <p className="text-xs text-muted-foreground">
                  {source}
                  {reset}
                </p>
              </div>
              {control}
            </div>
          );
        }

        return (
          <div
            key={feature.key}
            className="flex items-start justify-between gap-4 rounded-xl border border-border/70 bg-card p-4"
          >
            <div className="flex min-w-0 gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{feature.name}</p>
                <p className="text-xs text-muted-foreground">{feature.description}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {source}
                  {reset}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {feature.permissions.length} permission
                  {feature.permissions.length === 1 ? "" : "s"}
                  {feature.nav_path ? ` · ${feature.nav_path}` : " · no page"}
                </p>
              </div>
            </div>
            {control}
          </div>
        );
      })}
    </div>
  );
}
