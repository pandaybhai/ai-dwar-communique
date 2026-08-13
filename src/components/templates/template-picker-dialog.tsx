import { useEffect, useMemo, useState } from "react";
import { Loader2, MessageSquareText } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  extractVariables,
  renderTemplate,
  templateBodyText,
  templateFooterText,
  type TemplateRow,
} from "@/lib/templates";

export type TemplateSendPayload = {
  template_name: string;
  template_language: string;
  template_components: Array<Record<string, unknown>>;
};

export function TemplatePickerDialog({
  open,
  onOpenChange,
  organizationId,
  sending,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string | null;
  sending: boolean;
  onSend: (payload: TemplateSendPayload) => Promise<boolean>;
}) {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!open || !organizationId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const { data } = await aidwar
        .from("message_templates")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("status", "APPROVED")
        .order("name");
      if (cancelled) return;
      setTemplates((data ?? []) as TemplateRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, organizationId]);

  const selected = templates.find((t) => t.id === selectedId) ?? null;
  const body = selected ? templateBodyText(selected.components) : "";
  const footer = selected ? templateFooterText(selected.components) : "";
  const variables = useMemo(() => extractVariables(body), [body]);
  const ready = Boolean(selected) && variables.every((v) => values[v]?.trim());

  const submit = async () => {
    if (!selected || !ready) return;
    const components = variables.length
      ? [
          {
            type: "body",
            parameters: variables.map((v) => ({ type: "text", text: values[v].trim() })),
          },
        ]
      : [];
    const ok = await onSend({
      template_name: selected.name,
      template_language: selected.language,
      template_components: components,
    });
    if (ok) {
      setSelectedId(null);
      setValues({});
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send a template</DialogTitle>
          <DialogDescription>
            Outside the 24-hour window only approved templates can be delivered.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
          </div>
        ) : templates.length === 0 ? (
          <div className="rounded-2xl border border-border/70 bg-muted/30 p-6 text-center">
            <MessageSquareText className="mx-auto h-7 w-7 text-muted-foreground/60" />
            <p className="mt-3 text-sm font-medium text-foreground">No approved templates yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create one in Templates and wait for Meta's approval.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(t.id);
                    setValues({});
                  }}
                  className={[
                    "w-full rounded-xl border px-4 py-3 text-left transition-colors duration-150",
                    selectedId === t.id
                      ? "border-primary bg-primary/5"
                      : "border-border/70 bg-card hover:bg-muted/50",
                  ].join(" ")}
                >
                  <p className="text-sm font-medium text-foreground">{t.name}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {templateBodyText(t.components)}
                  </p>
                </button>
              ))}
            </div>

            {selected ? (
              <div className="space-y-4">
                {variables.length ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {variables.map((v) => (
                      <div key={v}>
                        <Label htmlFor={`var-${v}`} className="text-xs">{`{{${v}}}`}</Label>
                        <Input
                          id={`var-${v}`}
                          value={values[v] ?? ""}
                          onChange={(e) =>
                            setValues((p) => ({ ...p, [v]: e.target.value }))
                          }
                          className="mt-1"
                        />
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="rounded-2xl bg-muted/40 p-3">
                  <div className="rounded-2xl rounded-br-md bg-primary/12 px-3.5 py-2.5 text-sm shadow-sm">
                    <p className="whitespace-pre-wrap break-words leading-relaxed">
                      {renderTemplate(body, values)}
                    </p>
                    {footer ? (
                      <p className="mt-2 text-[11px] text-muted-foreground">{footer}</p>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" className="rounded-full" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="rounded-full"
            disabled={!ready || sending}
            onClick={() => void submit()}
          >
            {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Send template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
