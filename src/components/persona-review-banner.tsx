import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { employeeApi } from "@/lib/employee-client";

/** One-time note on /app home when Aiden's behaviour is a website suggestion. */
export function PersonaReviewBanner({ organizationId }: { organizationId: string | null | undefined }) {
  const [versionId, setVersionId] = useState<string | null>(null);

  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    void employeeApi<{ suggested: boolean; version_id: string | null }>({
      action: "behaviour_status",
      organization_id: organizationId,
    }).then(({ data }) => {
      if (cancelled || !data?.suggested || !data.version_id) return;
      if (localStorage.getItem(`aidwar:persona-review:${data.version_id}`)) return;
      setVersionId(data.version_id);
    });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  if (!versionId) return null;
  const dismiss = () => {
    localStorage.setItem(`aidwar:persona-review:${versionId}`, "1");
    setVersionId(null);
  };

  return (
    <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center">
      <Sparkles className="h-5 w-5 shrink-0 text-primary" />
      <p className="flex-1 text-sm text-foreground">
        <span className="font-medium">I've drafted how I'll talk to your customers</span> from your website. Have a
        quick look and fix anything that's off.
      </p>
      <div className="flex gap-2">
        <Button asChild size="sm" onClick={dismiss}>
          <Link to="/app/employee">Review</Link>
        </Button>
        <Button size="icon" variant="ghost" aria-label="Dismiss" onClick={dismiss}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
