import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,

  ArrowRight,
  CalendarClock,
  Check,
  Loader2,
  Rocket,
  Send,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import {
  VARIABLE_SOURCE_LABELS,
  mappingIsComplete,
  resolveVariable,
  type SampleContact,
  type VariableMapping,
  type VariableMappings,
  type VariableSource,
} from "@/lib/campaigns";
import {
  extractVariables,
  isMediaHeader,
  renderTemplate,
  templateBodyText,
  templateCards,
  templateFooterText,
  templateHeader,
  templateOffer,
  templateVariableSpec,
  type TemplateRow,
} from "@/lib/templates";
import { MediaUploader } from "@/components/templates/media-uploader";
import {
  TemplatePreview,
  componentsToPreview,
} from "@/components/templates/template-preview";
import {
  formatInZone,
  offerTimingIssue,
  zonedToUtcIso,
} from "@/lib/offers";

import type { SegmentRow } from "@/lib/segments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useWhatsAppNumbers } from "@/hooks/use-whatsapp-numbers";
import { numberLabel, numberSubtitle } from "@/lib/whatsapp-numbers";


type AudienceSummary = {
  matched: number;
  eligible: number;
  excluded: number;
  sample: SampleContact | null;
};

const STEPS = ["Name", "Audience", "Message", "Schedule", "Review"] as const;

const FALLBACK_SAMPLE: SampleContact = {
  name: "Priya",
  phone: "+919876543210",
  attributes: {},
};

function StepDots({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <div
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold transition-all duration-200",
              i < step
                ? "bg-primary text-primary-foreground"
                : i === step
                  ? "bg-primary/15 text-primary ring-2 ring-primary/30"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
          </div>
          <span
            className={cn(
              "hidden text-xs sm:inline",
              i === step ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
          {i < STEPS.length - 1 && <span className="h-px w-4 bg-border" />}
        </div>
      ))}
    </div>
  );
}

function ChatPreview({
  body,
  footer,
  imageUrl,
  mediaLabel,
}: {
  body: string;
  footer: string;
  imageUrl?: string | undefined;
  mediaLabel?: string | undefined;
}) {
  return (
    <div className="rounded-2xl bg-[#ECE5DD] p-4 dark:bg-muted">
      <div className="ml-auto max-w-[85%] overflow-hidden rounded-2xl rounded-tr-sm bg-[#DCF8C6] text-sm text-[#111B21] shadow-sm dark:bg-primary/20 dark:text-foreground">
        {imageUrl ? (
          <img src={imageUrl} alt="Template header" className="max-h-48 w-full object-cover" />
        ) : mediaLabel ? (
          <div className="flex h-24 items-center justify-center bg-black/10 text-xs opacity-70 dark:bg-black/20">
            {mediaLabel}
          </div>
        ) : null}
        <div className="px-3.5 py-2.5">
          <p className="whitespace-pre-wrap leading-relaxed">{body || "Your message preview"}</p>
          {footer ? <p className="mt-2 text-[11px] opacity-60">{footer}</p> : null}
          <p className="mt-1 text-right text-[10px] opacity-50">now</p>
        </div>
      </div>
    </div>
  );
}

