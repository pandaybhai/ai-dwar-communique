import { useEffect, useState } from "react";
import { callApi } from "@/lib/whatsapp-client";
import { metaCapiStatusText, type MetaCapiStatusRow as Status } from "@/lib/meta-events";

export function MetaCapiStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    void callApi<Status>("/api/admin/billing", { body: { action: "meta_capi_status" } }).then(
      ({ data }) => setStatus(data ?? null),
      () => setStatus(null),
    );
  }, []);
  if (!status) return null;
  return (
    <p
      data-testid="meta-capi-status"
      className={
        status.token === "missing" || status.last_error
          ? "mt-2 text-sm text-amber-700 dark:text-amber-300"
          : "mt-2 text-sm text-muted-foreground"
      }
    >
      {metaCapiStatusText(status)}
    </p>
  );
}
