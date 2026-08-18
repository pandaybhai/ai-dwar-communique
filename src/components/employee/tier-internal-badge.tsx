import { useOrg } from "@/lib/org-context";
import type { TierInternal } from "@/lib/employee-client";

/**
 * Platform truth, shown to nobody but a platform Super Admin.
 *
 * Merchants see tier names only ("Everyday", "Careful"); this badge names the
 * real vendor, model and route behind one. It is deliberately styled as an
 * internal instrument — muted, monospace, uppercase label — so it can never
 * be mistaken for merchant copy. The gate is profiles.is_super_admin via the
 * org context, not a workspace role and not a feature flag.
 */
export function TierInternalBadge({
  tier,
  internals,
  provider,
  model,
  route,
  className = "",
}: {
  /** The tier key a run used, when the badge should look the truth up. */
  tier?: string | null | undefined;
  internals?: TierInternal[] | null | undefined;
  /** Or the resolved values straight from a past run. */
  provider?: string | null | undefined;
  model?: string | null | undefined;
  route?: "direct" | "gateway" | string | null | undefined;
  className?: string;
}) {
  const { isSuperAdmin } = useOrg();
  if (!isSuperAdmin) return null;

  const found = tier ? internals?.find((row) => row.key === tier) : undefined;
  const vendor = provider ?? found?.provider ?? null;
  const modelId = model ?? found?.model_id ?? null;
  const routing = route ?? found?.route ?? null;
  if (!vendor || !modelId) return null;

  return (
    <span
      title="Platform-internal: the real provider and model behind this tier. Merchants never see this."
      className={`inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed border-muted-foreground/40 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-muted-foreground ${className}`}
    >
      <span className="tracking-widest uppercase opacity-70">internal</span>
      <span className="truncate">
        {vendor} · {modelId}
        {routing ? ` · ${routing}` : ""}
      </span>
    </span>
  );
}
