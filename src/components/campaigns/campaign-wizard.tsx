import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  Coins,
  Loader2,
  type LucideIcon,
  Rocket,
  Send,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { useNavigate } from "@tanstack/react-router";
import { usePermissions } from "@/hooks/use-permissions";
import { money, type CampaignCostEstimate } from "@/lib/billing";
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
import { CampaignTestSend } from "@/components/campaigns/campaign-test-send";
import { WhatsAppText } from "@/components/whatsapp-text";
import { CardAttachmentPicker } from "@/components/cards/card-attachment-picker";
import { CardPreview } from "@/components/cards/card-preview";
import type { CardAttachment } from "@/lib/customer-cards";
import { TemplatePreview, componentsToPreview } from "@/components/templates/template-preview";
import { CustomerPhone } from "@/components/templates/customer-phone";
import { count } from "@/components/campaigns/campaign-rates";
import { formatInZone, offerTimingIssue, zonedToUtcIso } from "@/lib/offers";

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

/**
 * Batch 41: audience → message → personalise → test → review, then launch.
 * The campaign name is asked with the audience; "when to send" with the review.
 */
const STEPS = ["Audience", "Message", "Personalise", "Test", "Review"] as const;

const STEP_INTRO: Record<(typeof STEPS)[number], { title: string; hint: string }> = {
  Audience: { title: "Who gets it?", hint: "Name the campaign and pick who receives it." },
  Message: { title: "What they get", hint: "Pick one of your approved templates." },
  Personalise: {
    title: "Make it theirs",
    hint: "Fill each blank from the contact's own details, and add any offer.",
  },
  Test: { title: "Try it on your phone", hint: "Optional: send yourself the exact message first." },
  Review: {
    title: "Check and launch",
    hint: "Everything this campaign does, before anything sends.",
  },
};

const FALLBACK_SAMPLE: SampleContact = {
  name: "Priya",
  phone: "+919876543210",
  attributes: {},
};

