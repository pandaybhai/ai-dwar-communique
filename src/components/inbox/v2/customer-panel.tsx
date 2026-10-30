import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, Copy, FileText, Image as ImageIcon, X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { aidwar } from "@/integrations/aidwar/client";
import { usePermissions } from "@/hooks/use-permissions";
import { OPT_IN_LABELS, type OptInStatus } from "@/lib/contacts";
import { languageLabel } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { SparkleChip } from "@/components/design-v2";
import { INBOX_COPY } from "./copy";
import { mediaKind, mediaLabel } from "../chat-thread";
import {
  contactLabel,
  relativeTime,
  type ConversationRow,
  type MemberRow,
  type MessageRow,
} from "../inbox-utils";
import { ToneAvatar } from "./chat-list";
import { windowChip } from "./inbox-v2";

/** The contact's labels (the classic panel's read); a failed read shows none. */
function useContactTags(organizationId: string | null, contactId: string | null) {
  const [tags, setTags] = useState<string[] | null>(null);
  const load = useCallback(async () => {
    if (!organizationId || !contactId) return setTags([]);
    try {
      const { data, error } = await aidwar
        .from("contact_tags")
        .select("tag_id, tags(id, name)")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId);
      if (error) return setTags([]);
      const names = (
        (data ?? []) as Array<{ tags: { name: string } | Array<{ name: string }> | null }>
      )
        .map((r) => (Array.isArray(r.tags) ? r.tags[0]?.name : r.tags?.name))
        .filter((n): n is string => Boolean(n));
      setTags(names);
    } catch {
      setTags([]);
    }
  }, [organizationId, contactId]);
  useEffect(() => {
    setTags(null);
    void load();
    const again = () => void load();
    window.addEventListener("aidwar:contact-tags-changed", again);
    return () => window.removeEventListener("aidwar:contact-tags-changed", again);
  }, [load]);
  return tags;
}

type OrderRow = {
  id: string;
  order_number: string | null;
  total: number | string | null;
  currency: string | null;
  placed_at: string | null;
};

/**
 * The contact's latest orders from the shop sync (public.orders, readable by
 * people with integrations.view (its RLS policy), indexed on organization +
 * contact). Without that permission the section isn't shown; no orders, no
 * shop or a failed read: the section says so and nothing breaks.
 */
function useContactOrders(
  organizationId: string | null,
  contactId: string | null,
  allowed: boolean,
) {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  useEffect(() => {
    setOrders(null);
    if (!allowed || !organizationId || !contactId) return setOrders([]);
    let live = true;
    void Promise.resolve(
      aidwar
        .from("orders")
        .select("id, order_number, total, currency, placed_at")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .order("placed_at", { ascending: false })
        .limit(5),
    )
      .then(({ data, error }) => {
        if (live) setOrders(error ? [] : ((data ?? []) as OrderRow[]));
      })
      .catch(() => live && setOrders([]));
    return () => {
      live = false;
    };
  }, [organizationId, contactId, allowed]);
  return orders;
}

/** Batch 57: the order was placed in the last 24 hours. */
function placedToday(placedAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!placedAt) return false;
  const t = new Date(placedAt).getTime();
  return Number.isFinite(t) && now - t >= 0 && now - t < 24 * 60 * 60_000;
}

/** Orders whose chip has sparkled in this tab already: the sparkle plays once per order. */
const SPARKLED = new Set<string>();

/**
 * Batch 57 (approved preview): a sale from a chat gets a small gold sparkle,
 * once. The chip stays; the sparkle never plays again for the same order.
 */
function NewOrderChip({ id, text }: { id: string; text: string }) {
  const [first] = useState(() => !SPARKLED.has(id));
  useEffect(() => {
    SPARKLED.add(id);
  }, [id]);
  return first ? (
    <SparkleChip className="mt-2 self-start">{text}</SparkleChip>
  ) : (
    <span className="mt-2 inline-flex self-start rounded-full bg-aiden-soft px-3.5 py-1.5 text-sm font-bold text-aiden-deep">
      {text}
    </span>
  );
}

