import { useEffect, useState } from "react";
import { Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { aidwar } from "@/integrations/aidwar/client";
import { TemplateSentReport } from "@/components/templates/template-sent-report";
import { NO_TEMPLATE_DAYS, refusedNoTemplateText } from "@/lib/api-refusals";

/**
 * Batch 67: on the Message templates page (both designs), the API sends we
 * refused that named no template — a free-form message, or a template
 * request without template_name — one head count through the member's own
 * client, and the Sent sheet in its "no template" mode. Nothing when there
 * were none or the read fails.
 */
export function RefusedNoTemplateLine({
  organizationId,
  variant,
}: {
  organizationId: string | null | undefined;
  variant: "classic" | "new";
}) {
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!organizationId) return;
    let alive = true;
    const since = new Date(Date.now() - NO_TEMPLATE_DAYS * 864e5).toISOString();
    void aidwar
      .from("api_refusals")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .is("template_name", null)
      .gte("created_at", since)
      .then(
        ({ count: n, error }) => {
          if (alive && !error) setCount(n ?? 0);
        },
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [organizationId]);

  if (!organizationId || !count) return null;
  return (
    <>
      <div
        data-testid="refused-no-template"
        className={
          variant === "new"
            ? "flex flex-wrap items-center justify-between gap-3 rounded-[18px] border border-line bg-warning-soft px-4 py-3 text-[0.9375rem] text-warning-soft-foreground"
            : "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100"
        }
      >
        <span className="flex items-center gap-2">
          <Ban className="h-4 w-4 shrink-0" aria-hidden="true" />
          {refusedNoTemplateText(count)}
        </span>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          See them
        </Button>
      </div>
      <TemplateSentReport
        organizationId={organizationId}
        templateName={null}
        noTemplate
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
