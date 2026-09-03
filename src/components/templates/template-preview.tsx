import { useEffect, useState } from "react";
import { formatCountdown } from "@/lib/offers";
import {

  Copy,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  MapPin,
  Phone,
  PlaySquare,
  Reply,
  ShoppingBag,
  Store,
  Timer,
} from "lucide-react";
import type { HeaderFormat, TemplateComponent, TemplateDraft } from "@/lib/templates";
import {
  authenticationPreviewText,
  templateBodyText,
  templateButtons,
  templateCards,
  templateFooterText,
  templateHeader,
  templateOffer,
} from "@/lib/templates";

/**
 * What a customer will actually see. One preview component, used by the
 * builder while a merchant types and by the template list afterwards, so the
 * two can never drift apart.
 */
export type PreviewButton = Record<string, unknown>;

export type PreviewModel = {
  header: { format: HeaderFormat; text: string; mediaUrl: string | null; fileName?: string } | null;
  body: string;
  footer: string;
  buttons: PreviewButton[];
  cards: Array<{
    format: "IMAGE" | "VIDEO";
    mediaUrl: string | null;
    body: string;
    buttons: PreviewButton[];
    /** This card's own coupon, when a carousel runs a different deal per card. */
    couponCode?: string | null;
  }>;
  offer: { text: string; hasExpiration: boolean; expiresAt?: string | null } | null;
  /** The code a copy-code button hands the customer, when it's known. */
  couponCode?: string | null;
};


/** Fills {{1}}-style placeholders with the merchant's example values. */
function fill(text: string, examples: Record<number | string, string>): string {
  return text.replace(/\{\{(\d+)\}\}/g, (match, index: string) => {
    const value = examples[Number(index)] ?? examples[index];
    return value?.trim() ? value : match;
  });
}

export function draftToPreview(draft: TemplateDraft): PreviewModel {
  if (draft.category === "AUTHENTICATION") {
    return {
      header: null,
      body:
        "123456 is your verification code." +
        (draft.addSecurityRecommendation ? " For your security, do not share this code." : ""),
      footer: `This code expires in ${draft.codeExpirationMinutes} minutes.`,
      buttons: draft.buttons.map((b) => ({ type: "COPY_CODE", text: b.text || "Copy code" })),
      cards: [],
      offer: null,
    };
  }

  return {
    header:
      draft.headerFormat === "NONE"
        ? null
        : {
            format: draft.headerFormat,
            text: fill(draft.headerText, { 1: draft.headerExample }),
            mediaUrl: draft.headerMediaUrl || null,
            fileName: draft.headerFileName,
          },
    body: fill(draft.body, draft.bodyExamples),
    footer: draft.footer,
    buttons: draft.buttons as unknown as PreviewButton[],
    cards: draft.cards.map((card) => ({
      format: card.format,
      mediaUrl: card.mediaUrl || null,
      body: fill(card.body, card.bodyExamples),
      buttons: card.buttons as unknown as PreviewButton[],
    })),
    offer: draft.offerEnabled
      ? { text: draft.offerText || "Limited-time offer", hasExpiration: draft.offerHasExpiration }
      : null,
  };
}

export function componentsToPreview(
  components: TemplateComponent[] | null | undefined,
  values: Record<number, string> = {},
): PreviewModel {
  const auth = authenticationPreviewText(components);
  if (auth) {
    return {
      header: null,
      body: auth.body.replace("{{1}}", values[1] ?? "123456"),
      footer: auth.footer,
      buttons: templateButtons(components),
      cards: [],
      offer: null,
    };
  }
  const header = templateHeader(components);
  return {
    header: header ? { ...header, text: fill(header.text, values) } : null,
    body: fill(templateBodyText(components), values),
    footer: templateFooterText(components),
    buttons: templateButtons(components),
    cards: templateCards(components).map((card) => ({
      ...card,
      body: fill(card.body, values),
    })),
    offer: templateOffer(components),
  };
}

const BUTTON_ICON: Record<string, typeof Reply> = {
  QUICK_REPLY: Reply,
  URL: ExternalLink,
  PHONE_NUMBER: Phone,
  COPY_CODE: Copy,
  FLOW: FileText,
  CATALOG: Store,
  MPM: ShoppingBag,
  OTP: Copy,
};

function ButtonRow({
  button,
  couponCode,
}: {
  button: PreviewButton;
  couponCode?: string | null;
}) {
  const type = String(button["type"] ?? "QUICK_REPLY").toUpperCase();
  const Icon = BUTTON_ICON[type] ?? Reply;
  const label = String(button["text"] ?? "Button");
  const code =
    (type === "COPY_CODE" || type === "OTP") && couponCode ? couponCode : null;
  return (
    <div className="flex items-center justify-center gap-1.5 border-t border-border/60 py-2 text-[13px] font-medium text-primary">
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="truncate">{label}</span>
      {code ? (
        <span className="ml-1 rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] tracking-wide">
          {code}
        </span>
      ) : null}
    </div>
  );

}

