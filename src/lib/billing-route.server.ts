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
 * Credits only work alongside a live plan. Anything that puts money into the
 * wallet from the customer side goes through here first. Super-admin manual
 * credits from /admin never touch this.
 */
export async function requireActivePlan(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Response | null> {
  const { data } = await supabase
    .from("organizations")
    .select("plan_status")
    .eq("id", organizationId)
    .maybeSingle();
  const status = (data as { plan_status?: string | null } | null)?.plan_status ?? null;
  if (status === "active") return null;
  return Response.json(
    { error: "Pick a plan first — credits only work with an active plan." },
    { status: 409 },
  );
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