function StepDots({ step, onBack }: { step: number; onBack: (to: number) => void }) {
  return (
    <div>
      <ol className="flex items-center gap-1.5" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className="relative flex min-w-0 flex-1 flex-col gap-1.5"
            aria-current={i === step ? "step" : undefined}
          >
            {i < step ? (
              <button
                type="button"
                onClick={() => onBack(i)}
                className="absolute inset-0 z-10 rounded-sm"
                aria-label={`Back to ${label}`}
              />
            ) : null}
            <span
              className={cn(
                "h-1 rounded-full transition-colors duration-300",
                i <= step ? "bg-primary" : "bg-muted",
              )}
              aria-hidden="true"
            />
            <span
              className={cn(
                "hidden items-center gap-1 truncate text-xs sm:flex",
                i === step
                  ? "font-medium text-foreground"
                  : i < step
                    ? "text-primary"
                    : "text-muted-foreground",
              )}
            >
              {i < step ? (
                <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
              ) : (
                <span className="tabular text-faint">{i + 1}</span>
              )}
              {label}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-muted-foreground sm:hidden">
        Step {step + 1} of {STEPS.length} ·{" "}
        <span className="font-medium text-foreground">{STEPS[step]}</span>
      </p>
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
  const { can } = usePermissions();
  const navigate = useNavigate();
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
  const [audienceError, setAudienceError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<CampaignCostEstimate | null>(null);

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
  // An optional branded picture card sent after each template.
  const [card, setCard] = useState<CardAttachment | null>(null);
  // A carousel can run a different discount on every card, so each card with a
  // copy-code button keeps its own code. Blank means "use the main code".
  const [cardCoupons, setCardCoupons] = useState<Record<number, string>>({});
  const [offerDate, setOfferDate] = useState("");
  const [offerTime, setOfferTime] = useState("");
  // Batch 35: the campaign-to-be its test sends count against (20 at most).
  const [testRef, setTestRef] = useState("");

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
    setAudienceError(null);
    setSendNow(true);
    setDate("");
    setTime("");
    setHeaderMedia({ url: "", fileName: "" });
    setCardMedia({});
    setCouponCode("");
    setCardCoupons({});
    setOfferDate("");
    setOfferTime("");
    if (open) setTestRef(crypto.randomUUID());
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
    const { data, error } = await callApi<AudienceSummary>("/api/campaigns/audience", {
      body: {
        organization_id: organizationId,
        segment_id: segmentId === "all" ? null : segmentId,
        whatsapp_account_id: accountId || null,
      },
    });
    setAudience(data);
    setAudienceError(data ? null : error);
    setAudienceLoading(false);
  }, [organizationId, segmentId, accountId]);

  useEffect(() => {
    if (!open || step !== 0) return;
    const t = setTimeout(() => void loadAudience(), 150);
    return () => clearTimeout(t);
  }, [open, step, loadAudience]);

  // What this send costs, and whether there's enough in the wallet. Batch 41:
  // always on screen, so it follows the audience and the template chosen.
  useEffect(() => {
    if (!open) return;
    const recipients = audience?.eligible ?? 0;
    if (!recipients) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    const category = (
      templates.find((t) => t.name === templateName)?.category ?? "marketing"
    ).toLowerCase();
    void (async () => {
      const { data } = await callApi<CampaignCostEstimate>("/api/campaigns/estimate", {
        body: {
          organization_id: organizationId,
          recipients,
          category,
          whatsapp_account_id: accountId || null,
        },
      });
      if (!cancelled) setEstimate(data && data.enabled ? data : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, organizationId, audience?.eligible, templates, templateName, accountId]);

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
  const effectiveCardMedia = (index: number) => cardMedia[index] || cards[index]?.mediaUrl || "";
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
  const couponCards = useMemo(() => spec.cards.filter((c) => c.copyCodeButtons.length > 0), [spec]);
  const needsCoupon = needsMainCoupon || couponCards.length > 0;
  /** The code a given card actually sends: its own, else the main one. */
  const effectiveCardCoupon = (index: number) =>
    (cardCoupons[index] ?? "").trim() || couponCode.trim();
  /** Cards whose own code collides with another card's own code. */
  const duplicateCouponCards = useMemo(() => {
    const seen = new Map<string, number>();
    const dupes = new Set<number>();
    for (const card of couponCards) {
      const own = (cardCoupons[card.index] ?? "").trim();
      if (!own) continue;
      if (seen.has(own)) {
        dupes.add(seen.get(own)!);
        dupes.add(card.index);
      } else {
        seen.set(own, card.index);
      }
    }
    return dupes;
  }, [couponCards, cardCoupons]);
  const couponsReady =
    (!needsMainCoupon || couponCode.trim().length > 0) &&
    couponCards.every((c) => effectiveCardCoupon(c.index).length > 0) &&
    duplicateCouponCards.size === 0;
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
    if (step === 0)
      return (
        name.trim().length >= 2 &&
        Boolean(accountId) &&
        (audience?.eligible ?? 0) > 0 &&
        (estimate ? estimate.can_send : true)
      );
    if (step === 1) return Boolean(template) && mediaReady;
    if (step === 2)
      return (
        Boolean(template) &&
        mediaReady &&
        offerReady &&
        offerIssue?.level !== "error" &&
        variables.every((n) => mappingIsComplete(mappings[String(n)]))
      );
    return true;
  };
  /** Batch 41: "when to send" now sits on the review step, so launch checks it. */
  const canLaunch =
    !launching && offerReady && offerIssue?.level !== "error" && (sendNow || Boolean(scheduledAt));

  /** What this campaign sends with — launch and the test send use the same. */
  const sendSettings = useMemo(
    () => ({
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
      ...(card ? { card: { kind: card.kind, vars: card.vars } } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      needsHeaderMedia,
      headerMedia.url,
      cards,
      cardMedia,
      cardCoupons,
      needsCoupon,
      couponCode,
      offerExpiresAt,
      card,
    ],
  );

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
        send_settings: sendSettings,
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

  const intro = STEP_INTRO[STEPS[step] ?? "Audience"];
  const business = senderNumber?.verified_name || numberLabel(senderNumber) || "Your business";
  const segmentName =
    segmentId === "all"
      ? "All opted-in contacts"
      : (segments.find((s) => s.id === segmentId)?.name ?? "");
  const goNext = () => {
    if (step < STEPS.length - 1 && canNext()) setStep((s) => s + 1);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="left-0 top-0 flex h-[100dvh] max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 sm:max-w-none sm:rounded-none"
        onKeyDown={(e) => {
          // ⌘/Ctrl + Enter moves on, the same as Continue.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            goNext();
          }
        }}
      >
        <header className="shrink-0 border-b border-border bg-card px-4 py-3 pr-14 sm:px-6">
          <div className="mx-auto flex max-w-6xl flex-col gap-3 md:flex-row md:items-center md:gap-8">
            <div className="min-w-0 shrink-0">
              <DialogTitle className="text-base">Create campaign</DialogTitle>
              <DialogDescription className="sr-only">
                Five quick steps — we&apos;ll show you exactly who receives what before anything
                sends.
              </DialogDescription>
            </div>
            <div className="min-w-0 flex-1">
              <StepDots step={step} onBack={setStep} />
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto bg-background">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_336px] lg:gap-12 lg:py-10">
            <div className="min-w-0 max-w-2xl">
              <div key={step} className="page-enter">
                <h2 className="type-title text-foreground">{intro.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{intro.hint}</p>
              </div>

              {loadingLists ? (
                <div className="mt-6 space-y-3" aria-busy="true" aria-label="Loading">
                  <Skeleton className="h-10 w-full rounded-lg" />
                  <Skeleton className="h-24 w-full rounded-xl" />
                  <Skeleton className="h-24 w-full rounded-xl" />
                </div>
              ) : (
                <div key={`body-${step}`} className="page-enter mt-6 space-y-6">
                  {step === 0 && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="campaign-name">Campaign name</Label>
                        <Input
                          id="campaign-name"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="Diwali offer — VIP customers"
                          autoFocus
                          aria-describedby="campaign-name-hint"
                        />
                        <p id="campaign-name-hint" className="text-xs text-muted-foreground">
                          Only your team sees this. Customers never see the campaign name.
                        </p>
                      </div>

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
                            Templates and delivery are tied to this number. Opt-outs always apply
                            across the whole workspace.
                          </p>
                        </div>
                      ) : null}

                      <fieldset className="space-y-2">
                        <legend className="mb-2 text-sm font-medium text-foreground">
                          Who should receive this?
                        </legend>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {[
                            {
                              id: "all",
                              name: "All opted-in contacts",
                              description: "Everyone who said yes to messages.",
                            },
                            ...segments.map((sg) => ({
                              id: sg.id,
                              name: sg.name,
                              description: sg.description ?? "",
                            })),
                          ].map((option) => (
                            <ChoiceCard
                              key={option.id}
                              name="campaign-segment"
                              checked={segmentId === option.id}
                              onSelect={() => setSegmentId(option.id)}
                              title={option.name}
                              detail={option.description}
                            />
                          ))}
                        </div>
                      </fieldset>

                      <div
                        className="rounded-xl border border-border bg-card p-5 shadow-xs"
                        aria-live="polite"
                      >
                        {!audienceLoading && audienceError ? (
                          <p className="text-sm text-danger-soft-foreground">{audienceError}</p>
                        ) : audienceLoading || !audience ? (
                          <div className="space-y-2">
                            <Skeleton className="h-7 w-28 rounded" />
                            <Skeleton className="h-4 w-52 rounded" />
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-2">
                              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                                <Users className="h-4 w-4" aria-hidden="true" />
                              </span>
                              <span className="tabular text-2xl font-semibold text-foreground">
                                {count.format(audience.eligible)}
                              </span>
                              <span className="text-sm text-muted-foreground">will receive it</span>
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">
                              {count.format(audience.matched)} matched ·{" "}
                              {count.format(audience.excluded)} excluded (not opted in)
                            </p>
                          </>
                        )}
                      </div>

                      {estimate && !estimate.can_send ? (
                        <div className="space-y-3 rounded-xl border border-danger-border bg-danger-soft p-4">
                          <p className="text-sm text-danger-soft-foreground">
                            You&apos;re short {money(estimate.shortfall, estimate.currency)}. Add
                            credits to send this campaign.
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {can("billing.pay") && (
                              <Button size="sm" onClick={() => navigate({ to: "/app/billing" })}>
                                Buy credits
                              </Button>
                            )}
                            {can("billing.request") && !can("billing.pay") && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => navigate({ to: "/app/billing" })}
                              >
                                Request a top-up
                              </Button>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}

                  {step === 1 && (
                    <>
                      <fieldset className="space-y-2">
                        <legend className="mb-2 text-sm font-medium text-foreground">
                          Approved template
                        </legend>
                        {templates.length === 0 ? (
                          <p className="rounded-xl border border-dashed border-border bg-subtle px-4 py-6 text-sm text-muted-foreground">
                            You don&apos;t have an approved template yet. Create one under Templates
                            first.
                          </p>
                        ) : (
                          <div className="grid gap-2">
                            {templates.map((t) => (
                              <ChoiceCard
                                key={t.id}
                                name="campaign-template"
                                checked={templateName === t.name}
                                onSelect={() => setTemplateName(t.name)}
                                title={<span className="font-mono text-[0.8125rem]">{t.name}</span>}
                                meta={`${(t.category ?? "").toLowerCase()} · ${t.language}`}
                                detail={templateBodyText(t.components)}
                              />
                            ))}
                          </div>
                        )}
                      </fieldset>

                      {needsHeaderMedia && (
                        <div className="space-y-2 rounded-xl border border-border bg-card p-4 shadow-xs">
                          <Label className="text-sm">
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
                        <div className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-xs">
                          <Label className="text-sm">Carousel cards</Label>
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
                                onCleared={() => setCardMedia((prev) => ({ ...prev, [i]: "" }))}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {step === 2 && (
                    <>
                      {variables.length > 0 ? (
                        <div className="space-y-3">
                          {variables.map((n) => {
                            const m = mappings[String(n)];
                            const done = mappingIsComplete(m);
                            return (
                              <div
                                key={n}
                                className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-xs"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <Label className="flex items-center gap-2 text-sm">
                                    Variable
                                    <span className="rounded-md border border-info-border bg-info-soft px-1.5 py-0.5 font-mono text-xs text-info-soft-foreground">
                                      {`{{${n}}}`}
                                    </span>
                                  </Label>
                                  {done ? (
                                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                                      For {sample.name || sample.phone}:{" "}
                                      <span className="font-medium text-foreground">
                                        {previewValues[n] || "—"}
                                      </span>
                                    </span>
                                  ) : null}
                                </div>
                                <div className="flex flex-col gap-2 sm:flex-row">
                                  <Select
                                    value={m?.source ?? ""}
                                    onValueChange={(v) =>
                                      setMapping(n, { source: v as VariableSource })
                                    }
                                  >
                                    <SelectTrigger
                                      className="sm:w-56"
                                      aria-label={`Source for {{${n}}}`}
                                    >
                                      <SelectValue placeholder="Choose a source" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {(
                                        Object.keys(VARIABLE_SOURCE_LABELS) as VariableSource[]
                                      ).map((src) => (
                                        <SelectItem key={src} value={src}>
                                          {VARIABLE_SOURCE_LABELS[src]}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>

                                  {m?.source === "attribute" && (
                                    <Select
                                      value={m.key ?? ""}
                                      onValueChange={(v) => setMapping(n, { key: v })}
                                    >
                                      <SelectTrigger
                                        className="flex-1"
                                        aria-label={`Attribute for {{${n}}}`}
                                      >
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
                                      aria-label={`Text for {{${n}}}`}
                                    />
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="rounded-xl border border-dashed border-border bg-subtle px-4 py-5 text-sm text-muted-foreground">
                          This template has no blanks to fill — everyone gets the same words.
                        </p>
                      )}

                      {(needsCoupon || needsOfferExpiry) && (
                        <div className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-xs">
                          <Label className="text-sm">{offer ? offer.text : "Offer details"}</Label>
                          {needsCoupon && (
                            <div className="space-y-1.5">
                              <Label className="text-xs font-medium">
                                {couponCards.length > 0 && !needsMainCoupon
                                  ? "Coupon code for every card"
                                  : "Coupon code"}
                              </Label>
                              <Input
                                value={couponCode}
                                onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                                placeholder="SAVE20"
                                maxLength={15}
                                aria-invalid={needsMainCoupon && !couponCode.trim()}
                              />
                              <p className="text-xs text-muted-foreground">
                                {couponCards.length > 0
                                  ? "The code customers copy with one tap. Every card uses this unless you give that card its own code below."
                                  : "This is the code customers copy with one tap. Everyone in this campaign gets the same code."}
                              </p>
                            </div>
                          )}

                          {couponCards.length > 0 && (
                            <div className="space-y-2">
                              <Label className="text-xs font-medium">Codes per card</Label>
                              <p className="text-xs text-muted-foreground">
                                Running a different discount on each card? Give that card its own
                                code. Leave it blank to use the code above.
                              </p>
                              {couponCards.map((card) => {
                                const isDupe = duplicateCouponCards.has(card.index);
                                const isEmpty = effectiveCardCoupon(card.index).length === 0;
                                return (
                                  <div key={card.index} className="space-y-1">
                                    <Label className="text-[11px] text-muted-foreground">
                                      Card {card.index + 1}
                                      {cards[card.index]?.body
                                        ? ` · ${cards[card.index]!.body.slice(0, 40)}`
                                        : ""}
                                    </Label>
                                    <Input
                                      value={cardCoupons[card.index] ?? ""}
                                      aria-invalid={isDupe || isEmpty}
                                      className={cn(
                                        (isDupe || isEmpty) &&
                                          "border-danger focus-visible:ring-danger",
                                      )}
                                      onChange={(e) =>
                                        setCardCoupons((prev) => ({
                                          ...prev,
                                          [card.index]: e.target.value.toUpperCase(),
                                        }))
                                      }
                                      placeholder={couponCode.trim() || "SHOES20"}
                                      maxLength={15}
                                    />
                                    {isDupe && (
                                      <p className="text-xs text-danger-soft-foreground">
                                        Another card already uses this code — each card needs its
                                        own.
                                      </p>
                                    )}
                                  </div>
                                );
                              })}
                              {couponCards.some(
                                (c) => effectiveCardCoupon(c.index).length === 0,
                              ) && (
                                <p className="text-xs text-danger-soft-foreground">
                                  Every card with a copy-code button needs a code — either its own
                                  or the shared one above.
                                </p>
                              )}
                            </div>
                          )}
                          {needsOfferExpiry && (
                            <div className="space-y-1.5">
                              <Label className="text-xs font-medium">Offer ends ({timezone})</Label>
                              <div className="flex gap-2">
                                <Input
                                  type="date"
                                  value={offerDate}
                                  onChange={(e) => setOfferDate(e.target.value)}
                                  aria-label="Offer end date"
                                />
                                <Input
                                  type="time"
                                  value={offerTime}
                                  onChange={(e) => setOfferTime(e.target.value)}
                                  aria-label="Offer end time"
                                />
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {offerExpiresAt
                                  ? `The countdown ends ${formatInZone(offerExpiresAt, timezone)} — your workspace time.`
                                  : "The countdown in the message ticks down to this moment, read in your workspace timezone."}
                              </p>
                            </div>
                          )}
                          {offerIssue && <OfferIssue issue={offerIssue} />}
                        </div>
                      )}

                      <CardAttachmentPicker
                        idPrefix="campaign"
                        value={card}
                        onChange={setCard}
                        hint="Write {{1}}, {{2}} and so on to reuse each contact's own details."
                        explanation="Optional: a branded picture (offer, product, receipt…) sent to each contact right after this template. No card is sent unless you pick one."
                        organizationId={organizationId}
                      />
                    </>
                  )}

                  {step === 3 && (
                    <>
                      {testRef && templateName ? (
                        <CampaignTestSend
                          organizationId={organizationId}
                          testRef={testRef}
                          templateName={templateName}
                          accountId={accountId}
                          mappings={mappings}
                          sendSettings={sendSettings}
                        />
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        Nothing goes to your audience from this step. Skip it with Continue.
                      </p>
                    </>
                  )}

                  {step === 4 && (
                    <>
                      <fieldset>
                        <legend className="mb-2 text-sm font-medium text-foreground">
                          When should it send?
                        </legend>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <ChoiceCard
                            name="campaign-when"
                            checked={sendNow}
                            onSelect={() => setSendNow(true)}
                            icon={Send}
                            title="Send now"
                            detail="Starts within a minute."
                          />
                          <ChoiceCard
                            name="campaign-when"
                            checked={!sendNow}
                            onSelect={() => setSendNow(false)}
                            icon={CalendarClock}
                            title="Schedule"
                            detail="Pick a date and time."
                          />
                        </div>
                      </fieldset>

                      {!sendNow && (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-2">
                            <Label htmlFor="campaign-date">Date</Label>
                            <Input
                              id="campaign-date"
                              type="date"
                              value={date}
                              onChange={(e) => setDate(e.target.value)}
                              aria-invalid={!date}
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

                      {offerIssue && <OfferIssue issue={offerIssue} />}

                      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
                        <dl className="divide-y divide-border text-sm">
                          {[
                            ["Campaign", name],
                            ["Sending from", numberLabel(senderNumber)],
                            [
                              "Audience",
                              `${count.format(audience?.eligible ?? 0)} opted-in contacts${
                                segmentId === "all" ? "" : ` · ${segmentName}`
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
                            ...(estimate
                              ? [
                                  [
                                    "Cost",
                                    `about ${money(estimate.estimate, estimate.currency)}`,
                                  ] as [string, string],
                                ]
                              : []),
                            ...(needsMainCoupon && couponCode.trim()
                              ? [["Coupon code", couponCode.trim()] as [string, string]]
                              : []),
                            ...(offerExpiresAt
                              ? [
                                  ["Offer ends", formatInZone(offerExpiresAt, timezone)] as [
                                    string,
                                    string,
                                  ],
                                ]
                              : []),
                          ].map(([k, v]) => (
                            <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
                              <dt className="text-muted-foreground">{k}</dt>
                              <dd className="min-w-0 truncate text-right font-medium text-foreground">
                                {v}
                              </dd>
                            </div>
                          ))}
                        </dl>
                        {couponCards.length > 0 && (
                          <div className="space-y-2 border-t border-border p-4">
                            <p className="text-xs font-medium text-muted-foreground">
                              Offer on each card
                            </p>
                            {couponCards.map((c) => (
                              <div
                                key={c.index}
                                className="space-y-0.5 rounded-lg border border-border bg-subtle px-3 py-2 text-xs"
                              >
                                <p className="font-medium">
                                  Card {c.index + 1}
                                  {cards[c.index]?.body ? ` — ${cards[c.index]!.body}` : ""}
                                </p>
                                <p className="text-muted-foreground">
                                  Code{" "}
                                  <span className="font-mono font-medium text-foreground">
                                    {effectiveCardCoupon(c.index)}
                                  </span>
                                  {offerExpiresAt
                                    ? ` · ends ${formatInZone(offerExpiresAt, timezone)}`
                                    : ""}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* The customer's phone and what it costs, beside every step. */}
            <aside
              className="space-y-4 self-start lg:sticky lg:top-0"
              aria-label="Preview and cost"
            >
              <div>
                <CustomerPhone business={business}>
                  {template ? (
                    <div className="space-y-2">
                      <TemplatePreview model={previewModel} />
                      {card ? (
                        <CardPreview kind={card.kind} vars={card.vars} className="max-w-[220px]" />
                      ) : null}
                    </div>
                  ) : (
                    <div className="wa-bubble-in wa-tail max-w-[85%] text-[0.8125rem] text-wa-meta">
                      Pick a template and your message appears here, as your customer sees it.
                    </div>
                  )}
                </CustomerPhone>
                <p className="mt-3 text-center text-xs text-muted-foreground">
                  {template ? `Preview for ${sample.name || sample.phone}` : "Live preview"}
                  {offer?.hasExpiration ? " · the countdown is live" : ""}
                </p>
              </div>
              <CostPanel
                audience={audience}
                audienceLoading={audienceLoading}
                estimate={estimate}
              />
            </aside>
          </div>
        </div>

        <footer className="shrink-0 border-t border-border bg-card px-4 py-3 sm:px-6">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
            <Button
              variant="ghost"
              onClick={() => (step === 0 ? onOpenChange(false) : setStep((s) => s - 1))}
              disabled={launching}
            >
              <ArrowLeft className="h-4 w-4" />
              {step === 0 ? "Cancel" : "Back"}
            </Button>
            <CostLine
              audience={audience}
              audienceLoading={audienceLoading}
              estimate={estimate}
              className="hidden min-w-0 flex-1 justify-center sm:flex"
            />
            {step < STEPS.length - 1 ? (
              <Button
                disabled={!canNext()}
                onClick={goNext}
                aria-keyshortcuts="Control+Enter Meta+Enter"
              >
                Continue <ArrowRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button disabled={!canLaunch} onClick={() => void launch()}>
                {launching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Rocket className="h-4 w-4" />
                )}
                {sendNow ? "Launch campaign" : "Schedule campaign"}
              </Button>
            )}
          </div>
          <CostLine
            audience={audience}
            audienceLoading={audienceLoading}
            estimate={estimate}
            className="mt-2 flex justify-center sm:hidden"
          />
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/** A selectable card: a real radio input, so arrows and Space work as usual. */
function ChoiceCard({
  name,
  checked,
  onSelect,
  title,
  meta,
  detail,
  icon: Icon,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: ReactNode;
  meta?: string | undefined;
  detail?: string | undefined;
  icon?: LucideIcon | undefined;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-3.5 shadow-xs transition-[border-color,box-shadow,background-color] duration-150",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        checked
          ? "border-primary bg-primary/[0.04] ring-1 ring-primary"
          : "border-border hover:border-border-strong",
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="sr-only" />
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          checked ? "border-primary bg-primary" : "border-border-strong bg-card",
        )}
      >
        {checked ? <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
            {Icon ? <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" /> : null}
            <span className="truncate">{title}</span>
          </span>
          {meta ? (
            <span className="shrink-0 text-xs capitalize text-muted-foreground">{meta}</span>
          ) : null}
        </span>
        {detail ? (
          <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </span>
    </label>
  );
}

function OfferIssue({ issue }: { issue: { level: "error" | "warning"; message: string } }) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        issue.level === "error"
          ? "border-danger-border bg-danger-soft text-danger-soft-foreground"
          : "border-warning-border bg-warning-soft text-warning-soft-foreground",
      )}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{issue.message}</span>
    </div>
  );
}

type CostProps = {
  audience: AudienceSummary | null;
  audienceLoading: boolean;
  estimate: CampaignCostEstimate | null;
};

/** One line for the footer: who, and roughly what it costs. */
function CostLine({
  audience,
  audienceLoading,
  estimate,
  className,
}: CostProps & { className?: string }) {
  return (
    <p
      className={cn("items-center gap-2 text-xs text-muted-foreground", className)}
      aria-live="polite"
    >
      <Coins className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
      <span className="truncate">
        {audienceLoading && !audience ? (
          "Counting your audience…"
        ) : audience ? (
          <>
            <span className="tabular font-medium text-foreground">
              {count.format(audience.eligible)}
            </span>{" "}
            people
            {estimate ? (
              <>
                {" · about "}
                <span className="tabular font-medium text-foreground">
                  {money(estimate.estimate, estimate.currency)}
                </span>
              </>
            ) : null}
          </>
        ) : (
          "Pick an audience to see the cost"
        )}
      </span>
    </p>
  );
}

/** The cost card beside the phone: the estimate and what it rests on. */
function CostPanel({ audience, audienceLoading, estimate }: CostProps) {
  return (
    <section
      aria-label="Cost"
      className={cn(
        "rounded-xl border bg-card p-4 shadow-xs",
        estimate && !estimate.can_send ? "border-danger-border" : "border-border",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-muted-foreground">This send costs about</span>
        <span className="tabular text-lg font-semibold text-foreground">
          {estimate ? money(estimate.estimate, estimate.currency) : "—"}
        </span>
      </div>
      {estimate ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {money(estimate.rate, estimate.currency)} per message · you have{" "}
          {money(estimate.available, estimate.currency)} in credits
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          {audienceLoading
            ? "Counting your audience…"
            : audience
              ? ""
              : "Pick an audience to see the cost."}
        </p>
      )}
      {audience ? (
        <p className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
          <Users className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          <span className="tabular font-medium text-foreground">
            {count.format(audience.eligible)}
          </span>{" "}
          will receive it
        </p>
      ) : null}
      {estimate && !estimate.can_send ? (
        <p className="mt-3 text-xs text-danger-soft-foreground">
          You&apos;re short {money(estimate.shortfall, estimate.currency)}. Add credits to send this
          campaign.
        </p>
      ) : null}
      {estimate?.can_send && estimate.needs_approval ? (
        <p className="mt-3 text-xs text-warning-soft-foreground">
          This is above your approval limit, so it will wait for an owner to approve it before
          anything sends.
        </p>
      ) : null}
      {estimate?.over_daily_limit ? (
        <p className="mt-3 text-xs text-warning-soft-foreground">
          Your number can message {estimate.daily_limit} people a day right now, so this will spread
          over about {estimate.days_needed} days.
        </p>
      ) : null}
    </section>
  );
}
