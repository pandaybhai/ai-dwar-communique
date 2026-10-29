import { FileText, MapPin, PlaySquare, Timer } from "lucide-react";
import type { ReactNode } from "react";
import { PhoneFrame } from "@/components/design-v2";
import type { PreviewButton, PreviewModel } from "@/components/templates/template-preview";
import { WhatsAppText } from "@/components/whatsapp-text";
import { cn } from "@/lib/utils";

/**
 * Batch 47: a template message drawn the way the preview draws it
 * (docs/design/preview.html #campaigns .phone): a white card on the dotted
 * wall with its picture, words and buttons. Fed the same PreviewModel as the
 * Batch 41 TemplatePreview (componentsToPreview / draftToPreview), so the
 * words and buttons are exactly the template's stored components.
 */
export function TemplatePhone({
  model,
  label = "Message preview",
  className,
  after,
}: {
  model: PreviewModel;
  label?: string;
  className?: string | undefined;
  /** Anything that follows the message on the customer's phone (a picture card). */
  after?: ReactNode;
}) {
  return (
    <PhoneFrame label={label} {...(className ? { className } : {})}>
      <TemplateMessage model={model} />
      {after ? <div className="mt-2">{after}</div> : null}
    </PhoneFrame>
  );
}

function buttonLabel(button: PreviewButton): string {
  const type = String(button["type"] ?? "").toUpperCase();
  const text = String(button["text"] ?? "").trim();
  if (text) return text;
  return type === "COPY_CODE" || type === "OTP" ? "Copy code" : "Button";
}

function Media({
  format,
  url,
  fileName,
  small,
}: {
  format: string;
  url: string | null;
  fileName?: string | undefined;
  small?: boolean;
}) {
  const h = small ? "h-24" : "h-[150px]";
  if (format === "IMAGE" && url) {
    return <img src={url} alt="" loading="lazy" className={cn("block w-full object-cover", h)} />;
  }
  if (format === "DOCUMENT") {
    return (
      <span className="flex items-center gap-2 border-b border-line bg-bubble-in px-2.5 py-3 text-sm font-semibold text-foreground">
        <FileText className="h-5 w-5 shrink-0 text-aiden-deep" aria-hidden="true" />
        <span className="truncate">{fileName || "Document.pdf"}</span>
      </span>
    );
  }
  if (format === "VIDEO") {
    return (
      <span
        className={cn("grid place-items-center bg-gradient-to-br from-av5-ink to-av1-ink", h)}
        aria-hidden="true"
      >
        <PlaySquare className="h-8 w-8 text-ink-foreground" />
      </span>
    );
  }
  // A picture the template takes at send time: the preview's gradient block.
  return (
    <span aria-hidden="true" className={cn("block bg-gradient-to-br from-av5-ink to-av1-ink", h)} />
  );
}

/** The message card itself, for a PhoneFrame or a gallery tile. */
export function TemplateMessage({ model }: { model: PreviewModel }) {
  const { header, body, footer, buttons, cards, offer } = model;
  const media = header && ["IMAGE", "VIDEO", "DOCUMENT"].includes(header.format);
  return (
    <>
      <div className="overflow-hidden rounded-[12px] bg-surface shadow-xs">
        {media && header ? (
          <Media format={header.format} url={header.mediaUrl} fileName={header.fileName} />
        ) : null}
        {header?.format === "LOCATION" ? (
          <span className="flex items-center gap-2 bg-bubble-in px-2.5 py-3 text-sm text-muted-foreground">
            <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
            Map pin, set when it sends
          </span>
        ) : null}
        {offer ? (
          <span className="flex items-center gap-2 border-b border-line px-2.5 py-2 text-sm font-semibold text-aiden-deep">
            <Timer className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{offer.text}</span>
          </span>
        ) : null}
        <div className="px-2.5 py-2 text-sm text-foreground">
          {header?.format === "TEXT" && header.text ? (
            <p className="m-0 mb-1 font-bold">{header.text}</p>
          ) : null}
          <p className="m-0 whitespace-pre-wrap break-words">
            {body ? <WhatsAppText text={body} /> : "Your message appears here."}
          </p>
          {footer ? (
            <p className="m-0 mt-1 text-[0.8125rem] text-muted-foreground">{footer}</p>
          ) : null}
        </div>
        {buttons.map((b, i) => (
          <span
            key={i}
            className="block border-t border-line p-[9px] text-center text-sm font-bold text-aiden-deep"
          >
            {buttonLabel(b)}
          </span>
        ))}
      </div>
      {cards.length > 0 ? (
        <div
          className="mt-2 flex snap-x gap-2 overflow-x-auto pb-1 [scrollbar-width:none]"
          aria-label="Carousel cards"
        >
          {cards.map((card, i) => (
            <div
              key={i}
              className="w-40 shrink-0 snap-start overflow-hidden rounded-[12px] bg-surface shadow-xs"
            >
              <Media format={card.format} url={card.mediaUrl} small />
              <p className="m-0 line-clamp-4 whitespace-pre-wrap break-words px-2.5 py-2 text-[0.8125rem] text-foreground">
                {card.body ? <WhatsAppText text={card.body} /> : `Card ${i + 1}`}
              </p>
              {card.buttons.map((b, j) => (
                <span
                  key={j}
                  className="block border-t border-line p-2 text-center text-[0.8125rem] font-bold text-aiden-deep"
                >
                  {buttonLabel(b)}
                </span>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
