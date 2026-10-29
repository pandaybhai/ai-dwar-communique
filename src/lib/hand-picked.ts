import type { SupabaseClient } from "@supabase/supabase-js";
import { handPickedFilters } from "@/lib/segments";

/**
 * Batch 51: "Send campaign" from the Customers bulk bar. The ticked customers
 * become a segment through the existing segment model: a segments row whose
 * one rule is "picked by hand" (field "list"), and its members in
 * segment_members (20261250). The campaign wizard then reads it like any
 * segment: its audience, opt-in filter, estimate and wallet checks are the
 * same. Opted-out customers are never saved into the list.
 */

const NOT_YET = "Sending to hand-picked customers isn't switched on for this workspace yet.";

export type HandPickedResult =
  { ok: true; segmentId: string; saved: number; optedOut: number } | { ok: false; error: string };

/** "Picked by hand, 12 customers, 29 Oct 14:05:31" — unique per workspace (segments name). */
export function handPickedName(count: number, now: Date, timezone?: string): string {
  const when = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(now);
  return `Picked by hand, ${count.toLocaleString("en-IN")} ${count === 1 ? "customer" : "customers"}, ${when}`;
}

/** The toast after saving: how many are in the list, and the opted-out left out. */
export function handPickedSummary(saved: number, optedOut: number): string {
  const kept = `${saved.toLocaleString("en-IN")} ${saved === 1 ? "customer" : "customers"} saved for this campaign.`;
  if (optedOut === 0) return kept;
  return `${kept} ${optedOut.toLocaleString("en-IN")} opted out and ${optedOut === 1 ? "was" : "were"} left out.`;
}

export async function saveHandPicked(
  db: SupabaseClient,
  args: {
    organizationId: string;
    userId: string | null;
    contactIds: string[];
    segmentId: string;
    now: Date;
    timezone?: string;
  },
): Promise<HandPickedResult> {
  const ids = Array.from(new Set(args.contactIds)).slice(0, 5000);
  if (ids.length === 0) return { ok: false, error: "Tick the customers to send to first." };

  // Fresh opt-in status for every ticked customer (they may be from other pages).
  const statuses = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db
      .from("contacts")
      .select("id, opt_in_status")
      .eq("organization_id", args.organizationId)
      .in("id", ids.slice(i, i + 200));
    if (error) return { ok: false, error: "We couldn't read these customers. Please try again." };
    for (const r of (data ?? []) as Array<{ id: string; opt_in_status: string }>)
      statuses.set(r.id, r.opt_in_status);
  }
  const found = ids.filter((id) => statuses.has(id));
  const keep = found.filter((id) => statuses.get(id) !== "opted_out");
  const optedOut = found.length - keep.length;
  if (keep.length === 0)
    return {
      ok: false,
      error:
        optedOut > 0
          ? "Everyone you ticked has opted out, so there is no one to send a campaign to."
          : "We couldn't find these customers. Please refresh and try again.",
    };

  // Before 20261250 there is no segment_members: say so before saving anything.
  const ready = await db
    .from("segment_members")
    .select("segment_id", { count: "exact", head: true })
    .limit(1);
  if (ready.error)
    return {
      ok: false,
      error:
        ready.error.code === "PGRST205" || ready.error.code === "42P01"
          ? NOT_YET
          : "We couldn't save these customers. Please try again.",
    };

  const { error: segError } = await db.from("segments").insert({
    id: args.segmentId,
    organization_id: args.organizationId,
    name: handPickedName(keep.length, args.now, args.timezone),
    description: "Picked by hand in Customers.",
    filters: handPickedFilters(args.segmentId),
    created_by: args.userId,
  });
  if (segError) return { ok: false, error: "We couldn't save these customers. Please try again." };

  for (let i = 0; i < keep.length; i += 500) {
    const { error } = await db.from("segment_members").insert(
      keep.slice(i, i + 500).map((contact_id) => ({
        segment_id: args.segmentId,
        contact_id,
        organization_id: args.organizationId,
        added_by: args.userId,
      })),
    );
    if (error) {
      // Never leave a half list behind (segment_members cascades from segments).
      await db
        .from("segments")
        .delete()
        .eq("id", args.segmentId)
        .eq("organization_id", args.organizationId);
      return {
        ok: false,
        error:
          error.code === "PGRST205" || error.code === "42P01"
            ? NOT_YET
            : "We couldn't save these customers. Please try again.",
      };
    }
  }
  return { ok: true, segmentId: args.segmentId, saved: keep.length, optedOut };
}
