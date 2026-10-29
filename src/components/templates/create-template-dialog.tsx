import { useMemo, useRef, useState } from "react";
import { Braces, FilePlus2, FileText, Info, Loader2, Plus, Trash2 } from "lucide-react";
import { useAppCommand } from "@/lib/app-commands";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  documentTemplateStarter,
  emptyDraft,
  extractVariables,
  HEADER_OPTIONS,
  MAX_CAROUSEL_CARDS,
  newCard,
  slugifyTemplateName,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LANGUAGES,
  validateDraft,
  type DraftCard,
  type HeaderFormat,
  type TemplateDraft,
} from "@/lib/templates";
import { ButtonEditor } from "@/components/templates/button-editor";
import { MediaUploader } from "@/components/templates/media-uploader";
import { draftToPreview, TemplatePreview } from "@/components/templates/template-preview";
import { FormatToolbar, useWhatsAppFormatting } from "@/components/templates/format-toolbar";
import { CustomerPhone } from "@/components/templates/customer-phone";
import { Kbd } from "@/components/ui/kbd";
import { usePageShortcut } from "@/hooks/use-page-shortcut";
import { useOrg } from "@/lib/org-context";
import { cn } from "@/lib/utils";

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-4 rounded-xl border border-border bg-card p-4 shadow-xs sm:p-5">
      <div>
        <h3 className="type-heading text-foreground">{title}</h3>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

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
  // Batch 39: "New template" in the command palette opens this dialog.
  useAppCommand("new-template", () => setOpen(true));
  // Batch 41: so does N on the Templates page.
  usePageShortcut("n", () => setOpen(true), !open);
  const { active } = useOrg();
  const [draft, setDraft] = useState<TemplateDraft>(emptyDraft());
  const [submitting, setSubmitting] = useState(false);

  const set = (patch: Partial<TemplateDraft>) => setDraft((d) => ({ ...d, ...patch }));
  // Batch 35: WhatsApp formatting on the body (toolbar + Ctrl/⌘+B, Ctrl/⌘+I).
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const bodyFormat = useWhatsAppFormatting(bodyRef, draft.body, (body) => set({ body }));
  const setCard = (index: number, patch: Partial<DraftCard>) =>
    setDraft((d) => ({
      ...d,
      cards: d.cards.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));

  const slug = slugifyTemplateName(draft.name);
  const isAuth = draft.category === "AUTHENTICATION";
  const isCarousel = draft.cards.length > 0;
  const bodyVariables = useMemo(() => extractVariables(draft.body), [draft.body]);
  const headerVariables = useMemo(() => extractVariables(draft.headerText), [draft.headerText]);
  const problems = useMemo(() => validateDraft(draft), [draft]);
  const preview = useMemo(() => draftToPreview(draft), [draft]);

  const reset = () => setDraft(emptyDraft());

  /** Batch 41: put the next {{n}} where the cursor is. */
  const insertVariable = () => {
    const next = (bodyVariables.length ? Math.max(...bodyVariables) : 0) + 1;
    const el = bodyRef.current;
    const at = el?.selectionStart ?? draft.body.length;
    const end = el?.selectionEnd ?? at;
    const token = `{{${next}}}`;
    set({ body: draft.body.slice(0, at) + token + draft.body.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const submit = async () => {
    if (problems.length > 0) {
      toast.error(problems[0] as string);
      return;
    }
    setSubmitting(true);
    const { error } = await callApi("/api/whatsapp/templates", {
      body: {
        action: "create",
        organization_id: organizationId,
        whatsapp_account_id: whatsappAccountId ?? null,
        draft: { ...draft, name: slug },
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
        <Button aria-keyshortcuts="N">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Create template
          <Kbd className="ml-1 hidden border-primary-foreground/25 bg-primary-foreground/15 text-primary-foreground shadow-none sm:inline-flex">
            N
          </Kbd>
        </Button>
      </DialogTrigger>
      {/* Batch 41: a full-screen split view — the form, and the customer's phone beside it. */}
      <DialogContent className="left-0 top-0 flex h-[100dvh] max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 sm:max-w-none sm:rounded-none">
        <DialogHeader className="shrink-0 border-b border-border bg-card px-4 py-3 pr-14 text-left sm:px-6">
          <div className="mx-auto w-full max-w-6xl space-y-0.5">
            <DialogTitle className="text-base">Create a template</DialogTitle>
            <DialogDescription className="text-xs">
              Templates are reviewed by Meta — usually within minutes, sometimes a few hours.
              Marketing templates may only be sent to people who opted in to hear from you.
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto bg-background">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_336px] lg:gap-12 lg:py-8">
            <div className="grid min-w-0 content-start gap-4">
              <section aria-labelledby="tpl-start" className="grid gap-2">
                <h3 id="tpl-start" className="text-sm font-medium text-muted-foreground">
                  Start from:
                </h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  <StarterCard
                    icon={FilePlus2}
                    title="A blank template"
                    detail="Write your own words, buttons and media."
                    onClick={reset}
                  />
                  <StarterCard
                    icon={FileText}
                    tone="pdf"
                    title="Invoice or receipt with a PDF"
                    detail="A utility message with the file at the top."
                    onClick={() => setDraft(documentTemplateStarter())}
                  />
                </div>
                {draft.headerFormat === "DOCUMENT" && !draft.headerHandle ? (
                  <span className="text-xs text-muted-foreground">
                    Edit the words, then upload a sample PDF below — Meta reviews it with the
                    template.
                  </span>
                ) : null}
              </section>

              <Section title="The basics">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <Label htmlFor="tpl-name">Template name</Label>
                    <Input
                      id="tpl-name"
                      value={draft.name}
                      onChange={(e) => set({ name: e.target.value })}
                      placeholder="Order update"
                      className="mt-1.5"
                    />
                    {slug ? (
                      <p className="mt-1 truncate text-xs text-muted-foreground">Saved as {slug}</p>
                    ) : null}
                  </div>
                  <div>
                    <Label htmlFor="tpl-category">Category</Label>
                    <Select value={draft.category} onValueChange={(v) => set({ category: v })}>
                      <SelectTrigger id="tpl-category" className="mt-1.5">
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
                    <Label htmlFor="tpl-language">Language</Label>
                    <Select value={draft.language} onValueChange={(v) => set({ language: v })}>
                      <SelectTrigger id="tpl-language" className="mt-1.5">
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
              </Section>

              {isAuth ? (
                <Section
                  title="One-time code"
                  hint="Meta writes the wording for verification codes. You choose how long the code lasts."
                >
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="tpl-expiry">Code stays valid for (minutes)</Label>
                      <Input
                        id="tpl-expiry"
                        type="number"
                        min={1}
                        max={90}
                        value={draft.codeExpirationMinutes}
                        onChange={(e) => set({ codeExpirationMinutes: Number(e.target.value) })}
                        className="mt-1.5"
                      />
                    </div>
                    <div className="flex items-center justify-between rounded-xl border border-border px-3 py-2">
                      <Label htmlFor="tpl-security" className="text-sm font-normal">
                        Add "don't share this code" warning
                      </Label>
                      <Switch
                        id="tpl-security"
                        checked={draft.addSecurityRecommendation}
                        onCheckedChange={(v) => set({ addSecurityRecommendation: v })}
                      />
                    </div>
                  </div>
                  <ButtonEditor
                    idPrefix="otp"
                    buttons={draft.buttons}
                    onChange={(buttons) => set({ buttons })}
                  />
                  {draft.buttons.length === 0 ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-fit rounded-full"
                      onClick={() =>
                        set({
                          buttons: [{ type: "OTP", text: "Copy code", otp_type: "COPY_CODE" }],
                        })
                      }
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                      Add the copy-code button
                    </Button>
                  ) : null}
                </Section>
              ) : (
                <>
                  {!isCarousel ? (
                    <Section
                      title="Top of the message"
                      hint="Optional — a line, a picture, a clip, a file or a map pin."
                    >
                      <div className="grid gap-2 sm:grid-cols-3">
                        {HEADER_OPTIONS.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => set({ headerFormat: option.value as HeaderFormat })}
                            aria-pressed={draft.headerFormat === option.value}
                            className={`rounded-xl border p-3 text-left transition-colors duration-150 ${
                              draft.headerFormat === option.value
                                ? "border-primary bg-primary/5"
                                : "border-border hover:bg-muted/50"
                            }`}
                          >
                            <span className="block text-sm font-medium">{option.label}</span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {option.blurb}
                            </span>
                          </button>
                        ))}
                      </div>

                      {draft.headerFormat === "TEXT" ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <Label htmlFor="tpl-header-text">Header text</Label>
                            <Input
                              id="tpl-header-text"
                              value={draft.headerText}
                              maxLength={60}
                              onChange={(e) => set({ headerText: e.target.value })}
                              className="mt-1.5"
                            />
                          </div>
                          {headerVariables.length > 0 ? (
                            <div>
                              <Label htmlFor="tpl-header-ex">Example for {"{{1}}"}</Label>
                              <Input
                                id="tpl-header-ex"
                                value={draft.headerExample}
                                onChange={(e) => set({ headerExample: e.target.value })}
                                className="mt-1.5"
                              />
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {draft.headerFormat === "IMAGE" ||
                      draft.headerFormat === "VIDEO" ||
                      draft.headerFormat === "DOCUMENT" ? (
                        <MediaUploader
                          organizationId={organizationId}
                          whatsappAccountId={whatsappAccountId ?? null}
                          slot="header"
                          format={draft.headerFormat}
                          fileName={draft.headerFileName}
                          mediaUrl={draft.headerMediaUrl}
                          onUploaded={(r) =>
                            set({
                              headerHandle: r.handle,
                              headerMediaUrl: r.media_url,
                              headerFileName: r.file_name,
                            })
                          }
                          onCleared={() =>
                            set({ headerHandle: "", headerMediaUrl: "", headerFileName: "" })
                          }
                        />
                      ) : null}
                    </Section>
                  ) : null}

                  <Section title="Message">
                    <div>
                      <Label htmlFor="tpl-body">Body</Label>
                      <div className="mt-1.5 overflow-hidden rounded-lg border border-input bg-card shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-subtle px-1.5 py-1">
                          <FormatToolbar onApply={bodyFormat.apply} label="Body text style" />
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={insertVariable}
                          >
                            <Braces className="h-3.5 w-3.5" aria-hidden="true" />
                            Add variable
                          </Button>
                        </div>
                        <Textarea
                          id="tpl-body"
                          ref={bodyRef}
                          value={draft.body}
                          onKeyDown={bodyFormat.onKeyDown}
                          onChange={(e) => set({ body: e.target.value })}
                          rows={6}
                          placeholder={"Hi {{1}}, your order {{2}} is on its way!"}
                          aria-invalid={draft.body.length > 1024}
                          className="resize-none rounded-none border-0 shadow-none focus-visible:ring-0"
                        />
                        <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
                          <span className="flex min-w-0 flex-wrap items-center gap-1">
                            {bodyVariables.length ? (
                              bodyVariables.map((v) => (
                                <span
                                  key={v}
                                  className="rounded-md border border-info-border bg-info-soft px-1.5 py-px font-mono text-[0.6875rem] text-info-soft-foreground"
                                >
                                  {`{{${v}}}`}
                                </span>
                              ))
                            ) : (
                              <span>No variables yet</span>
                            )}
                          </span>
                          <span
                            className={cn(
                              "tabular shrink-0",
                              draft.body.length > 1024 && "font-medium text-danger-soft-foreground",
                            )}
                          >
                            {draft.body.length}/1024
                          </span>
                        </div>
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        Use {"{{1}}"}, {"{{2}}"} for personalisation — each one needs an example.
                        Select text and use the buttons for *bold*, _italic_, ~strikethrough~ and
                        lists, as WhatsApp shows them.
                      </p>
                    </div>

                    {bodyVariables.length ? (
                      <div className="grid gap-3 rounded-xl border border-border bg-subtle p-3 sm:grid-cols-2">
                        {bodyVariables.map((v) => (
                          <div key={v}>
                            <Label
                              htmlFor={`ex-${v}`}
                              className="flex items-center gap-1.5 text-xs"
                            >
                              Example for
                              <span className="rounded-md border border-info-border bg-info-soft px-1.5 py-px font-mono text-[0.6875rem] text-info-soft-foreground">{`{{${v}}}`}</span>
                            </Label>
                            <Input
                              id={`ex-${v}`}
                              value={draft.bodyExamples[v] ?? ""}
                              onChange={(e) =>
                                set({
                                  bodyExamples: { ...draft.bodyExamples, [v]: e.target.value },
                                })
                              }
                              placeholder="Priya"
                              className="mt-1"
                            />
                          </div>
                        ))}
                      </div>
                    ) : null}

                    <div>
                      <Label htmlFor="tpl-footer">Footer (optional)</Label>
                      <Input
                        id="tpl-footer"
                        value={draft.footer}
                        maxLength={60}
                        onChange={(e) => set({ footer: e.target.value })}
                        placeholder="Reply STOP to opt out"
                        className="mt-1.5"
                      />
                    </div>
                  </Section>

                  {!isCarousel ? (
                    <Section
                      title="Buttons"
                      hint="Up to 10 quick replies, or a mix with at most one call button and two links."
                    >
                      <ButtonEditor
                        idPrefix="btn"
                        buttons={draft.buttons}
                        onChange={(buttons) => set({ buttons })}
                      />
                    </Section>
                  ) : null}

                  {draft.category === "MARKETING" && !isCarousel ? (
                    <Section
                      title="Limited-time offer"
                      hint="Shows a countdown in the chat — good for a discount that expires."
                    >
                      <div className="flex items-center justify-between">
                        <Label htmlFor="tpl-offer" className="text-sm font-normal">
                          Add a countdown
                        </Label>
                        <Switch
                          id="tpl-offer"
                          checked={draft.offerEnabled}
                          onCheckedChange={(v) => set({ offerEnabled: v })}
                        />
                      </div>
                      {draft.offerEnabled ? (
                        <div>
                          <Label htmlFor="tpl-offer-text">Offer text</Label>
                          <Input
                            id="tpl-offer-text"
                            value={draft.offerText}
                            maxLength={16}
                            onChange={(e) => set({ offerText: e.target.value })}
                            placeholder="20% off today"
                            className="mt-1.5"
                          />
                        </div>
                      ) : null}
                    </Section>
                  ) : null}

                  <Section
                    title="Carousel"
                    hint="Up to 10 swipeable cards, each with its own picture, text and buttons. Best for showing products."
                  >
                    {draft.cards.map((card, index) => (
                      <div key={index} className="grid gap-3 rounded-xl border border-border p-3">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">Card {index + 1}</p>
                          <div className="flex-1" />
                          <Select
                            value={card.format}
                            onValueChange={(v) =>
                              setCard(index, {
                                format: v as "IMAGE" | "VIDEO",
                                mediaHandle: "",
                                mediaUrl: "",
                              })
                            }
                          >
                            <SelectTrigger
                              className="h-8 w-28 text-xs"
                              aria-label="Card media type"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="IMAGE">Image</SelectItem>
                              <SelectItem value="VIDEO">Video</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-full"
                            aria-label={`Remove card ${index + 1}`}
                            onClick={() =>
                              set({ cards: draft.cards.filter((_, i) => i !== index) })
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        </div>

                        <MediaUploader
                          organizationId={organizationId}
                          whatsappAccountId={whatsappAccountId ?? null}
                          slot={`card:${index}`}
                          format={card.format}
                          fileName=""
                          mediaUrl={card.mediaUrl}
                          onUploaded={(r) =>
                            setCard(index, { mediaHandle: r.handle, mediaUrl: r.media_url })
                          }
                          onCleared={() => setCard(index, { mediaHandle: "", mediaUrl: "" })}
                        />

                        <div>
                          <Label htmlFor={`card-body-${index}`} className="text-xs">
                            Card text
                          </Label>
                          <Textarea
                            id={`card-body-${index}`}
                            value={card.body}
                            rows={2}
                            onChange={(e) => setCard(index, { body: e.target.value })}
                            className="mt-1 resize-none rounded-xl"
                          />
                        </div>

                        {extractVariables(card.body).map((v) => (
                          <div key={v}>
                            <Label htmlFor={`card-${index}-ex-${v}`} className="text-xs">
                              {`Example for {{${v}}}`}
                            </Label>
                            <Input
                              id={`card-${index}-ex-${v}`}
                              value={card.bodyExamples[v] ?? ""}
                              onChange={(e) =>
                                setCard(index, {
                                  bodyExamples: { ...card.bodyExamples, [v]: e.target.value },
                                })
                              }
                              className="mt-1"
                            />
                          </div>
                        ))}

                        <ButtonEditor
                          idPrefix={`card-${index}`}
                          context="card"
                          buttons={card.buttons}
                          onChange={(buttons) => setCard(index, { buttons })}
                        />
                      </div>
                    ))}

                    {draft.cards.length < MAX_CAROUSEL_CARDS ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-fit rounded-full"
                        onClick={() => set({ cards: [...draft.cards, newCard()] })}
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                        Add a card
                      </Button>
                    ) : null}
                  </Section>
                </>
              )}
            </div>

            <aside className="space-y-4 self-start lg:sticky lg:top-0" aria-label="Preview">
              <div>
                <CustomerPhone business={active?.organization.name ?? "Your business"}>
                  <TemplatePreview model={preview} />
                </CustomerPhone>
                <p className="mt-3 text-center text-xs text-muted-foreground">
                  What your customer sees
                </p>
              </div>

              {problems.length > 0 ? (
                <div
                  role="status"
                  className="grid gap-1 rounded-xl border border-danger-border bg-danger-soft p-3 text-xs text-danger-soft-foreground"
                >
                  {problems.map((p) => (
                    <p key={p}>{p}</p>
                  ))}
                </div>
              ) : null}

              <div className="flex items-start gap-2 rounded-xl border border-info-border bg-info-soft px-3 py-3 text-xs text-info-soft-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>
                  Keep it clear and specific. Templates that read like unsolicited promotion, or
                  that go to people who never opted in, are commonly rejected or paused.
                </p>
              </div>
            </aside>
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border bg-card px-4 py-3 sm:px-6">
          <div className="mx-auto flex w-full max-w-6xl flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
            <p className="hidden flex-1 text-xs text-muted-foreground sm:block" aria-live="polite">
              {problems.length > 0
                ? `${problems.length} thing${problems.length === 1 ? "" : "s"} to fix before you submit`
                : "Ready to submit"}
            </p>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={submitting || problems.length > 0}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Submit for review
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Batch 41: a starter as a card, with a hint of what it makes. */
function StarterCard({
  icon: Icon,
  title,
  detail,
  tone,
  onClick,
}: {
  icon: typeof FileText;
  title: string;
  detail: string;
  tone?: "pdf";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-start gap-3 rounded-xl border border-border bg-card p-3.5 text-left shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-md"
    >
      <span
        className={cn(
          "flex h-10 w-9 shrink-0 items-center justify-center rounded-md",
          tone === "pdf"
            ? "bg-danger-soft text-danger-soft-foreground"
            : "bg-primary/10 text-primary",
        )}
        aria-hidden="true"
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}
