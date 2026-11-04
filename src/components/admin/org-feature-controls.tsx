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
import { ownershipLabel } from "@/lib/feature-ownership";
import { callApi } from "@/lib/whatsapp-client";

/**
 * The single feature-state surface for Super Admin. Mounted both from the
 * per-organization features sheet and from the Features tab of the billing
 * sheet, so the two can never disagree.
 *
 * Effective state = hand-set override → plan → global default.
 *
 * Batch 63: a switch flipped here is a person's ("Manual" badge) and survives
 * every plan change; "Reset to plan" hands it back to the plan. Writes go
 * through /api/admin/feature-overrides, which records who owns the row.
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
  const [manual, setManual] = useState<Record<string, boolean>>({});
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
    const [{ data: flags }, { data: owned }, { data: org }] = await Promise.all([
      aidwar.from("feature_flags").select("key, default_enabled"),
      callApi<{ overrides: Record<string, Array<{ flag_key: string; enabled: boolean; manual: boolean }>> }>(
        "/api/admin/feature-overrides",
        { body: { action: "list", organization_id: organizationId } },
      ),
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
    const m: Record<string, boolean> = {};
    for (const r of owned?.overrides?.[organizationId] ?? []) {
      o[r.flag_key] = r.enabled;
      if (r.manual) m[r.flag_key] = true;
    }

    const row = (org ?? null) as Record<string, unknown> | null;
    const version = (row?.["plan_versions"] ?? null) as Record<string, unknown> | null;
    const list = version ? ((version["features"] ?? []) as string[]) : null;

    setDefaults(d);
    setOverrides(o);
    setManual(m);
    setPlanFeatures(row?.["plan_version_id"] && Array.isArray(list) ? list : null);
    setLoading(false);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setOverride(flagKey: string, enabled: boolean) {
    setBusy(flagKey);
    const { error } = await callApi("/api/admin/feature-overrides", {
      body: { action: "set", organization_id: organizationId, flag_key: flagKey, enabled, via: "features_sheet" },
    });
    setBusy(null);
    if (error) {
      toast.error("We couldn't change that feature. Please try again.");
      return;
    }
    setOverrides((prev) => ({ ...prev, [flagKey]: enabled }));
    setManual((prev) => ({ ...prev, [flagKey]: true }));
    onChanged?.();
  }

  async function clearOverride(flagKey: string) {
    setBusy(flagKey);
    const { data, error } = await callApi<{ enabled: boolean | null }>("/api/admin/feature-overrides", {
      body: { action: "reset_to_plan", organization_id: organizationId, flag_key: flagKey },
    });
    setBusy(null);
    if (error) {
      toast.error("We couldn't reset that feature. Please try again.");
      return;
    }
    setOverrides((prev) => {
      const next = { ...prev };
      if (data && typeof data.enabled === "boolean") next[flagKey] = data.enabled;
      else delete next[flagKey];
      return next;
    });
    setManual((prev) => {
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

        const isManual = hasOverride && manual[feature.flag_key] === true;
        const source = ownershipLabel({ hasRow: hasOverride, manual: isManual, enabled, fromPlan, globalDefault });

        const reset = isManual ? (
          <>
            <span
              data-testid={`manual-${feature.flag_key}`}
              className="ml-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-300"
            >
              Manual
            </span>
            <button
              type="button"
              className="ml-2 inline-flex items-center underline underline-offset-2 transition-colors hover:text-foreground"
              onClick={() => void clearOverride(feature.flag_key)}
            >
              <RotateCcw className="mr-1 h-3 w-3" /> Reset to plan
            </button>
          </>
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

      <AlertDialog
        open={confirmOff !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmOff(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch off {confirmOff?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              These also stop working for this workspace:{" "}
              {confirmOff?.dependents.join(", ")}. They will disappear from the
              workspace until you switch {confirmOff?.name} back on.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = confirmOff;
                setConfirmOff(null);
                if (target) void setOverride(target.flagKey, false);
              }}
            >
              Switch off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
