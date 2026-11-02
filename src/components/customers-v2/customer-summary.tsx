import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";
import { Skeleton } from "@/components/ui/skeleton";
import { consentLine } from "@/components/contacts/contact-drawer";
import { languageLabel } from "@/lib/languages";
import type { ContactRow } from "@/lib/contacts";
import { cn } from "@/lib/utils";
import {
  OPT_IN_CHIP,
  flowRunLabel,
  lastChatLabel,
  money,
  spentByContact,
  spentLabel,
} from "./customers-v2";
import { summaryCopy as t } from "./copy";

type Chat = {
  id: string;
  status: string | null;
  last_message_at: string | null;
  needs_human_question: string | null;
};
type Order = {
  id: string;
  order_number: string | null;
  total: number | string | null;
  currency: string | null;
  placed_at: string | null;
  cancelled_at: string | null;
};
type FlowRun = {
  id: string;
  status: string;
  started_at: string;
  flows: { name: string | null } | null;
};
type Consent = { opt_in_source: string | null; opted_in_at: string | null };

type Summary = {
  chat: Chat | null;
  language: string | null;
  orders: Order[] | null;
  runs: FlowRun[];
  consent: Consent | null;
};

/** One read that fails (a column not there yet, no permission) leaves its part empty. */
async function safe<T>(q: PromiseLike<{ data: unknown; error: unknown }>, fallback: T): Promise<T> {
  try {
    const { data, error } = await q;
    return error ? fallback : ((data as T) ?? fallback);
  } catch {
    return fallback;
  }
}

/**
 * Batch 48: what the drawer shows about a customer, read through the member's
 * own client (RLS): their newest chat (and a link straight to it), the shop's
 * orders (with integrations.view, as in the Inbox's customer panel), their
 * Flows v2 runs, the Batch 36 consent record and what Aiden knows (the
 * language they write in, a question waiting for you). Read only.
 */
function useCustomerSummary(
  organizationId: string,
  contact: ContactRow | null,
  canSeeOrders: boolean,
): Summary | null {
  const [summary, setSummary] = useState<Summary | null>(null);
  const contactId = contact?.id ?? null;
  useEffect(() => {
    setSummary(null);
    if (!contactId) return;
    let live = true;
    void (async () => {
      const [chat, orders, runs, consent] = await Promise.all([
        safe<Chat | null>(
          aidwar
            .from("conversations")
            .select("id, status, last_message_at, needs_human_question")
            .eq("organization_id", organizationId)
            .eq("contact_id", contactId)
            .order("last_message_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          null,
        ),
        canSeeOrders
          ? safe<Order[]>(
              aidwar
                .from("orders")
                .select("id, order_number, total, currency, placed_at, cancelled_at")
                .eq("organization_id", organizationId)
                .eq("contact_id", contactId)
                .order("placed_at", { ascending: false })
                .limit(200),
              [],
            )
          : Promise.resolve(null),
        safe<FlowRun[]>(
          aidwar
            .from("flow_runs")
            .select("id, status, started_at, flows(name)")
            .eq("organization_id", organizationId)
            .eq("contact_id", contactId)
            .order("started_at", { ascending: false })
            .limit(5),
          [],
        ),
        safe<Consent | null>(
          aidwar
            .from("contacts")
            .select("opt_in_source, opted_in_at")
            .eq("id", contactId)
            .maybeSingle(),
          null,
        ),
      ]);
      let language: string | null = null;
      if (chat?.id) {
        const last = await safe<{ detected_language: string | null } | null>(
          aidwar
            .from("messages")
            .select("detected_language")
            .eq("conversation_id", chat.id)
            .eq("direction", "inbound")
            .not("detected_language", "is", null)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          null,
        );
        const code = last?.detected_language ?? null;
        language = code ? (code === "hi-Latn" ? "Hinglish" : languageLabel(code)) : null;
      }
      if (live) setSummary({ chat, language, orders, runs, consent });
    })();
    return () => {
      live = false;
    };
  }, [organizationId, contactId, canSeeOrders]);
  return summary;
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-b border-line pb-4 last:border-b-0">
      <h3 className="m-0 font-display text-base font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[0.9375rem]">
      <dt className="min-w-0 text-muted-foreground">{label}</dt>
      <dd className="m-0 shrink-0 text-right">{children}</dd>
    </div>
  );
}

