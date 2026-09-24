import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw, Save, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";
import { SCRIPTS, isScriptKey } from "@/lib/scripts";

type PromptBlock = {
  key: string;
  name: string;
  description: string;
  content: string;
  default_content: string;
  version: number;
  updated_at: string;
  updated_by_name?: string | null;
};

const LABELS: Record<string, { name: string; description: string }> = {
  ...Object.fromEntries(Object.entries(SCRIPTS).map(([k, v]) => [k, { name: v.name, description: v.description }])),
  agent_rules: { name: "Customer rules", description: "Sent with every reply Aiden writes to a merchant's customers." },
  merchant_rules: { name: "Owner rules", description: "Sent with every reply Aiden writes to a business owner on the AiDwar number." },
};

/**
 * The rules every AI employee on the platform is briefed with. Merchants read
 * them in their prompt preview; this is the only place they are written.
 */
export function PromptBlocksEditor({ keys, heading = true }: { keys?: string[]; heading?: boolean } = {}) {
  const [blocks, setBlocks] = useState<PromptBlock[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await callApi<{ blocks: PromptBlock[] }>("/api/admin/ai", {
      body: { action: "prompt_blocks" },
    });
    if (error) {
      toast.error(error);
      setBlocks([]);
      return;
    }
    const rows = (data?.blocks ?? []).filter((b) => !keys || keys.includes(b.key));
    setBlocks(rows);
    setDrafts(Object.fromEntries(rows.map((b) => [b.key, b.content])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys?.join(",")]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: string, block: PromptBlock) => {
    setBusy(block.key);
    const { error } = await callApi<{ ok: boolean }>("/api/admin/ai", {
      body: { action, key: block.key, content: drafts[block.key] ?? "", base_version: block.version },
    });
    setBusy(null);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(action === "reset_prompt_block" ? "Back to the built-in rules." : "Rules saved.");
    await load();
  };

  return (
    <section className="space-y-4">
      {heading ? <div>
        <h2 className="text-lg font-semibold">Platform rules</h2>
        <p className="text-sm text-muted-foreground">
          Sent with every message on every workspace. Keep it short — merchants pay for each
          character.
        </p>
      </div> : null}

      {!blocks ? (
        <div className="space-y-3">
          <Skeleton className="h-40 rounded-xl" />
        </div>
      ) : blocks.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="No rule blocks registered"
          description="Apply the prompt block registry before editing platform rules."
        />
      ) : (
        blocks.map((block) => {
          const draft = drafts[block.key] ?? "";
          const dirty = draft !== block.content;
          return (
            <div key={block.key} className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-semibold">{LABELS[block.key]?.name ?? (block.name || block.key)}</h3>
                  <p className="text-sm text-muted-foreground">{LABELS[block.key]?.description ?? block.description}</p>
                  {isScriptKey(block.key) ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {SCRIPTS[block.key].vars.length
                        ? `Fills in: ${SCRIPTS[block.key].vars.map((v) => `{${v}}`).join(", ")}`
                        : "No placeholders."}{" "}
                      If anything goes wrong, Aiden sends the built-in wording.
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Last changed {block.updated_by_name ? `by ${block.updated_by_name}, ` : ""}
                    {new Date(block.updated_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">v{block.version}</Badge>
                  <Badge variant="outline">{draft.length.toLocaleString("en-IN")} chars</Badge>
                </div>
              </div>
              <Textarea
                className={`mt-4 resize-y font-mono text-xs leading-relaxed ${isScriptKey(block.key) ? "min-h-24" : "min-h-56"}`}
                value={draft}
                onChange={(event) =>
                  setDrafts((prev) => ({ ...prev, [block.key]: event.target.value }))
                }
              />
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  disabled={busy === block.key || !dirty}
                  onClick={() => void act("save_prompt_block", block)}
                >
                  {busy === block.key ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 h-4 w-4" />
                  )}
                  Save rules
                </Button>
                <Button
                  variant="outline"
                  disabled={busy === block.key || draft === block.default_content}
                  onClick={() => void act("reset_prompt_block", block)}
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Back to built-in
                </Button>
                {dirty ? (
                  <span className="text-xs text-muted-foreground">Unsaved changes.</span>
                ) : null}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
