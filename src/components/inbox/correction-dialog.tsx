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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { knowledgeApi } from "@/lib/employee-client";

/**
 * Teaching, not configuration: the merchant writes the answer that should have
 * been given, and it is remembered like anything else the employee has read.
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
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setAnswer(saidInstead);
  }, [open, saidInstead]);

  const save = async () => {
    const question = customerQuestion.trim();
    if (!question) {
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
      question,
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
          <DialogTitle>What should {agentName} have said?</DialogTitle>
          <DialogDescription>
            I'll remember this and use it the next time someone asks something similar.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-xl border border-border/70 bg-muted/30 p-3">
            <p className="text-xs font-medium text-muted-foreground">The customer asked</p>
            <p className="mt-1 text-sm text-foreground">{customerQuestion || "—"}</p>
          </div>
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