const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="m-0 text-[0.9375rem] text-muted-foreground">{children}</p>
);

const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : "";

export function CustomerSummary({
  organizationId,
  contact,
  canSeeOrders,
}: {
  organizationId: string;
  contact: ContactRow;
  canSeeOrders: boolean;
}) {
  const s = useCustomerSummary(organizationId, contact, canSeeOrders);
  const chip = OPT_IN_CHIP[contact.opt_in_status];

  if (!s) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label={t.loading}>
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-16 w-full rounded-2xl" />
      </div>
    );
  }

  const spent = spentLabel(
    spentByContact((s.orders ?? []).map((o) => ({ ...o, contact_id: contact.id })))[contact.id],
  );
  const consent = consentLine(s.consent);

  return (
    <div className="nd-rise flex flex-col gap-4 rounded-[20px] border border-line bg-surface p-4">
      <Block title={t.chat}>
        {s.chat ? (
          <>
            <Quiet>
              {t.lastMessage(lastChatLabel(s.chat.last_message_at), s.chat.status === "closed")}
            </Quiet>
            <Link
              to="/app/inbox"
              search={{ c: s.chat.id } as never}
              className="mt-1 inline-flex w-fit items-center gap-2 rounded-[11px] border border-line bg-surface px-3.5 py-2 text-sm font-semibold text-foreground transition-colors duration-200 hover:bg-ground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden phone:min-h-11"
            >
              <MessageSquare className="h-4 w-4" aria-hidden="true" />
              {t.openChat}
            </Link>
          </>
        ) : (
          <Quiet>{t.noChat}</Quiet>
        )}
      </Block>

      <Block title={t.consent}>
        <span
          className={cn(
            "w-fit rounded-full px-2.5 py-1 text-[0.8125rem] font-semibold",
            chip.className,
          )}
        >
          {chip.label}
        </span>
        <Quiet>
          {contact.opt_in_status === "opted_out"
            ? t.optedOut
            : contact.opt_in_status === "opted_in"
              ? (consent ?? t.optedInUnrecorded)
              : t.notAsked}
        </Quiet>
      </Block>

      <Block title={t.aiden}>
        {s.language || s.chat?.needs_human_question ? (
          <>
            {s.language ? <Quiet>{t.writesIn(s.language)}</Quiet> : null}
            {s.chat?.needs_human_question ? (
              <p className="m-0 text-[0.9375rem]">{t.asked(s.chat.needs_human_question)}</p>
            ) : null}
          </>
        ) : (
          <Quiet>{t.aidenNothing}</Quiet>
        )}
      </Block>

      {s.orders !== null ? (
        <Block title={t.orders}>
          {s.orders.length ? (
            <>
              <dl className="m-0 flex flex-col gap-1">
                {s.orders.slice(0, 5).map((o) => (
                  <Line
                    key={o.id}
                    label={t.order(o.order_number, o.placed_at ? day(o.placed_at) : "")}
                  >
                    <span
                      className={cn(
                        "tabular",
                        o.cancelled_at && "text-muted-foreground line-through",
                      )}
                    >
                      {o.total === null ? "" : money(Number(o.total), o.currency || "INR")}
                    </span>
                  </Line>
                ))}
              </dl>
              <Quiet>{t.spentOver(spent, s.orders.filter((o) => !o.cancelled_at).length)}</Quiet>
            </>
          ) : (
            <Quiet>{t.noOrders}</Quiet>
          )}
        </Block>
      ) : null}

      <Block title={t.flows}>
        {s.runs.length ? (
          <dl className="m-0 flex flex-col gap-1">
            {s.runs.map((r) => (
              <Line key={r.id} label={`${r.flows?.name || t.aFlow}, ${day(r.started_at)}`}>
                {flowRunLabel(r.status)}
              </Line>
            ))}
          </dl>
        ) : (
          <Quiet>{t.noFlows}</Quiet>
        )}
      </Block>
    </div>
  );
}
