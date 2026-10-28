import type { ReactNode } from "react";
import { ChevronLeft, Copy, ExternalLink, FileText, Phone, Reply, Video } from "lucide-react";
import { componentsToPreview, type PreviewModel } from "@/components/templates/template-preview";
import { WhatsAppText } from "@/components/whatsapp-text";
import type { TemplateComponent } from "@/lib/templates";

/**
 * Batch 38 item 9: the message as the customer sees it on WhatsApp — a phone
 * with the business's chat, the bubble rendered from the template's real
 * components (header file / picture / text, *bold* _italic_ ~strike~ body,
 * footer, buttons) and its delivery ticks. Used by the docs (the hero and
 * every send endpoint) and by the Try it console.
 */

export type DeliveryStatus = "pending" | "sent" | "delivered" | "read";

export type PhoneMessage =
  | {
      kind: "template";
      components: Array<Record<string, unknown>>;
      params: string[];
      fileName?: string;
      mediaUrl?: string | null;
    }
  | { kind: "text"; text: string };

export function previewModel(message: PhoneMessage): PreviewModel {
  if (message.kind === "text")
    return { header: null, body: message.text, footer: "", buttons: [], cards: [], offer: null };
  const values: Record<number, string> = {};
  message.params.forEach((v, i) => (values[i + 1] = v));
  const model = componentsToPreview(message.components as unknown as TemplateComponent[], values);
  if (model.header && (message.fileName || message.mediaUrl))
    model.header = {
      ...model.header,
      ...(message.fileName ? { fileName: message.fileName } : {}),
      ...(message.mediaUrl ? { mediaUrl: message.mediaUrl } : {}),
    };
  return model;
}

