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
  buildTemplatePayloadComponents,
  extractVariables,
  renderTemplate,
  templateBodyText,
  templateFooterText,
  templateVariableSpec,
  type TemplateRow,
} from "@/lib/templates";
import { MediaUploader } from "@/components/templates/media-uploader";
import { toast } from "sonner";

export type TemplateSendPayload = {
  template_name: string;
  template_language: string;
  template_components: Array<Record<string, unknown>>;
};

export function TemplatePickerDialog({
  open,
  onOpenChange,
  organizationId,
  wabaId,
  sending,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string | null;
  /** Scope the library to the business account behind the sending number. */
  wabaId?: string | null;
  sending: boolean;
  onSend: (payload: TemplateSendPayload) => Promise<boolean>;
}) {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<number, string>>({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState<string | null>(null);
  const [cardMediaUrls, setCardMediaUrls] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!open || !organizationId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      let query = aidwar
        .from("message_templates")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("status", "APPROVED");
      if (wabaId) query = query.eq("waba_id", wabaId);
      const { data } = await query.order("name");
      if (cancelled) return;
      setTemplates((data ?? []) as TemplateRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, organizationId, wabaId]);


  const selected = templates.find((t) => t.id === selectedId) ?? null;
  const body = selected ? templateBodyText(selected.components) : "";
  const footer = selected ? templateFooterText(selected.components) : "";
  const variables = useMemo(() => extractVariables(body), [body]);
  const spec = useMemo(
    () => (selected ? templateVariableSpec(selected.components) : null),
    [selected],
  );
  const headerMediaFormat =
    spec?.headerMedia && spec.headerMedia.format !== "LOCATION" ? spec.headerMedia.format : null;
  const effectiveHeaderMedia = headerMediaUrl ?? spec?.headerMedia?.url ?? null;
  const effectiveCardMedia = (i: number) =>
    cardMediaUrls[i] ?? spec?.cards[i]?.mediaUrl ?? null;
  const mediaReady = Boolean(
    spec &&
      (!headerMediaFormat || effectiveHeaderMedia) &&
      spec.cards.every((_, i) => effectiveCardMedia(i)),
  );
  const ready =
    Boolean(selected) && variables.every((v) => values[v]?.trim()) && mediaReady;

  const submit = async () => {
    if (!selected || !ready || !spec) return;
    const built = buildTemplatePayloadComponents({
      spec,
      values: Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, v.trim()]),
      ),
      ...(effectiveHeaderMedia ? { headerMedia: { link: effectiveHeaderMedia } } : {}),
      ...(spec.cards.length
        ? {
            cards: spec.cards.map((_, i) => {
              const link = effectiveCardMedia(i);
              return link ? { media: { link } } : {};
            }),
          }
        : {}),
    });
    if (!built.components) {
      toast.error(built.error);
      return;
    }
    const ok = await onSend({
      template_name: selected.name,
      template_language: selected.language,
      template_components: built.components,
    });
    if (ok) {
      setSelectedId(null);
      setValues({});
      setHeaderMediaUrl(null);
      setCardMediaUrls({});
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
