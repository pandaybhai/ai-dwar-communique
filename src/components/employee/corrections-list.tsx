import { useCallback, useEffect, useState } from "react";
import { GraduationCap, Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { knowledgeApi, whenText, type Correction } from "@/lib/employee-client";

/** Everything the merchant has corrected, and how often it has since been used. */
export function CorrectionsList({
  organizationId,
  agentName,
  canConfigure,
}: {
  organizationId: string;
  agentName: string;
  canConfigure: boolean;
}) {
  const [items, setItems] = useState<Correction[] | null>(null);
  const [editing, setEditing] = useState<Correction | null>(null);
  const [draft, setDraft] = useState({ question: "", answer: "" });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await knowledgeApi<{ corrections: Correction[] }>({
      organization_id: organizationId,
      action: "corrections",
    });
    if (error) toast.error(error);
    setItems(data?.corrections ?? []);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!items) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-20 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <GraduationCap className="h-5 w-5 text-primary" />
          Things you've taught {agentName} ({items.length})
        </h3>
      </div>

      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Nothing yet. When {agentName} gets an answer wrong in the inbox, mark it "Not right" and
          write what he should have said — he'll use it from then on.
        </p>
      ) : (
        <ul className="mt-5 space-y-3">
          {items.map((c) => (
            <li key={c.id} className="rounded-xl border border-border/70 bg-muted/20 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{c.question}</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{c.answer}</p>
                </div>
                <Badge variant="secondary" className="shrink-0">
                  {c.use_count > 0
                    ? `Used ${c.use_count} time${c.use_count === 1 ? "" : "s"}`
                    : "Not used yet"}
                </Badge>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Taught {whenText(c.created_at)}</span>
                {c.last_used_at ? <span>· last used {whenText(c.last_used_at)}</span> : null}
                {canConfigure ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        setEditing(c);
                        setDraft({ question: c.question, answer: c.answer });
                      }}
                    >
                      <Pencil className="mr-1 h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                      disabled={busy === c.id}
                      onClick={async () => {
                        setBusy(c.id);
                        const { error } = await knowledgeApi({
                          organization_id: organizationId,
                          action: "delete_document",
                          document_id: c.id,
                        });
                        setBusy(null);
                        if (error) toast.error(error);
                        else {
                          toast.success("Forgotten.");
                          void load();
                        }
                      }}
                    >
                      {busy === c.id ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                      )}
                      Remove
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit what you taught {agentName}</DialogTitle>
            <DialogDescription>
              He'll use this wording the next time a customer asks something similar.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="c-question">The question</Label>
              <Textarea
                id="c-question"
                rows={2}
                value={draft.question}
                onChange={(e) => setDraft((d) => ({ ...d, question: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-answer">The right answer</Label>
              <Textarea
                id="c-answer"
                rows={5}
                value={draft.answer}
                onChange={(e) => setDraft((d) => ({ ...d, answer: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy === "save"}
              onClick={async () => {
                if (!editing) return;
                setBusy("save");
                const { error } = await knowledgeApi({
                  organization_id: organizationId,
                  action: "update_correction",
                  document_id: editing.id,
                  question: draft.question,
                  answer: draft.answer,
                });
                setBusy(null);
                if (error) {
                  toast.error(error);
                  return;
                }
                toast.success("Saved.");
                setEditing(null);
                void load();
              }}
            >
              {busy === "save" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
