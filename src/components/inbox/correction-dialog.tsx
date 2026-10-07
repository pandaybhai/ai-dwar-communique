import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { knowledgeApi } from "@/lib/employee-client";

/**
 * Teaching, not configuration: the merchant writes the answer that should have
 * been given, and it is remembered like anything else the employee has read
 * (knowledge "correct" → saveCorrection, the same store as "Add answer").
 * Opened from "Improve this answer" on an AI reply in the Inbox: the
 * customer's question is filled in (and can be tidied), the reply they got is
 * shown, and the answer starts from it.
 */
export function CorrectionDialog({
  organizationId,
  agentName,
  open,
  customerQuestion,
  saidInstead,
  onOpenChange,
  onSaved,
}: {
  organizationId: string;
  agentName: string;
  open: boolean;
  customerQuestion: string;
  saidInstead: string;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [question, setQuestion] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAnswer(saidInstead);
    setQuestion(customerQuestion);
  }, [open, saidInstead, customerQuestion]);

  const save = async () => {
    const asked = question.trim();
    if (!asked) {
      toast.error("I need the customer's question to file this against.");
      return;
    }
    if (!answer.trim()) {
      toast.error("Write what I should have said.");
      return;
    }
    setSaving(true);
    const { error } = await knowledgeApi({
      organization_id: organizationId,
      action: "correct",
      question: asked,
      answer: answer.trim(),
    });
    setSaving(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(`Thanks — I'll answer this properly next time.`);
    onOpenChange(false);
    onSaved?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Improve this answer</DialogTitle>
          <DialogDescription>
            Write what {agentName} should have said. It's saved with your answers and used the next time someone asks something similar.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="correction-question">The customer asked</Label>
            <Input
              id="correction-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="The customer's question"
            />
          </div>
          {saidInstead.trim() ? (
            <div className="rounded-xl border border-border/70 bg-muted/30 p-3">
              <p className="text-xs font-medium text-muted-foreground">What {agentName} said</p>
              <p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-sm text-foreground">{saidInstead}</p>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="correction">The right answer</Label>
            <Textarea
              id="correction"
              rows={5}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Write it the way you'd say it to the customer."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Teach {agentName}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
