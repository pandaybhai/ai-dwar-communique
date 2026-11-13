import type { SupabaseClient } from "@supabase/supabase-js";
import {
  LEAD_STAGE_EVENTS,
  leadStageEventId,
  normalizeExternalId,
  type MetaEventName,
} from "@/lib/meta-events";

/**
 * Batch 77: a lead's sales stage goes back to Meta, so the ads learn which
 * leads became real customers — not just form fills.
 *
 * When a person changes a lead's status in Admin → Leads, the first time the
 * lead reaches a stage it sends ONE server event (Conversions API):
 *   contacted → LeadContacted · qualified → SalesQualifiedLead ·
 *   demo_booked → Schedule · won → LeadWon · new / lost → nothing.
 * event_id "<EventName>." + lead id; action_source "system_generated";
 * event_time = the change; custom_data { lead_source, sells, customers, stage }.
 *
 * Matching is the original Lead's: the lead's number and name hashed, the
 * SAME external_id (the lead id, demo_leads.meta_external_id), country, plus
 * the fbc / fbp stored from the lead's own visit (rememberLeadMatching). No IP
 * or user agent — none is stored, and this isn't the lead's own request.
 *
 * Once: demo_leads.meta_events_sent records each stage sent (shown in the
 * side sheet), and sendMetaEvent's own once-marker (activity_log
 * meta_event_sent) stops a resend even before 20261410 is applied.
 * Skipped (logged): no META_CAPI_TOKEN; the lead signed up and turned on
 * "Don't share my activity with Meta"; a test lead. Never throws.
 */

export type LeadStageSent = Record<string, { event: string; event_id: string; at: string }>;

export type StageOutcome =
  | "sent"
  | "already_sent"
  | "no_event"
  | "no_lead"
  | "test_lead"
  | "token_missing"
  | "opted_out"
  | "failed";

type StageLead = {
  id: string;
  phone: string;
  name: string | null;
  source: string;
  qualification: { sells?: string; customers?: string } | null;
  linked_user_id: string | null;
  is_test: boolean | null;
  meta_fbc?: string | null;
  meta_fbp?: string | null;
  meta_external_id?: string | null;
  meta_events_sent?: LeadStageSent | null;
};

/**
 * At /start or /demo submit: what the Lead was matched with, for the stage
 * events later — the fbc it used (the _fbc cookie, else built from the fbclid
 * the visitor arrived with), the _fbp cookie only when it existed (it is set
 * only after the cookie banner's Accept), and the external_id (the lead id).
 * Never the raw IP or user agent. A failed write never touches the lead.
 */
export async function rememberLeadMatching(
  supabase: SupabaseClient,
  leadId: string,
  facts: { fbc: string | null; fbp: string | null },
): Promise<void> {
  try {
    const { error } = await supabase
      .from("demo_leads")
      .update({
        meta_fbc: facts.fbc,
        meta_fbp: facts.fbp,
        meta_external_id: normalizeExternalId(leadId),
      })
      .eq("id", leadId)
      .is("meta_external_id", null);
    if (error) log({ stage: "remember_failed", lead: leadId, error: error.message });
  } catch (error) {
    log({
      stage: "remember_failed",
      lead: leadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function sendLeadStageEvent(
  supabase: SupabaseClient,
  leadId: string,
  status: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<StageOutcome> {
  try {
    const stage = typeof status === "string" ? status : "";
    const event: MetaEventName | undefined = LEAD_STAGE_EVENTS[stage];
    if (!event) return "no_event";

    const { data } = await supabase.from("demo_leads").select("*").eq("id", leadId).maybeSingle();
    const lead = (data as StageLead | null) ?? null;
    if (!lead) return "no_lead";
    if (lead.is_test) return "test_lead";
    const sent: LeadStageSent = { ...(lead.meta_events_sent ?? {}) };
    if (sent[stage]) return "already_sent";

    const { capiToken, loadPerson, sendMetaEvent } = await import("@/lib/meta-capi.server");
    if (!capiToken(env)) {
      log({ stage: "skipped", reason: "token_missing", event });
      return "token_missing";
    }
    // A lead who signed up and opted out of sharing with Meta: never.
    if (lead.linked_user_id) {
      const person = await loadPerson(supabase, lead.linked_user_id);
      if (person?.optedOut) {
        log({ stage: "skipped", reason: "opted_out", event });
        return "opted_out";
      }
    }

    const eventId = leadStageEventId(event, lead.id);
    const outcome = await sendMetaEvent(
      supabase,
      {
        event,
        eventId,
        params: {
          lead_source: lead.source,
          sells: lead.qualification?.sells,
          customers: lead.qualification?.customers,
          stage,
        },
        actionSource: "system_generated",
        once: true,
        lead: {
          phone: lead.phone,
          name: lead.name,
          // The original Lead's external_id (Batch 72 used the lead id).
          leadId: lead.meta_external_id || lead.id,
        },
        fbc: lead.meta_fbc ?? null,
        fbp: lead.meta_fbp ?? null,
      },
      env,
    );
    if (outcome === "sent" || outcome === "already_sent") {
      sent[stage] = { event, event_id: eventId, at: new Date().toISOString() };
      const { error } = await supabase
        .from("demo_leads")
        .update({ meta_events_sent: sent })
        .eq("id", lead.id);
      if (error) log({ stage: "record_failed", lead: lead.id, error: error.message });
      return outcome;
    }
    if (outcome === "token_missing" || outcome === "opted_out") return outcome;
    return "failed";
  } catch (error) {
    log({
      stage: "failed",
      lead: leadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

function log(detail: Record<string, unknown>): void {
  console.log(JSON.stringify({ scope: "lead_stage_event", ...detail }));
}
