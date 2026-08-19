import { useCallback, useEffect, useState } from "react";
import { FileText, RefreshCw, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { employeeApi, moneyText, type BriefPreview } from "@/lib/employee-client";

/**
 * Exactly what the employee is told, before a single customer word is added.
 * Merchants pay for this on every message, so they get to read it.
 */
export function PromptPreview({
  organizationId,
  agentName,
  currency,
}: {
  organizationId: string;
  agentName: string;
  currency: string;
}) {
  const [brief, setBrief] = useState<BriefPreview | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await employeeApi<BriefPreview>({
      organization_id: organizationId,
      action: "brief",
    });
    if (error) toast.error(error);
    setBrief(data);
    setLoading(false);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      aria-labelledby="brief-heading"
      className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="brief-heading"
            className="flex items-center gap-2 text-lg font-semibold text-foreground"
          >
            <ScrollText className="h-5 w-5 text-primary" />
            Exactly what {agentName} is told
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            This brief goes out with every single message. The longer it is, the more each answer
            costs.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {loading || !brief ? (
        <div className="mt-6 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{brief.characters.toLocaleString("en-IN")} characters</Badge>
            <Badge variant="secondary">~{brief.estimated_tokens.toLocaleString("en-IN")} tokens</Badge>
            <Badge variant="secondary">
              about {moneyText(brief.estimated_cost, brief.estimated_currency || currency)} per
              message, before the customer says a word
            </Badge>
            {!brief.rules_from_database ? (
              <Badge variant="outline">Platform rules: built-in fallback</Badge>
            ) : (
              <Badge variant="outline">Platform rules v{brief.rules_version}</Badge>
            )}
          </div>

          <div className="mt-6 space-y-4">
            {brief.sections.map((section) => (
              <div key={section.key} className="rounded-xl border border-border/70 bg-muted/20 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    {section.title}
                  </p>
                  {section.editable_by_super_admin ? (
                    <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                      <a href="/admin/ai">Edit platform rules</a>
                    </Button>
                  ) : null}
                </div>
                <pre className="mt-2 whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground">
                  {section.body}
                </pre>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