function MediaBlock({
  format,
  mediaUrl,
  fileName,
  compact,
}: {
  format: HeaderFormat | "IMAGE" | "VIDEO";
  mediaUrl: string | null;
  fileName?: string | undefined;
  compact?: boolean;
}) {
  const label =
    format === "VIDEO" ? "Video" : format === "DOCUMENT" ? fileName || "Document.pdf" : "Image";
  const Icon = format === "VIDEO" ? PlaySquare : format === "DOCUMENT" ? FileText : ImageIcon;

  if (mediaUrl && format === "IMAGE") {
    return (
      <img
        src={mediaUrl}
        alt="Header image as the customer will see it"
        className={`w-full rounded-xl object-cover ${compact ? "h-24" : "h-40"}`}
        loading="lazy"
      />
    );
  }
  if (mediaUrl && format === "VIDEO") {
    return (
      <video
        src={mediaUrl}
        controls
        className={`w-full rounded-xl bg-black object-cover ${compact ? "h-24" : "h-40"}`}
      />
    );
  }
  return (
    <div
      className={`flex items-center justify-center gap-2 rounded-xl bg-muted text-xs text-muted-foreground ${
        compact ? "h-20" : "h-32"
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      <span className="truncate px-2">{label}</span>
    </div>
  );
}

/** Ticks down the same way the countdown on the customer's phone does. */
function OfferCountdown({ expiresAt }: { expiresAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return <>Ends in 11:59:00</>;
  const end = new Date(expiresAt).getTime();
  if (Number.isNaN(end)) return <>Ends in 11:59:00</>;
  const left = end - now;
  return <>{left > 0 ? `Ends in ${formatCountdown(left)}` : "Offer ended"}</>;
}

export function TemplatePreview({
  model,
  className = "",
}: {
  model: PreviewModel;
  className?: string;
}) {
  const { header, body, footer, buttons, cards, offer } = model;
  const couponCode = model.couponCode ?? null;


  return (
    <div className={`max-w-sm ${className}`}>
      <div className="overflow-hidden rounded-2xl rounded-bl-md border border-border/70 bg-card shadow-sm">
        <div className="space-y-2 px-3 pb-2 pt-3">
          {header?.format === "TEXT" && header.text ? (
            <p className="text-sm font-semibold leading-snug">{header.text}</p>
          ) : null}
          {header && (header.format === "IMAGE" || header.format === "VIDEO" || header.format === "DOCUMENT") ? (
            <MediaBlock format={header.format} mediaUrl={header.mediaUrl} fileName={header.fileName} />
          ) : null}
          {header?.format === "LOCATION" ? (
            <div className="flex h-24 items-center justify-center gap-2 rounded-xl bg-muted text-xs text-muted-foreground">
              <MapPin className="h-4 w-4" aria-hidden="true" />
              Map pin — the address is set when you send
            </div>
          ) : null}

          {offer ? (
            <div className="flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-2 text-xs font-medium text-primary">
              <Timer className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="truncate">{offer.text}</span>
              {offer.hasExpiration ? (
                <span className="ml-auto shrink-0 tabular-nums">
                  <OfferCountdown expiresAt={offer.expiresAt ?? null} />
                </span>
              ) : null}
            </div>
          ) : null}


          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {body || "Your message preview appears here."}
          </p>

          {footer ? <p className="text-[11px] text-muted-foreground">{footer}</p> : null}
        </div>

        {buttons.length > 0 ? (
          <div className="px-3 pb-1">
            {buttons.map((button, index) => (
              <ButtonRow key={index} button={button} couponCode={couponCode} />
            ))}
          </div>
        ) : null}
      </div>

      {cards.length > 0 ? (
        <div className="mt-2 flex snap-x gap-2 overflow-x-auto pb-2" aria-label="Carousel cards">
          {cards.map((card, index) => (
            <div
              key={index}
              className="w-44 shrink-0 snap-start overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm"
            >
              <div className="p-2">
                <MediaBlock format={card.format} mediaUrl={card.mediaUrl} compact />
                <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-xs leading-relaxed">
                  {card.body || `Card ${index + 1}`}
                </p>
              </div>
              {card.buttons.length > 0 ? (
                <div className="px-2 pb-1">
                  {card.buttons.map((button, i) => (
                    <ButtonRow
                      key={i}
                      button={button}
                      couponCode={card.couponCode ?? couponCode}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
