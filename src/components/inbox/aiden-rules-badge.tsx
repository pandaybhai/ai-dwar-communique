import { useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { aidwar } from "@/integrations/aidwar/client";
import { activeFlowRules, followingLabel, type AidenFlowRules } from "@/lib/aiden-flow-rules";

/**
 * Batch 21: "Aiden is following: <flow name> rules" in the chat header while
 * a flow's Hand-to-Aiden Behaviour / Rules apply to this chat.
 */
export function AidenRulesBadge({ conversationId }: { conversationId: string }) {
  const [rules, setRules] = useState<AidenFlowRules | null>(null);

  const load = useCallback(async () => {
    const { data } = await aidwar.from("conversations").select("aiden_flow_rules").eq("id", conversationId).maybeSingle();
    setRules(activeFlowRules((data as { aiden_flow_rules?: unknown } | null)?.aiden_flow_rules));
  }, [conversationId]);

  useEffect(() => {
    setRules(null);
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (!rules) return null;
  const until = new Date(rules.expires_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const detail = [rules.behaviour && `Behaviour: ${rules.behaviour}`, rules.rules && `Rules: ${rules.rules}`, `Until ${until}`]
    .filter(Boolean)
    .join("\n");
  return (
    <Badge
      variant="outline"
      className="hidden min-w-0 max-w-56 shrink rounded-full border-primary/25 bg-primary/5 font-normal text-primary sm:inline-flex"
      title={`${followingLabel(rules)}\n${detail}`}
    >
      <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
      {/* Batch 39: a narrow chat shows the sparkle only; the words are in the tooltip and for screen readers. */}
      <span className="sr-only @3xl:not-sr-only @3xl:truncate">{followingLabel(rules)}</span>
    </Badge>
  );
}
