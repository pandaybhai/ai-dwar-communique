import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { aidwar } from "@/integrations/aidwar/client";
import { FEATURES } from "@/lib/feature-registry";
import { FEATURE_ICONS } from "@/lib/feature-icons";

/**
 * Per-organization feature state for Super Admin. The list comes from the
 * feature registry, so a newly declared feature shows up here automatically.
 */
export function OrgFeaturesSheet({
  organizationId,
  organizationName,
  open,
  onClose,
}: {
  organizationId: string;
  organizationName: string;
  open: boolean;
  onClose: () => void;
}) {
  const [defaults, setDefaults] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: flags }, { data: ov }] = await Promise.all([
      aidwar.from("feature_flags").select("key, default_enabled"),
      aidwar
        .from("organization_feature_overrides")
        .select("flag_key, enabled")
        .eq("organization_id", organizationId),
    ]);
    const d: Record<string, boolean> = {};
    for (const f of (flags ?? []) as { key: string; default_enabled: boolean }[]) {
      d[f.key] = f.default_enabled;
    }
    const o: Record<string, boolean> = {};
    for (const r of (ov ?? []) as { flag_key: string; enabled: boolean }[]) {
      o[r.flag_key] = r.enabled;
    }
    setDefaults(d);
    setOverrides(o);
    setLoading(false);
  }, [organizationId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

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
  }

  return (
    <Sheet open={open} onOpenChange={(v) => (v ? null : onClose())}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{organizationName}</SheetTitle>
          <SheetDescription>
            Every feature AiDwar ships, with its state for this workspace. Off means the feature
            disappears from their navigation entirely.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-3 pb-10">
          {loading
            ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full rounded-xl" />)
            : FEATURES.map((f) => {
                const Icon = FEATURE_ICONS[f.icon];
                const hasOverride = f.flag_key in overrides;
                const enabled = hasOverride
                  ? Boolean(overrides[f.flag_key])
                  : Boolean(defaults[f.flag_key]);
                return (
                  <div
                    key={f.key}
                    className="flex items-start justify-between gap-4 rounded-xl border border-border/70 bg-card p-4"
                  >
                    <div className="flex min-w-0 gap-3">
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{f.name}</p>
                        <p className="text-xs text-muted-foreground">{f.description}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {hasOverride
                            ? `Overridden for this workspace — ${enabled ? "on" : "off"}`
                            : `Global default — ${enabled ? "on" : "off"}`}
                          {hasOverride ? (
                            <button
                              type="button"
                              className="ml-2 inline-flex items-center underline underline-offset-2 transition-colors hover:text-foreground"
                              onClick={() => void clearOverride(f.flag_key)}
                            >
                              <RotateCcw className="mr-1 h-3 w-3" /> Reset to default
                            </button>
                          ) : null}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {f.permissions.length} permission
                          {f.permissions.length === 1 ? "" : "s"}
                          {f.nav_path ? ` · ${f.nav_path}` : " · no page"}
                        </p>
                      </div>
                    </div>
                    {busy === f.flag_key ? (
                      <Loader2 className="mt-1 h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Switch
                        checked={enabled}
                        onCheckedChange={(v) => void setOverride(f.flag_key, v)}
                      />
                    )}
                  </div>
                );
              })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
