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