/** An order's total in its own currency (Batch 20: prices follow each product's currency). */
function money(total: OrderRow["total"], currency: string | null): string {
  const n = Number(total);
  if (total === null || !Number.isFinite(n)) return "";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency ?? ""} ${n.toLocaleString("en-IN")}`.trim();
  }
}

function ago(iso: string): string {
  const r = relativeTime(iso);
  if (r === "now") return "Just now";
  return /^\d+[mhd]$/.test(r) ? `${r} ago` : r;
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex w-full flex-col gap-1.5">
      <h3 className="m-0 mt-3 font-display text-base font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-full items-baseline justify-between gap-3 text-[0.9375rem]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 text-right">{children}</dd>
    </div>
  );
}

/**
 * Batch 46: the customer panel beside a chat (inline from 1280px, a sheet
 * below). Display only: every change is made where it was before.
 */
export function CustomerPanel({
  conversation,
  members,
  messages,
  organizationId,
  numberLabel,
  onClose,
}: {
  conversation: ConversationRow;
  members: MemberRow[];
  messages: MessageRow[];
  organizationId: string | null;
  numberLabel: string | null;
  onClose?: () => void;
}) {
  const label = contactLabel(conversation.contact);
  const contactId = conversation.contact?.id ?? null;
  const tags = useContactTags(organizationId, contactId);
  const { can } = usePermissions();
  const canSeeOrders = can("integrations.view");
  const orders = useContactOrders(organizationId, contactId, canSeeOrders);
  const [copied, setCopied] = useState(false);
  const assignee = members.find((m) => m.user_id === conversation.assigned_to) ?? null;
  const optIn = (conversation.contact?.opt_in_status ?? "unknown") as OptInStatus;
  const optInText = OPT_IN_LABELS[optIn] ?? OPT_IN_LABELS.unknown;
  const chip = windowChip(conversation.last_customer_message_at);

  let language: string | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.direction === "inbound" && m.detected_language) {
      language =
        m.detected_language === "hi-Latn" ? "Hinglish" : languageLabel(m.detected_language);
      break;
    }
  }
  const media = messages
    .filter((m) => m.media_url && !m.metadata?.["media_removed_at"])
    .slice(-8)
    .reverse();

  const copyPhone = async () => {
    const phone = conversation.contact?.phone;
    if (!phone) return;
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: nothing to do.
    }
  };

  const jumpTo = (id: string) => {
    const el = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: "center" });
    onClose?.();
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-surface px-[18px] pb-6 pt-6">
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          className="-mr-2 -mt-2 grid h-9 w-9 shrink-0 place-items-center self-end rounded-full text-muted-foreground transition-colors duration-200 hover:bg-ground hover:text-foreground active:bg-accent"
          aria-label="Hide contact details"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
      <div className="flex flex-col items-start gap-2">
        <ToneAvatar
          seed={contactId ?? conversation.id}
          label={label}
          className="h-[72px] w-[72px] text-2xl"
        />
        <h2 className="m-0 max-w-full truncate text-lg font-bold">{label}</h2>
        {conversation.contact?.phone ? (
          <button
            type="button"
            onClick={() => void copyPhone()}
            className="group -ml-1.5 inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-muted-foreground transition-colors duration-200 hover:bg-ground hover:text-foreground active:bg-accent"
            aria-label={`Copy ${conversation.contact.phone}`}
          >
            <span className="tabular">{conversation.contact.phone}</span>
            {copied ? (
              <Check className="h-3.5 w-3.5 text-aiden-deep" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          {tags === null ? (
            <Skeleton className="h-6 w-20 rounded-full" />
          ) : (
            tags.map((t) => (
              <span
                key={t}
                className="rounded-full bg-gold-bg px-2.5 py-1 text-[0.8125rem] font-semibold text-gold-ink"
              >
                {t}
              </span>
            ))
          )}
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-[0.8125rem] font-semibold",
              optIn === "opted_in" && "bg-aiden-soft text-aiden-deep",
              optIn === "opted_out" && "bg-danger-soft text-danger-soft-foreground",
              optIn !== "opted_in" && optIn !== "opted_out" && "bg-bubble-in text-muted-foreground",
            )}
          >
            {optIn === "unknown" ? "Opt-in not known" : optInText}
          </span>
        </div>
        {tags !== null && tags.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">
            No labels yet. "Suggest labels" under the chat adds some.
          </p>
        ) : null}
      </div>

      <Block title="Aiden knows">
        {language || conversation.needs_human_question ? (
          <>
            {language ? <p className="m-0 text-[0.9375rem]">Writes in {language}.</p> : null}
            {conversation.needs_human_question ? (
              <p className="m-0 text-[0.9375rem]">Asked: “{conversation.needs_human_question}”</p>
            ) : null}
          </>
        ) : (
          <p className="m-0 text-[0.9375rem] text-muted-foreground">
            Nothing saved about this customer yet. "Catch me up" under the chat sums up this
            conversation.
          </p>
        )}
      </Block>

      <Block title="This chat">
        <dl className="m-0 flex w-full flex-col gap-1">
          <Line label="Status">{conversation.status === "closed" ? "Done" : "Open"}</Line>
          <Line label="With">
            {assignee
              ? assignee.full_name || assignee.email || "Team member"
              : conversation.needs_human
                ? "Waiting for you"
                : "Aiden"}
          </Line>
          <Line label="24-hour window">{chip.open ? chip.text : "Closed: templates only"}</Line>
          {conversation.last_customer_message_at ? (
            <Line label="Last message">{ago(conversation.last_customer_message_at)}</Line>
          ) : null}
          {conversation.needs_human && conversation.needs_human_at ? (
            <Line label="Waiting since">{ago(conversation.needs_human_at)}</Line>
          ) : null}
          {numberLabel ? <Line label="Number">{numberLabel}</Line> : null}
        </dl>
      </Block>

      {canSeeOrders ? (
        <Block title="Orders">
          {orders === null ? (
            <Skeleton className="h-5 w-40" />
          ) : orders.length ? (
            <>
              <dl className="m-0 flex w-full flex-col gap-1">
                {orders.map((o) => (
                  <Line key={o.id} label={o.order_number ? `Order ${o.order_number}` : "Order"}>
                    <span className="tabular">{money(o.total, o.currency)}</span>
                  </Line>
                ))}
              </dl>
              {orders[0] && placedToday(orders[0].placed_at) ? (
                <NewOrderChip
                  id={orders[0].id}
                  text={INBOX_COPY.orders.newToday(money(orders[0].total, orders[0].currency))}
                />
              ) : null}
            </>
          ) : (
            <p className="m-0 text-[0.9375rem] text-muted-foreground">
              No orders from your shop yet.
            </p>
          )}
        </Block>
      ) : null}

      <Block title="Media">
        {media.length ? (
          <ul className="m-0 flex w-full list-none flex-col gap-0.5 p-0">
            {media.map((m) => {
              const kind = mediaKind(m);
              const name =
                typeof m.metadata?.["document_filename"] === "string"
                  ? (m.metadata["document_filename"] as string)
                  : mediaLabel(m);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => jumpTo(m.id)}
                    className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2.5 rounded-[11px] px-2 py-1.5 text-left text-[0.9375rem] transition-colors duration-200 hover:bg-ground active:bg-accent"
                  >
                    {kind === "image" ? (
                      <ImageIcon
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    ) : (
                      <FileText
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <span className="shrink-0 text-[0.8125rem] text-muted-foreground">
                      {relativeTime(m.created_at)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="m-0 text-[0.9375rem] text-muted-foreground">
            No photos or files in this chat.
          </p>
        )}
      </Block>
    </div>
  );
}
