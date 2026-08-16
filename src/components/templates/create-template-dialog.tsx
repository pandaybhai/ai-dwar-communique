import { useMemo, useState } from "react";
import { Info, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { callApi } from "@/lib/whatsapp-client";
import {
  extractVariables,
  renderTemplate,
  slugifyTemplateName,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LANGUAGES,
} from "@/lib/templates";

export function CreateTemplateDialog({
  organizationId,
  whatsappAccountId,
  onCreated,
}: {
  organizationId: string;
  /** Templates are submitted into one number's business account. */
  whatsappAccountId?: string | null;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("MARKETING");
  const [language, setLanguage] = useState("en_US");
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("");
  const [examples, setExamples] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const slug = slugifyTemplateName(name);
  const variables = useMemo(() => extractVariables(body), [body]);
  const preview = renderTemplate(body || "Your message preview appears here.", examples);

  const reset = () => {
    setName("");
    setCategory("MARKETING");
    setLanguage("en_US");
    setBody("");
    setFooter("");
    setExamples({});
  };

  const submit = async () => {
    if (!slug) {
      toast.error("Give your template a name.");
      return;
    }
    if (!body.trim()) {
      toast.error("Add the body text of your message.");
      return;
    }
    if (variables.some((v, i) => v !== i + 1)) {
      toast.error("Number your variables in order, starting at {{1}}.");
      return;
    }
    if (variables.some((v) => !examples[v]?.trim())) {
      toast.error("Meta requires an example value for every variable.");
      return;
    }

    setSubmitting(true);
    const { error } = await callApi("/api/whatsapp/templates", {
      body: {
        action: "create",
        organization_id: organizationId,
        whatsapp_account_id: whatsappAccountId ?? null,
        name: slug,
        category,
        language,
        body: body.trim(),
        footer: footer.trim(),
        examples: variables.map((v) => examples[v] ?? ""),
      },
    });
    setSubmitting(false);

    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Template submitted to Meta for review.");
    reset();
    setOpen(false);
    onCreated();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button className="rounded-full">
          <Plus className="mr-2 h-4 w-4" />
          Create template
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] gap-0 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create a template</DialogTitle>
          <DialogDescription>
            Templates are reviewed by Meta — usually within minutes, sometimes a few hours.
            Marketing templates may only be sent to audiences who opted in to hear from you.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 grid gap-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-1">
              <Label htmlFor="tpl-name">Template name</Label>
              <Input
                id="tpl-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Order update"
                className="mt-1.5"
              />
              {slug ? (
                <p className="mt-1 truncate text-xs text-muted-foreground">Saved as {slug}</p>
              ) : null}
            </div>
            <div>
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Language</Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_LANGUAGES.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="tpl-body">Body</Label>
            <Textarea
              id="tpl-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder={"Hi {{1}}, your order {{2}} is on its way!"}
              className="mt-1.5 resize-none rounded-xl"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Use {"{{1}}"}, {"{{2}}"} for personalisation — each one needs an example value.
            </p>
          </div>

          {variables.length ? (
            <div className="grid gap-3 rounded-xl border border-border/70 bg-muted/30 p-4">
              <p className="text-xs font-medium text-foreground">Example values</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {variables.map((v) => (
                  <div key={v}>
                    <Label htmlFor={`ex-${v}`} className="text-xs">{`{{${v}}}`}</Label>
                    <Input
                      id={`ex-${v}`}
                      value={examples[v] ?? ""}
                      onChange={(e) => setExamples((p) => ({ ...p, [v]: e.target.value }))}
                      placeholder="Priya"
                      className="mt-1"
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <Label htmlFor="tpl-footer">Footer (optional)</Label>
            <Input
              id="tpl-footer"
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              placeholder="Reply STOP to opt out"
              className="mt-1.5"
            />
          </div>

          <div className="rounded-2xl bg-muted/40 p-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Preview</p>
            <div className="max-w-sm rounded-2xl rounded-bl-md border border-border/70 bg-card px-3.5 py-2.5 text-sm shadow-sm">
              <p className="whitespace-pre-wrap break-words leading-relaxed">{preview}</p>
              {footer ? (
                <p className="mt-2 text-[11px] text-muted-foreground">{footer}</p>
              ) : null}
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-xs text-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p>
              Keep it clear and specific. Templates that read like unsolicited promotion, or that
              are sent to contacts who never opted in, are commonly rejected or paused.
            </p>
          </div>
        </div>

        <DialogFooter className="mt-6">
          <Button variant="outline" className="rounded-full" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button className="rounded-full" onClick={() => void submit()} disabled={submitting}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Submit for review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
