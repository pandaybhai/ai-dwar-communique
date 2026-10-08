import type { SenderContext } from "@/lib/campaigns.server";
import type { GraphAnswer } from "@/lib/campaign-dispatch.server";
import { MemoryDb } from "./campaign-memory-db";

/**
 * Test-only: a workspace (or several) with a number, its token, a template,
 * contacts and a running campaign each, in a MemoryDb with the production
 * RPCs written in JS; and a fake Graph send that records what Meta got.
 */
export type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export function world(spec: {
  campaigns: Array<{
    recipients: number;
    status?: string;
    total?: number;
    estimatedCost?: number;
    scheduledAt?: string;
  }>;
  billing?: boolean;
}) {
  const db = new MemoryDb();
  // Recipients are queued an hour before the test clock, in order: inside
  // every look-back window (the 7-day reply window) on any day the suite runs.
  const queuedAt = Date.now() - 3_600_000;
  db.embeds.set("campaign_recipients.messages", {
    table: "messages",
    local: "message_id",
    remote: "id",
  });
  db.embeds.set("messages.conversations", {
    table: "conversations",
    local: "conversation_id",
    remote: "id",
  });
  db.embeds.set("contacts.conversations", { table: "conversations", local: "id", remote: "contact_id", many: true });
  db.embeds.set("campaigns.organizations", {
    table: "organizations",
    local: "organization_id",
    remote: "id",
  });

  db.rpcs.set("claim_campaign_recipients", (a, d) => {
    const rows = d
      .rows("campaign_recipients")
      .filter((r) => r["campaign_id"] === a["p_campaign_id"] && r["status"] === "queued")
      .sort((x, y) => String(x["created_at"]).localeCompare(String(y["created_at"])))
      .slice(0, Number(a["p_limit"]));
    for (const r of rows) {
      r["status"] = "sending";
      r["updated_at"] = now();
    }
    return rows.map((r) => ({
      id: r["id"],
      contact_id: r["contact_id"],
      phone: r["phone"],
      resolved_variables: r["resolved_variables"],
    }));
  });
  db.rpcs.set("bump_campaign_counters", (a, d) => {
    const c = d.rows("campaigns").find((r) => r["id"] === a["p_campaign_id"]);
    if (!c) return null;
    for (const k of ["sent", "delivered", "read", "failed", "replied"]) {
      c[`${k}_count`] = Number(c[`${k}_count`] ?? 0) + Number(a[`p_${k}`] ?? 0);
    }
    return null;
  });
  db.rpcs.set("org_flag_enabled", () => spec.billing ?? false);
  db.rpcs.set("price_message", () => true);
  db.rpcs.set(
    "wallet_apply",
    (a, d) =>
      d.insert("wallet_ledger", {
        organization_id: a["p_org"],
        entry_type: a["p_type"],
        amount: a["p_amount"],
        reference_id: a["p_ref_id"],
        metadata: a["p_metadata"],
      })["id"],
  );
  db.rpcs.set("campaign_ledger_charge", (a, d) =>
    d
      .rows("wallet_ledger")
      .filter(
        (r) =>
          r["entry_type"] === "debit_message" &&
          (r["metadata"] as Row)?.["campaign_id"] === a["p_campaign_id"],
      )
      .reduce((s, r) => s + Math.abs(Number(r["amount"])), 0),
  );
  db.rpcs.set("campaign_recipient_status", (a, d) => {
    const r = d
      .rows("campaign_recipients")
      .find((x) =>
        a["p_recipient_id"]
          ? x["id"] === a["p_recipient_id"]
          : x["message_id"] === a["p_message_id"],
      );
    if (!r) return "none";
    const bump = (k: string, n = 1) => {
      const c = d.rows("campaigns").find((x) => x["id"] === r["campaign_id"])!;
      c[`${k}_count`] = Number(c[`${k}_count`] ?? 0) + n;
    };
    const prev = String(r["status"]);
    const setMsg = () => {
      if (a["p_recipient_id"]) r["message_id"] = a["p_message_id"];
    };
    const below = ["queued", "sending", "sent", "skipped"];
    switch (a["p_status"]) {
      case "failed":
        if (prev === "failed") return "noop";
        r["status"] = "failed";
        r["error"] = String(a["p_error"] ?? "Delivery failed").slice(0, 300);
        setMsg();
        bump("failed");
        return "applied";
      case "sent":
        if (!["queued", "sending", "skipped"].includes(prev)) return "noop";
        r["status"] = "sent";
        setMsg();
        return "applied";
      case "delivered":
        if (!below.includes(prev)) return "noop";
        r["status"] = "delivered";
        setMsg();
        bump("delivered");
        return "applied";
      case "read":
        if (below.includes(prev)) {
          r["status"] = "read";
          setMsg();
          bump("read");
          bump("delivered");
          return "applied";
        }
        if (prev === "delivered") {
          r["status"] = "read";
          setMsg();
          bump("read");
          return "applied";
        }
        return "noop";
    }
    return "noop";
  });

  const campaigns: Array<{
    id: string;
    orgId: string;
    accountId: string;
    pn: string;
    recipients: Row[];
  }> = [];
  // phone_number_id is globally unique in real life; caches key on it.
  const uniq = crypto.randomUUID().slice(0, 8);
  spec.campaigns.forEach((c, i) => {
    const org = db.insert("organizations", { name: `Store ${i + 1}` });
    const account = db.insert("whatsapp_accounts", {
      organization_id: org["id"],
      waba_id: `waba-${i}`,
      phone_number_id: `pn-${uniq}-${i}`,
      display_phone_number: `9180000${i}`,
      status: "active",
      is_default: true,
    });
    db.insert("whatsapp_credentials", {
      organization_id: org["id"],
      waba_id: `waba-${i}`,
      access_token: `tok-${i}`,
    });
    db.insert("message_templates", {
      organization_id: org["id"],
      waba_id: `waba-${i}`,
      name: "promo",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Hi {{1}}, the sale is on" }],
    });
    const campaign = db.insert("campaigns", {
      organization_id: org["id"],
      whatsapp_account_id: account["id"],
      name: `Campaign ${i + 1}`,
      status: c.status ?? "sending",
      template_name: "promo",
      template_language: "en",
      send_settings: {},
      scheduled_at: c.scheduledAt ?? null,
      started_at: c.status === "scheduled" ? null : now(),
      completed_at: null,
      total_recipients: c.total ?? c.recipients,
      estimated_cost: c.estimatedCost ?? null,
      held_amount: 0,
      charged_amount: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      failed_count: 0,
      replied_count: 0,
      updated_at: now(),
    });
    const recipients: Row[] = [];
    for (let n = 0; n < c.recipients; n++) {
      const contact = db.insert("contacts", {
        organization_id: org["id"],
        phone: `+9198${String(i).padStart(2, "0")}${String(n).padStart(6, "0")}`,
        name: `Customer ${n}`,
        opt_in_status: "opted_in",
      });
      recipients.push(
        db.insert("campaign_recipients", {
          campaign_id: campaign["id"],
          organization_id: org["id"],
          contact_id: contact["id"],
          phone: contact["phone"],
          resolved_variables: { "1": contact["name"] },
          status: "queued",
          created_at: new Date(queuedAt + n).toISOString(),
          updated_at: now(),
        }),
      );
    }
    campaigns.push({
      id: campaign["id"] as string,
      orgId: org["id"] as string,
      accountId: account["id"] as string,
      pn: `pn-${uniq}-${i}`,
      recipients,
    });
  });
  return { db, campaigns };
}

export type Send = {
  at: number;
  pn: string;
  to: string;
  tag: string;
  body: Record<string, unknown>;
};

export function meta(
  behaviour?: (send: Send, n: number) => GraphAnswer | null | Promise<GraphAnswer | null>,
  latencyMs = 0,
) {
  const sends: Send[] = [];
  let n = 0;
  const postMessage = async (sender: SenderContext, body: Record<string, unknown>) => {
    const send = {
      at: Date.now(),
      pn: sender.phoneNumberId,
      to: String(body["to"]),
      tag: String(body["biz_opaque_callback_data"]),
      body,
    };
    n += 1;
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
    const custom = await behaviour?.(send, n);
    if (custom) return custom;
    sends.push(send);
    return {
      kind: "response",
      ok: true,
      status: 200,
      body: { messages: [{ id: `wamid.${n}.${Math.random().toString(36).slice(2)}` }] },
    } as GraphAnswer;
  };
  return { sends, postMessage, tries: () => n };
}
