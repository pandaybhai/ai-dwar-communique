import { useMemo, useState } from "react";
import { Info, Loader2, Plus, Trash2 } from "lucide-react";
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
    <section className="grid gap-3 rounded-2xl border border-border/70 p-4">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
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
  const [draft, setDraft] = useState<TemplateDraft>(emptyDraft());
  const [submitting, setSubmitting] = useState(false);

  const set = (patch: Partial<TemplateDraft>) => setDraft((d) => ({ ...d, ...patch }));
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
        <Button className="rounded-full">
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          Create template
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] gap-0 overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Create a template</DialogTitle>
          <DialogDescription>
            Templates are reviewed by Meta — usually within minutes, sometimes a few hours.
            Marketing templates may only be sent to people who opted in to hear from you.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="grid gap-4">
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
                  <Label>Category</Label>
                  <Select value={draft.category} onValueChange={(v) => set({ category: v })}>
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
                  <Select value={draft.language} onValueChange={(v) => set({ language: v })}>
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
                  <div className="flex items-center justify-between rounded-xl border border-border/70 px-3 py-2">
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
                  <Section title="Top of the message" hint="Optional — a line, a picture, a clip, a file or a map pin.">
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
                              : "border-border/70 hover:bg-muted/50"
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
                    <Textarea
                      id="tpl-body"
                      value={draft.body}
                      onChange={(e) => set({ body: e.target.value })}
                      rows={5}
                      placeholder={"Hi {{1}}, your order {{2}} is on its way!"}
                      className="mt-1.5 resize-none rounded-xl"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Use {"{{1}}"}, {"{{2}}"} for personalisation — each one needs an example.
                    </p>
                  </div>

                  {bodyVariables.length ? (
                    <div className="grid gap-3 rounded-xl bg-muted/30 p-3 sm:grid-cols-2">
                      {bodyVariables.map((v) => (
                        <div key={v}>
                          <Label htmlFor={`ex-${v}`} className="text-xs">{`{{${v}}}`}</Label>
                          <Input
                            id={`ex-${v}`}
                            value={draft.bodyExamples[v] ?? ""}
                            onChange={(e) =>
                              set({ bodyExamples: { ...draft.bodyExamples, [v]: e.target.value } })
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

                <Section title="Buttons" hint="Up to 10 quick replies, or a mix with at most one call button and two links.">
                  <ButtonEditor
                    idPrefix="btn"
                    buttons={draft.buttons}
                    onChange={(buttons) => set({ buttons })}
                  />
                </Section>

                {draft.category === "MARKETING" ? (
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
                    <div key={index} className="grid gap-3 rounded-xl border border-border/70 p-3">
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
                          <SelectTrigger className="h-8 w-28 text-xs" aria-label="Card media type">
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

          <aside className="lg:sticky lg:top-0 lg:self-start">
            <div className="rounded-2xl bg-muted/40 p-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                What your customer sees
              </p>
              <TemplatePreview model={preview} />
            </div>

            {problems.length > 0 ? (
              <div className="mt-3 grid gap-1 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                {problems.map((p) => (
                  <p key={p}>{p}</p>
                ))}
              </div>
            ) : null}

            <div className="mt-3 flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-3 text-xs">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <p>
                Keep it clear and specific. Templates that read like unsolicited promotion, or that
                go to people who never opted in, are commonly rejected or paused.
              </p>
            </div>
          </aside>
        </div>

        <DialogFooter className="mt-6">
          <Button variant="outline" className="rounded-full" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            className="rounded-full"
            onClick={() => void submit()}
            disabled={submitting || problems.length > 0}
          >
            {submitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            Submit for review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
