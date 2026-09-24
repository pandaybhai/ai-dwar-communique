import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertOctagon } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";

/**
 * Red banner when a connected number keeps failing to send because Meta is
 * refusing its access (set by the send-health monitor, cleared automatically
 * after 3 successful sends).
 */
export function SendHealthBanner({
  organizationId,
  className,
  showLink = false,
}: {
  organizationId: string | null | undefined;
  className?: string;
  showLink?: boolean;
}) {
  const [numbers, setNumbers] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!organizationId) return;
    void (async () => {
      const { data } = await aidwar
        .from("whatsapp_accounts")
        .select("display_phone_number, verified_name, health")
        .eq("organization_id", organizationId)
        .eq("status", "active")
        .eq("health", "needs_attention");
      if (cancelled) return;
      setNumbers(
        ((data ?? []) as Array<{ display_phone_number: string | null; verified_name: string | null }>).map(
          (r) => r.display_phone_number || r.verified_name || "Your number",
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  if (numbers.length === 0) return null;

  return (
    <div
      role="alert"
      className={[
        "flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-destructive shadow-sm",
        className ?? "",
      ].join(" ")}
    >
      <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="text-sm">
        <p className="font-semibold">
          {numbers.length === 1 ? `${numbers[0]} can't send messages` : `${numbers.join(", ")} can't send messages`}
        </p>
        <p className="mt-0.5 opacity-90">
          Meta is refusing this connection's access, so replies and campaigns aren't reaching
          customers. Reconnect the number to fix it.
          {showLink ? (
            <>
              {" "}
              <Link to="/app/settings" className="font-semibold underline underline-offset-2">
                Open WhatsApp settings
              </Link>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}
