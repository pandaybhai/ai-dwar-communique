import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertOctagon, LifeBuoy } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";
import { activeProviderAlert, type ProviderAlertRow } from "@/lib/ai-provider-alert";

/**
 * Shown across /admin while the AI provider is in trouble: the primary is out
 * of credit/quota, or a backup has had to answer. Fed by the activity_log rows
 * ai-fallback.server.ts writes (at most one an hour while it lasts).
 */
export function AiProviderBanner({ className }: { className?: string }) {
  const [alert, setAlert] = useState<ProviderAlertRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data } = await aidwar
        .from("activity_log")
        .select("details, created_at")
        .eq("action", "ai_provider_alert")
        .order("created_at", { ascending: false })
        .limit(1);
      if (cancelled) return;
      setAlert(activeProviderAlert((data ?? []) as ProviderAlertRow[], Date.now()));
    };
    void load();
    const timer = setInterval(() => void load(), 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!alert) return null;
  const servedBy = alert.details.served_by;
  const when = new Date(alert.created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      role="alert"
      className={[
        "mb-6 flex items-start gap-3 rounded-2xl border p-4 shadow-sm",
        servedBy
          ? "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200"
          : "border-destructive/30 bg-destructive/10 text-destructive",
        className ?? "",
      ].join(" ")}
    >
      {servedBy ? (
        <LifeBuoy className="mt-0.5 h-5 w-5 shrink-0" />
      ) : (
        <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0" />
      )}
      <div className="text-sm">
        <p className="font-semibold">
          {alert.details.headline ?? "The AI provider is in trouble"} (since {when})
        </p>
        <p className="mt-0.5 opacity-90">
          {alert.details.detail ?? ""}
          {servedBy
            ? "."
            : ". Top up the Lovable AI credits or store an Anthropic or OpenAI key under Platform providers."}{" "}
          <Link to="/admin/ai" className="font-semibold underline underline-offset-2">
            AI operations
          </Link>
        </p>
      </div>
    </div>
  );
}