export function CampaignWizard({
  open,
  onOpenChange,
  organizationId,
  timezone,
  onLaunched,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  organizationId: string;
  timezone: string;
  onLaunched: (campaignId: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [segmentId, setSegmentId] = useState<string>("all");
  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [attributeKeys, setAttributeKeys] = useState<string[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [mappings, setMappings] = useState<VariableMappings>({});
  const [audience, setAudience] = useState<AudienceSummary | null>(null);
  const [audienceLoading, setAudienceLoading] = useState(false);
  const [sendNow, setSendNow] = useState(true);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [launching, setLaunching] = useState(false);
  const [loadingLists, setLoadingLists] = useState(true);
  // Media this campaign sends: the header picture/clip/file, and one per
  // carousel card. Blank means "use the file the template was built with".
  const [headerMedia, setHeaderMedia] = useState<{ url: string; fileName: string }>({
    url: "",
    fileName: "",
  });
  const [cardMedia, setCardMedia] = useState<Record<number, string>>({});
  // Offer details: the coupon a copy-code button copies, and when a
  // limited-time offer's countdown runs out.
  const [couponCode, setCouponCode] = useState("");
  // A carousel can run a different discount on every card, so each card with a
  // copy-code button keeps its own code. Blank means "use the main code".
  const [cardCoupons, setCardCoupons] = useState<Record<number, string>>({});
  const [offerDate, setOfferDate] = useState("");
  const [offerTime, setOfferTime] = useState("");

  // A campaign always sends from one number. Default is the workspace default.
  const { numbers, defaultNumber, multiple } = useWhatsAppNumbers();
  const [accountId, setAccountId] = useState<string>("");
  const senderNumber = numbers.find((n) => n.id === accountId) ?? null;

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setName("");
    setSegmentId("all");
    setTemplateName("");
    setMappings({});
    setAudience(null);
    setSendNow(true);
    setDate("");
    setTime("");
    setHeaderMedia({ url: "", fileName: "" });
    setCardMedia({});
    setCouponCode("");
    setCardCoupons({});
    setOfferDate("");
    setOfferTime("");
  }, [open]);

  // A different template means different slots — start its media clean.
  useEffect(() => {
    setHeaderMedia({ url: "", fileName: "" });
    setCardMedia({});
    setCouponCode("");
    setCardCoupons({});
    setOfferDate("");
    setOfferTime("");
  }, [templateName]);

  useEffect(() => {
    if (!open) return;
    if (!accountId && defaultNumber) setAccountId(defaultNumber.id);
  }, [open, accountId, defaultNumber]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setLoadingLists(true);
      const wabaId = senderNumber?.waba_id ?? null;
      const templateQuery = aidwar
        .from("message_templates")
        .select(
          "id, organization_id, waba_id, meta_template_id, name, language, category, status, components, rejection_reason, created_at, updated_at",
        )
        .eq("organization_id", organizationId)
        .eq("status", "APPROVED")
        .order("name", { ascending: true });
      // Templates live inside a WABA — only this number's library is offered.
      const [seg, tpl, contacts] = await Promise.all([
        aidwar
          .from("segments")
          .select("id, name, description, filters, created_by, created_at")
          .eq("organization_id", organizationId)
          .order("created_at", { ascending: false }),
        wabaId ? templateQuery.eq("waba_id", wabaId) : Promise.resolve({ data: [] as unknown[] }),
        aidwar
          .from("contacts")
          .select("attributes")
          .eq("organization_id", organizationId)
          .not("attributes", "eq", "{}")
          .limit(200),
      ]);
      if (cancelled) return;
      setSegments((seg.data ?? []) as SegmentRow[]);
      const rows = (tpl.data ?? []) as TemplateRow[];
      setTemplates(rows);
      // Switching numbers can strand a template that doesn't exist on the new
      // WABA — clear it now instead of failing at send time.
      setTemplateName((current) => (rows.some((t) => t.name === current) ? current : ""));
      const keys = new Set<string>();
      for (const row of (contacts.data ?? []) as { attributes: Record<string, unknown> | null }[]) {
        for (const k of Object.keys(row.attributes ?? {})) keys.add(k);
      }
      setAttributeKeys(Array.from(keys).sort());
      setLoadingLists(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, organizationId, senderNumber?.waba_id]);

  const loadAudience = useCallback(async () => {
    setAudienceLoading(true);
    const { data } = await callApi<AudienceSummary>("/api/campaigns/audience", {
      body: {
        organization_id: organizationId,
        segment_id: segmentId === "all" ? null : segmentId,
        whatsapp_account_id: accountId || null,
      },
    });
    setAudience(data);
    setAudienceLoading(false);
  }, [organizationId, segmentId, accountId]);

  useEffect(() => {
    if (!open || step !== 1) return;
    const t = setTimeout(() => void loadAudience(), 150);
    return () => clearTimeout(t);
  }, [open, step, loadAudience]);


  const template = useMemo(
    () => templates.find((t) => t.name === templateName) ?? null,
    [templates, templateName],
  );
  const bodyText = templateBodyText(template?.components);
  const footerText = templateFooterText(template?.components);
  const variables = useMemo(() => extractVariables(bodyText), [bodyText]);
  const sample = audience?.sample ?? FALLBACK_SAMPLE;

  const header = useMemo(() => templateHeader(template?.components), [template]);
  const cards = useMemo(() => templateCards(template?.components), [template]);
  const needsHeaderMedia = Boolean(header && isMediaHeader(header.format));
  const headerMediaFormat = (header?.format ?? "IMAGE") as "IMAGE" | "VIDEO" | "DOCUMENT";
  /** What actually goes out for each slot: this campaign's file, else the template's. */
  const effectiveHeaderMedia = headerMedia.url || header?.mediaUrl || "";
  const effectiveCardMedia = (index: number) =>
    cardMedia[index] || cards[index]?.mediaUrl || "";
  const mediaReady =
    (!needsHeaderMedia || Boolean(effectiveHeaderMedia)) &&
    cards.every((_, i) => Boolean(effectiveCardMedia(i)));

  // Offers: a copy-code button needs a coupon, and a limited-time offer with a
  // countdown needs the moment it expires.
  const spec = useMemo(() => templateVariableSpec(template?.components), [template]);
  const offer = useMemo(() => templateOffer(template?.components), [template]);
  /** Copy-code buttons on the message itself (outside any carousel). */
  const needsMainCoupon = spec.copyCodeButtons.length > 0;
  /** Cards that copy a code — each can run its own discount. */
  const couponCards = useMemo(
    () => spec.cards.filter((c) => c.copyCodeButtons.length > 0),
    [spec],
  );
  const needsCoupon = needsMainCoupon || couponCards.length > 0;
  /** The code a given card actually sends: its own, else the main one. */
  const effectiveCardCoupon = (index: number) =>
    (cardCoupons[index] ?? "").trim() || couponCode.trim();
  const couponsReady =
    (!needsMainCoupon || couponCode.trim().length > 0) &&
    couponCards.every((c) => effectiveCardCoupon(c.index).length > 0);
  const needsOfferExpiry = spec.offerExpiration;
  const offerExpiresAt = useMemo(() => {
    if (!needsOfferExpiry || !offerDate) return null;
    return zonedToUtcIso(offerDate, offerTime || "23:59", timezone);
  }, [needsOfferExpiry, offerDate, offerTime, timezone]);
  const offerReady = couponsReady && (!needsOfferExpiry || Boolean(offerExpiresAt));


  const previewValues = useMemo(() => {
    const out: Record<number, string> = {};
    for (const n of variables) out[n] = resolveVariable(mappings[String(n)], sample);
    return out;
  }, [variables, mappings, sample]);

  const setMapping = (n: number, patch: Partial<VariableMapping>) =>
    setMappings((prev) => ({
      ...prev,
      [String(n)]: { source: "name", ...prev[String(n)], ...patch } as VariableMapping,
    }));

  const scheduledAt = useMemo(() => {
    if (sendNow || !date) return null;
    // The time the merchant typed is wall-clock time in the workspace
    // timezone, not the timezone of the device they're on.
    return zonedToUtcIso(date, time || "09:00", timezone);
  }, [sendNow, date, time, timezone]);

  // Does the offer end at a moment that still makes sense once it lands?
  const offerIssue = useMemo(
    () => offerTimingIssue({ expiresAt: offerExpiresAt, sendAt: scheduledAt, timeZone: timezone }),
    [offerExpiresAt, scheduledAt, timezone],
  );

  /** Exactly what the customer sees, coupon and countdown included. */
  const previewModel = useMemo(() => {
    const model = componentsToPreview(template?.components, previewValues);
    return {
      ...model,
      header: model.header
        ? {
            ...model.header,
            mediaUrl:
              needsHeaderMedia && effectiveHeaderMedia
                ? effectiveHeaderMedia
                : model.header.mediaUrl,
          }
        : null,
      cards: model.cards.map((card, i) => ({
        ...card,
        mediaUrl: effectiveCardMedia(i) || card.mediaUrl,
        couponCode: effectiveCardCoupon(i) || null,
      })),
      offer: model.offer ? { ...model.offer, expiresAt: offerExpiresAt } : null,
      couponCode: couponCode.trim() || null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    template,
    previewValues,
    needsHeaderMedia,
    effectiveHeaderMedia,
    cardMedia,
    offerExpiresAt,
    couponCode,
    cardCoupons,
  ]);

  const canNext = () => {
    if (step === 0) return name.trim().length >= 2;
    if (step === 1) return Boolean(accountId) && (audience?.eligible ?? 0) > 0;
    if (step === 2)
      return (
        Boolean(template) &&
        mediaReady &&
        offerReady &&
        offerIssue?.level !== "error" &&
        variables.every((n) => mappingIsComplete(mappings[String(n)]))
      );
    if (step === 3) return (sendNow || Boolean(scheduledAt)) && offerIssue?.level !== "error";
    return true;
  };


  const launch = async () => {
    setLaunching(true);
    const { data, error } = await callApi<{ campaign_id: string }>("/api/campaigns/launch", {
      body: {
        organization_id: organizationId,
        name: name.trim(),
        template_name: templateName,
        segment_id: segmentId === "all" ? null : segmentId,
        variable_mappings: mappings,
        scheduled_at: scheduledAt,
        whatsapp_account_id: accountId || null,
        send_settings: {
          ...(needsHeaderMedia && headerMedia.url ? { header_media_url: headerMedia.url } : {}),
          ...(cards.length
            ? {
                cards: cards.map((_, i) => ({
                  media_url: cardMedia[i] ?? null,
                  coupon_code: effectiveCardCoupon(i) || null,
                })),
              }
            : {}),
          ...(needsCoupon && couponCode.trim() ? { coupon_code: couponCode.trim() } : {}),
          ...(offerExpiresAt ? { offer_expires_at: offerExpiresAt } : {}),
        },
      },
    });

    setLaunching(false);
    if (error || !data) {
      toast.error(error ?? "We couldn't launch this campaign.");
      return;
    }
    toast.success(sendNow ? "Campaign launched — sending now." : "Campaign scheduled.");
    onOpenChange(false);
    onLaunched(data.campaign_id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create campaign</DialogTitle>
          <DialogDescription>
            Five quick steps — we&apos;ll show you exactly who receives what before anything sends.
          </DialogDescription>
        </DialogHeader>

        <div className="pb-2">
          <StepDots step={step} />
        </div>

        {loadingLists ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        ) : (
          <div className="space-y-5">
            {step === 0 && (
              <div className="space-y-2">
                <Label htmlFor="campaign-name">Campaign name</Label>
                <Input
                  id="campaign-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Diwali offer — VIP customers"
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Only your team sees this. Customers never see the campaign name.
                </p>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-4">
                {multiple ? (
                  <div className="space-y-2">
                    <Label>Send from</Label>
                    <Select value={accountId} onValueChange={setAccountId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Pick a number" />
                      </SelectTrigger>
                      <SelectContent>
                        {numbers.map((n) => (
                          <SelectItem key={n.id} value={n.id}>
                            {numberLabel(n)}
                            {numberSubtitle(n) ? ` · ${numberSubtitle(n)}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Templates and delivery are tied to this number. Opt-outs always apply across
                      the whole workspace.
                    </p>
                  </div>
                ) : null}
                <div className="space-y-2">
                  <Label>Who should receive this?</Label>
                  <Select value={segmentId} onValueChange={setSegmentId}>

                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All opted-in contacts</SelectItem>
                      {segments.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
                  {audienceLoading || !audience ? (
                    <div className="space-y-2">
                      <Skeleton className="h-7 w-28 rounded" />
                      <Skeleton className="h-4 w-52 rounded" />
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 text-primary">
                        <Users className="h-4 w-4" />
                        <span className="text-2xl font-semibold tabular-nums">
                          {audience.eligible}
                        </span>
                        <span className="text-sm text-muted-foreground">will receive it</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {audience.matched} matched · {audience.excluded} excluded (not opted in)
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Approved template</Label>
                  <Select value={templateName} onValueChange={setTemplateName}>
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a template" />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.name}>
                          {t.name} · {t.language}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {templates.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      You don&apos;t have an approved template yet. Create one under Templates first.
                    </p>
                  )}
                </div>

                {needsHeaderMedia && (
                  <div className="space-y-2 rounded-xl border border-border/70 bg-muted/30 p-3">
                    <Label className="text-xs">
                      {headerMediaFormat === "IMAGE"
                        ? "Picture at the top"
                        : headerMediaFormat === "VIDEO"
                          ? "Clip at the top"
                          : "File at the top"}
                    </Label>
                    <MediaUploader
                      organizationId={organizationId}
                      whatsappAccountId={accountId || null}
                      slot="campaign-header"
                      format={headerMediaFormat}
                      fileName={headerMedia.fileName}
                      mediaUrl={effectiveHeaderMedia}
                      onUploaded={(r) =>
                        setHeaderMedia({ url: r.media_url, fileName: r.file_name })
                      }
                      onCleared={() => setHeaderMedia({ url: "", fileName: "" })}
                    />
                    <p className="text-xs text-muted-foreground">
                      {headerMedia.url
                        ? "This campaign sends the file you just uploaded."
                        : header?.mediaUrl
                          ? "Using the file this template was built with — upload another to replace it for this campaign."
                          : "This template needs a file. Upload one before you continue."}
                    </p>
                  </div>
                )}

                {cards.length > 0 && (
                  <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-3">
                    <Label className="text-xs">Carousel cards</Label>
                    {cards.map((card, i) => (
                      <div key={i} className="space-y-1.5">
                        <p className="text-xs font-medium">
                          Card {i + 1}
                          {card.body ? ` · ${card.body.slice(0, 40)}` : ""}
                        </p>
                        <MediaUploader
                          organizationId={organizationId}
                          whatsappAccountId={accountId || null}
                          slot={`campaign-card:${i}`}
                          format={card.format}
                          fileName=""
                          mediaUrl={effectiveCardMedia(i)}
                          onUploaded={(r) =>
                            setCardMedia((prev) => ({ ...prev, [i]: r.media_url }))
                          }
                          onCleared={() =>
                            setCardMedia((prev) => ({ ...prev, [i]: "" }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}

                {(needsCoupon || needsOfferExpiry) && (
                  <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-3">
                    <Label className="text-xs">
                      {offer ? offer.text : "Offer details"}
                    </Label>
                    {needsCoupon && (
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Coupon code</Label>
                        <Input
                          value={couponCode}
                          onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                          placeholder="SAVE20"
                          maxLength={15}
                        />
                        <p className="text-xs text-muted-foreground">
                          This is the code customers copy with one tap. Everyone in this
                          campaign gets the same code.
                        </p>
                      </div>
                    )}
                    {needsOfferExpiry && (
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">
                          Offer ends ({timezone})
                        </Label>
                        <div className="flex gap-2">
                          <Input
                            type="date"
                            value={offerDate}
                            onChange={(e) => setOfferDate(e.target.value)}
                          />
                          <Input
                            type="time"
                            value={offerTime}
                            onChange={(e) => setOfferTime(e.target.value)}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {offerExpiresAt
                            ? `The countdown ends ${formatInZone(offerExpiresAt, timezone)} — your workspace time.`
                            : "The countdown in the message ticks down to this moment, read in your workspace timezone."}
                        </p>
                      </div>
                    )}
                    {offerIssue && (
                      <div
                        role="status"
                        className={cn(
                          "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
                          offerIssue.level === "error"
                            ? "border-destructive/40 bg-destructive/10 text-destructive"
                            : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
                        )}
                      >
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>{offerIssue.message}</span>
                      </div>
                    )}
                  </div>
                )}

                {(needsCoupon || needsOfferExpiry) && template && (
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      Exactly what the customer sees
                    </Label>
                    <div className="rounded-2xl bg-[#ECE5DD] p-4 dark:bg-muted">
                      <TemplatePreview model={previewModel} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      The countdown is live — it ticks down here the same way it will on their
                      phone.
                    </p>
                  </div>
                )}


                {variables.map((n) => {
                  const m = mappings[String(n)];
                  return (
                    <div
                      key={n}
                      className="space-y-2 rounded-xl border border-border/70 bg-muted/30 p-3"
                    >
                      <Label className="text-xs">Variable {`{{${n}}}`}</Label>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Select
                          value={m?.source ?? ""}
                          onValueChange={(v) => setMapping(n, { source: v as VariableSource })}
                        >
                          <SelectTrigger className="sm:w-56">
                            <SelectValue placeholder="Choose a source" />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(VARIABLE_SOURCE_LABELS) as VariableSource[]).map((s) => (
                              <SelectItem key={s} value={s}>
                                {VARIABLE_SOURCE_LABELS[s]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        {m?.source === "attribute" && (
                          <Select
                            value={m.key ?? ""}
                            onValueChange={(v) => setMapping(n, { key: v })}
                          >
                            <SelectTrigger className="flex-1">
                              <SelectValue placeholder="Pick an attribute" />
                            </SelectTrigger>
                            <SelectContent>
                              {attributeKeys.map((k) => (
                                <SelectItem key={k} value={k}>
                                  {k}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}

                        {m?.source === "static" && (
                          <Input
                            className="flex-1"
                            value={m.value ?? ""}
                            onChange={(e) => setMapping(n, { value: e.target.value })}
                            placeholder="Text everyone sees"
                          />
                        )}
                      </div>
                    </div>
                  );
                })}

                {template && (
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      Preview for {sample.name || sample.phone}
                    </Label>
                    <ChatPreview
                      body={renderTemplate(bodyText, previewValues)}
                      footer={footerText}
                      imageUrl={
                        needsHeaderMedia && headerMediaFormat === "IMAGE"
                          ? effectiveHeaderMedia || undefined
                          : undefined
                      }
                      mediaLabel={
                        needsHeaderMedia && headerMediaFormat !== "IMAGE"
                          ? headerMediaFormat === "VIDEO"
                            ? "Video attached"
                            : "Document attached"
                          : undefined
                      }
                    />
                  </div>
                )}
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setSendNow(true)}
                    className={cn(
                      "rounded-2xl border p-4 text-left transition-all duration-200",
                      sendNow
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-border/70 hover:border-primary/40",
                    )}
                  >
                    <Send className="mb-2 h-4 w-4 text-primary" />
                    <p className="text-sm font-medium">Send now</p>
                    <p className="text-xs text-muted-foreground">Starts within a minute.</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSendNow(false)}
                    className={cn(
                      "rounded-2xl border p-4 text-left transition-all duration-200",
                      !sendNow
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-border/70 hover:border-primary/40",
                    )}
                  >
                    <CalendarClock className="mb-2 h-4 w-4 text-primary" />
                    <p className="text-sm font-medium">Schedule</p>
                    <p className="text-xs text-muted-foreground">Pick a date and time.</p>
                  </button>
                </div>

                {!sendNow && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="campaign-date">Date</Label>
                      <Input
                        id="campaign-date"
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="campaign-time">Time ({timezone})</Label>
                      <Input
                        id="campaign-time"
                        type="time"
                        value={time}
                        onChange={(e) => setTime(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {offerIssue && (
                  <div
                    role="status"
                    className={cn(
                      "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
                      offerIssue.level === "error"
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
                    )}
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{offerIssue.message}</span>
                  </div>
                )}

              </div>
            )}

            {step === 4 && (
              <div className="space-y-4">
                <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
                  <dl className="space-y-2 text-sm">
                    {[
                      ["Campaign", name],
                      ["Sending from", numberLabel(senderNumber)],

                      [
                        "Audience",
                        `${audience?.eligible ?? 0} opted-in contacts${
                          segmentId === "all"
                            ? ""
                            : ` · ${segments.find((s) => s.id === segmentId)?.name ?? ""}`
                        }`,
                      ],
                      ["Template", templateName],
                      [
                        "Sending",
                        sendNow
                          ? "Immediately"
                          : scheduledAt
                            ? formatInZone(scheduledAt, timezone)
                            : "—",
                      ],
                      ...(needsCoupon && couponCode.trim()
                        ? [["Coupon code", couponCode.trim()] as [string, string]]
                        : []),
                      ...(offerExpiresAt
                        ? [["Offer ends", formatInZone(offerExpiresAt, timezone)] as [string, string]]
                        : []),
                    ].map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="text-right font-medium">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
                {needsCoupon || needsOfferExpiry ? (
                  <div className="rounded-2xl bg-[#ECE5DD] p-4 dark:bg-muted">
                    <TemplatePreview model={previewModel} />
                  </div>
                ) : (
                  <ChatPreview
                    body={renderTemplate(bodyText, previewValues)}
                    footer={footerText}
                    imageUrl={
                      needsHeaderMedia && headerMediaFormat === "IMAGE"
                        ? effectiveHeaderMedia || undefined
                        : undefined
                    }
                    mediaLabel={
                      needsHeaderMedia && headerMediaFormat !== "IMAGE"
                        ? headerMediaFormat === "VIDEO"
                          ? "Video attached"
                          : "Document attached"
                        : undefined
                    }
                  />
                )}

              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-2">
          <Button
            variant="ghost"
            className="rounded-full"
            onClick={() => (step === 0 ? onOpenChange(false) : setStep((s) => s - 1))}
            disabled={launching}
          >
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            {step === 0 ? "Cancel" : "Back"}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button
              className="rounded-full"
              disabled={!canNext()}
              onClick={() => setStep((s) => s + 1)}
            >
              Continue <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          ) : (
            <Button className="rounded-full" disabled={launching || offerIssue?.level === "error"} onClick={() => void launch()}>
              {launching ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="mr-1.5 h-4 w-4" />
              )}
              {sendNow ? "Launch campaign" : "Schedule campaign"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
