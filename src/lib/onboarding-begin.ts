/**
 * Batch 78: step 1's one create path, for both choices — "Yes, here's my
 * website" and "I don't have a website — I'll tell Aiden on WhatsApp". The
 * workspace (and its trial) is created from the business name alone with
 * create_organization exactly as before; then the journey begins (a website
 * to read, or the no-website mark) and the WhatsApp setup session is
 * started (for no website its step is "no_site", so Aiden interviews).
 * Dependencies are passed in, so the order is tested without a browser.
 */

export type BeginInput = {
  name: string;
  url: string | null;
  about: string | null;
  brand: { logoUrl?: string | null; color?: string | null } | null;
  /** Batch 78: "I don't have a website — I'll tell Aiden on WhatsApp". */
  noWebsite?: boolean;
};

export type BeginDeps = {
  createOrganization: (name: string) => Promise<{ id: string | null; error: unknown }>;
  journey: (payload: Record<string, unknown>) => Promise<{ error?: string | null }>;
  startSession: (body: Record<string, unknown>) => Promise<unknown>;
  onCreated?: (orgId: string, name: string) => Promise<void> | void;
};

export async function beginBusiness(
  organizationId: string | null,
  input: BeginInput,
  deps: BeginDeps,
): Promise<{ ok: true; orgId: string; created: boolean } | { ok: false; error: string }> {
  let orgId = organizationId;
  const created = !orgId;
  if (!orgId) {
    const made = await deps.createOrganization(input.name);
    if (made.error || !made.id) {
      return { ok: false, error: "We couldn't create your workspace. Please try again." };
    }
    orgId = made.id;
    await deps.onCreated?.(orgId, input.name);
  }
  const noWebsite = input.noWebsite === true && !input.url;
  const begun = await deps.journey({
    action: "begin",
    organization_id: orgId,
    name: input.name,
    url: noWebsite ? null : input.url,
    about: noWebsite ? null : input.about,
    brand:
      input.brand && !noWebsite ? { logoUrl: input.brand.logoUrl, color: input.brand.color } : {},
    ...(noWebsite ? { no_website: true } : {}),
  });
  if (begun.error) return { ok: false, error: begun.error };
  await deps.startSession({ organization_id: orgId, no_website: noWebsite });
  return { ok: true, orgId, created };
}
