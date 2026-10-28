import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Shared plumbing for the billing HTTP surfaces: one place that turns a
 * permission failure into a 403 and a switched-off billing flag into a 404,
 * so every money route answers the same way.
 */
export async function billingGate(
  supabase: Parameters<typeof import("@/lib/billing.server")["billingEnabled"]>[0],
  organizationId: string,
): Promise<Response | null> {
  const { billingEnabled } = await import("@/lib/billing.server");
  if (!(await billingEnabled(supabase, organizationId))) {
    return Response.json({ error: "Billing isn't switched on for this workspace." }, { status: 404 });
  }
  return null;
}

/**
 * Anything that puts money into the wallet from the customer side goes
 * through here first. Batch 35: trial (even before a plan is bought), active,
 * past due and paused workspaces may buy credits; only locked and cancelled
 * must pick a plan first (creditPurchaseBlock). Super-admin manual credits
 * from /admin never touch this.
 */
export async function requireActivePlan(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Response | null> {
  const { data, error } = await supabase
    .from("organizations")
    .select("plan_status")
    .eq("id", organizationId)
    .maybeSingle();
  if (error || !data) {
    return Response.json({ error: "We couldn't read this workspace. Try again." }, { status: 503 });
  }
  const { creditPurchaseBlock } = await import("@/lib/billing");
  const block = creditPurchaseBlock((data as { plan_status?: string | null }).plan_status);
  return block ? Response.json({ error: block }, { status: 409 }) : null;
}

export async function billingError(error: unknown): Promise<Response> {
  const { isPermissionError } = await import("@/lib/billing.server");
  if (isPermissionError(error)) {
    return Response.json({ error: error.message }, { status: 403 });
  }
  return Response.json(
    { error: "Something went wrong on our side. Please try again." },
    { status: 500 },
  );
}
