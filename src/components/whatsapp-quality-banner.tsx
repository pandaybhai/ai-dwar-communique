import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";
import { qualityIsHealthy, qualityLabel } from "@/lib/opt-out";

/**
 * Prominent warning shown wherever sending volume matters when the connected
 * number's quality rating has dropped below GREEN.
 */
export function QualityBanner({
  organizationId,
  className,
}: {
  organizationId: string | null | undefined;
  className?: string;
}) {
  const [rating, setRating] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!organizationId) return;
    void (async () => {
      const { data } = await aidwar
        .from("whatsapp_accounts")
        .select("quality_rating, status")
        .eq("organization_id", organizationId)
        .order("connected_at", { ascending: false, nullsFirst: false })
        .limit(1);
      const row = (data ?? [])[0] as { quality_rating: string | null; status: string } | undefined;
      if (cancelled) return;
      setRating(row && row.status === "active" ? row.quality_rating : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  if (!rating || qualityIsHealthy(rating)) return null;
  const label = qualityLabel(rating);
  const red = label === "RED";

  return (
    <div
      role="status"
      className={[
        "flex items-start gap-3 rounded-2xl border p-4 shadow-sm transition-colors duration-200",
        red
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
        className ?? "",
      ].join(" ")}
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="text-sm">
        <p className="font-semibold">Your number quality is {label}</p>
        <p className="mt-0.5 opacity-90">
          Sending volume may be restricted — review recent campaigns, message fewer people at a
          time, and make sure everyone you message asked to hear from you.
        </p>
      </div>
    </div>
  );
}
