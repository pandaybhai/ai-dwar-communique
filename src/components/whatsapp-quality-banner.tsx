import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";
import { qualityIsHealthy, qualityLabel } from "@/lib/opt-out";

type Flagged = { label: string; number: string };

/**
 * Prominent warning shown wherever sending volume matters when a connected
 * number's quality rating has dropped below GREEN. A workspace can run several
 * numbers, so the banner names the ones that are affected.
 */
export function QualityBanner({
  organizationId,
  whatsappAccountId,
  className,
}: {
  organizationId: string | null | undefined;
  /** Narrow the banner to one number — used on number-scoped screens. */
  whatsappAccountId?: string | null;
  className?: string;
}) {
  const [flagged, setFlagged] = useState<Flagged[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!organizationId) return;
    void (async () => {
      let query = aidwar
        .from("whatsapp_accounts")
        .select("id, quality_rating, status, display_phone_number, verified_name")
        .eq("organization_id", organizationId)
        .eq("status", "active");
      if (whatsappAccountId) query = query.eq("id", whatsappAccountId);

      const { data } = await query;
      if (cancelled) return;

      const rows = (data ?? []) as Array<{
        quality_rating: string | null;
        display_phone_number: string | null;
        verified_name: string | null;
      }>;
      setFlagged(
        rows
          .filter((r) => r.quality_rating && !qualityIsHealthy(r.quality_rating))
          .map((r) => ({
            label: qualityLabel(r.quality_rating as string),
            number: r.display_phone_number || r.verified_name || "your number",
          })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, whatsappAccountId]);

  if (flagged.length === 0) return null;
  const red = flagged.some((f) => f.label === "RED");
  const headline =
    flagged.length === 1
      ? `${flagged[0]!.number} has ${flagged[0]!.label} quality`
      : `${flagged.length} of your numbers have reduced quality`;

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
        <p className="font-semibold">{headline}</p>
        {flagged.length > 1 ? (
          <p className="mt-0.5 opacity-90">
            {flagged.map((f) => `${f.number} (${f.label})`).join(", ")}
          </p>
        ) : null}
        <p className="mt-0.5 opacity-90">
          Sending volume may be restricted — review recent campaigns, message fewer people at a
          time, and make sure everyone you message asked to hear from you.
        </p>
      </div>
    </div>
  );
}