export function Ticks({ status }: { status: DeliveryStatus }) {
  if (status === "pending")
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-label="Sending" role="img">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M8 4.8V8l2.2 1.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  const read = status === "read";
  return (
    <svg
      viewBox="0 0 18 12"
      className="wa-tick h-3 w-4"
      style={{ color: read ? "var(--wa-tick-read)" : "var(--wa-meta)" }}
      role="img"
      aria-label={status === "sent" ? "Sent" : status === "delivered" ? "Delivered" : "Read"}
    >
      <path
        d="M1 6.5l3.2 3.2L11 2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {status !== "sent" ? (
        <path
          d="M7.2 9.7l.6.6L14.8 2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}

const BUTTON_ICON: Record<string, typeof Reply> = {
  URL: ExternalLink,
  PHONE_NUMBER: Phone,
  COPY_CODE: Copy,
  OTP: Copy,
  QUICK_REPLY: Reply,
};

function Header({ model }: { model: PreviewModel }) {
  const h = model.header;
  if (!h) return null;
  if (h.format === "TEXT")
    return h.text ? <p className="px-1 pb-1 text-[14.5px] font-semibold">{h.text}</p> : null;
  if (h.format === "DOCUMENT")
    return (
      <div className="mb-1 flex items-center gap-2.5 rounded-md bg-[var(--wa-doc)] p-2.5">
        <span className="grid h-9 w-8 place-items-center rounded bg-[#c8372b] text-[9px] font-bold text-white">
          PDF
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-medium">
            {h.fileName || "Document.pdf"}
          </span>
          <span className="block text-[11.5px] text-[var(--wa-meta)]">1 page · PDF</span>
        </span>
      </div>
    );
  if (h.format === "IMAGE" && h.mediaUrl)
    return (
      <img
        src={h.mediaUrl}
        alt=""
        className="mb-1 h-36 w-full rounded-md object-cover"
        loading="lazy"
      />
    );
  if (h.format === "IMAGE")
    return (
      <div
        aria-hidden="true"
        className="mb-1 grid h-36 place-items-center rounded-md text-5xl"
        style={{ background: "linear-gradient(135deg, oklch(0.86 0.08 162), oklch(0.78 0.1 200))" }}
      >
        📦
      </div>
    );
  if (h.format === "VIDEO")
    return (
      <div
        aria-hidden="true"
        className="mb-1 grid h-36 place-items-center rounded-md bg-black/70 text-white"
      >
        <Video className="h-8 w-8" />
      </div>
    );
  return null;
}

/** The bubble alone (what lands in the chat). */
export function MessageBubble({
  model,
  status,
  time = "10:00",
}: {
  model: PreviewModel;
  status: DeliveryStatus | null;
  time?: string;
}) {
  return (
    <div className="max-w-[86%]">
      <div className="wa-bubble px-1.5 pb-1 pt-1.5">
        <Header model={model} />
        <p className="whitespace-pre-wrap break-words px-1 text-[14.2px] leading-[1.36]">
          <WhatsAppText text={model.body || "…"} />
        </p>
        {model.footer ? (
          <p className="px-1 pt-0.5 text-[12.5px] text-[var(--wa-meta)]">{model.footer}</p>
        ) : null}
        <div className="flex items-center justify-end gap-1 px-1 text-[11px] text-[var(--wa-meta)]">
          <span>{time}</span>
          {status ? <Ticks status={status} /> : null}
        </div>
      </div>
      {model.buttons.length ? (
        <div className="mt-[3px] grid gap-[3px]">
          {model.buttons.map((b, i) => {
            const type = String(b["type"] ?? "QUICK_REPLY").toUpperCase();
            const Icon = BUTTON_ICON[type] ?? Reply;
            return (
              <div
                key={i}
                className="wa-button flex items-center justify-center gap-1.5 rounded-[10px] py-2 text-[14px] font-medium"
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {String(b["text"] ?? "Button")}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** A message the customer typed: right-hand, WhatsApp's own green (Batch 40). */
export function CustomerBubble({ text, time = "10:00" }: { text: string; time?: string }) {
  return (
    <div className="ml-auto max-w-[82%]">
      <div className="wa-bubble-out px-2.5 pb-1 pt-1.5">
        <p className="whitespace-pre-wrap break-words text-[14.2px] leading-[1.36]">{text}</p>
        <div className="flex items-center justify-end gap-1 text-[11px] text-[var(--wa-meta)]">
          <span>{time}</span>
          <Ticks status="read" />
        </div>
      </div>
    </div>
  );
}

/** The business is typing (Batch 40). */
export function TypingBubble({ label = "Typing" }: { label?: string }) {
  return (
    <div className="max-w-[40%]">
      <div className="wa-bubble wa-typing flex items-center gap-1 px-3 py-2.5" role="status" aria-label={label}>
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

/** A phone with the business's chat; `children` is the chat's content. */
export function PhoneFrame({
  business = "AiDwar Store",
  children,
  label = "The message on the customer's WhatsApp",
  compact = false,
  composer,
  avatar,
  live = false,
}: {
  business?: string;
  children: ReactNode;
  label?: string;
  /** As tall as the message needs, not a whole phone screen. */
  compact?: boolean;
  /** Batch 40: a real message box in place of the drawn one. */
  composer?: ReactNode;
  /** Batch 40: the business's own picture in the chat header. */
  avatar?: ReactNode;
  /** Batch 40: a chat that grows — scrolls, and is announced as it changes. */
  live?: boolean;
}) {
  return (
    <figure
      className={`wa-phone mx-auto shrink-0 ${compact ? "wa-phone-compact" : ""}`}
      aria-label={label}
    >
      <div className="wa-screen">
        <div className="flex items-center justify-between bg-[var(--wa-head)] px-6 pb-1 pt-3 text-[11px] font-semibold text-white">
          <span>10:00</span>
          <span className="h-4 w-16 rounded-full bg-black/60" aria-hidden="true" />
          <span aria-hidden="true">●●● 5G</span>
        </div>
        <div className="flex items-center gap-2 bg-[var(--wa-head)] px-2.5 pb-2.5 pt-1 text-white">
          <ChevronLeft className="h-5 w-5 opacity-90" aria-hidden="true" />
          {avatar ?? (
            <span className="grid h-8 w-8 place-items-center rounded-full bg-white/90 text-[13px] font-bold text-[#008069]">
              A
            </span>
          )}
          <span className="min-w-0 leading-tight">
            <span className="flex items-center gap-1 text-[14.5px] font-semibold">
              {business}
              <svg
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5"
                aria-label="Verified business"
                role="img"
              >
                <circle cx="8" cy="8" r="8" fill="#25d366" />
                <path
                  d="M4.5 8.2l2.2 2.1 4.8-4.8"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="block text-[11.5px]">Business account</span>
          </span>
        </div>
        <div
          className={`wa-wall flex flex-1 flex-col gap-2 px-3 py-3 ${live ? "min-h-0 overflow-y-auto" : "justify-end overflow-hidden"}`}
          {...(live ? { role: "log", "aria-live": "polite" as const, "aria-label": `Chat with ${business}` } : {})}
        >
          <div className={`mx-auto mb-1 rounded-md bg-[var(--wa-bubble)] px-2.5 py-1 text-[11.5px] text-[var(--wa-meta)] shadow-sm ${live ? "mt-auto" : ""}`}>
            Today
          </div>
          {children}
        </div>
        {composer ?? (
          <div
            className="flex items-center gap-2 bg-[var(--wa-wall)] px-2 pb-4 pt-1"
            aria-hidden="true"
          >
            <div className="h-9 flex-1 rounded-full bg-[var(--wa-bubble)] px-4 text-[13px] leading-9 text-[var(--wa-meta)]">
              Message
            </div>
            <div className="grid h-9 w-9 place-items-center rounded-full bg-[#00a884] text-white">
              🎤
            </div>
          </div>
        )}
      </div>
    </figure>
  );
}

/** The phone with one message in it. */
export function WhatsAppPhone({
  message,
  status = "read",
  landed = true,
  compact = false,
}: {
  message: PhoneMessage;
  status?: DeliveryStatus | null;
  landed?: boolean;
  compact?: boolean;
}) {
  return (
    <PhoneFrame compact={compact}>
      <div className={`wa-landing ${landed ? "wa-landed" : ""}`}>
        <MessageBubble model={previewModel(message)} status={status} />
      </div>
    </PhoneFrame>
  );
}
