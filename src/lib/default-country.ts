import { DEFAULT_COUNTRY_CODE, enteredPhone, isCountryCode, typedPhone } from "@/lib/phone";

/**
 * Batch 66: a workspace's default country code (organizations.default_country_code,
 * 20261360), from one read of the row. The code works without 20261360: a
 * missing column reads as "91", the column's own default for every row once
 * it is applied, and so does a missing or empty value. Any other failed read
 * is an error — never a guess — so a number needing the code is not saved or
 * sent until the code can be read.
 */
export type DefaultCountry = { code: string } | { error: string };

export const DEFAULT_COUNTRY_READ_ERROR =
  "We couldn't read this workspace's default country code. Please try again.";

/** True when the error is "column default_country_code doesn't exist" (20261360 not applied). */
export function countryColumnMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /default_country_code/.test(String(error.message ?? ""))
  );
}

export function defaultCountryFrom(read: {
  data: unknown;
  error: { code?: string; message?: string } | null;
}): DefaultCountry {
  if (read.error)
    return countryColumnMissing(read.error)
      ? { code: DEFAULT_COUNTRY_CODE }
      : { error: DEFAULT_COUNTRY_READ_ERROR };
  const value = (read.data as { default_country_code?: unknown } | null)?.default_country_code;
  return { code: isCountryCode(value) ? value : DEFAULT_COUNTRY_CODE };
}

type Reader = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (
        col: string,
        value: string,
      ) => {
        maybeSingle: () => PromiseLike<{
          data: unknown;
          error: { code?: string; message?: string } | null;
        }>;
      };
    };
  };
};

/** One read of the workspace's code, with any client (the member's own in the browser, the service client on the server). */
export async function loadDefaultCountryCode(
  client: unknown,
  organizationId: string,
): Promise<DefaultCountry> {
  try {
    const read = await (client as Reader)
      .from("organizations")
      .select("default_country_code")
      .eq("id", organizationId)
      .maybeSingle();
    return defaultCountryFrom(read);
  } catch {
    return { error: DEFAULT_COUNTRY_READ_ERROR };
  }
}

/**
 * Batch 69: a number typed into a form for this workspace, through the one
 * rule (typedPhone). The workspace's code is read only when the number needs
 * it, so a number that already has its country code is stored exactly as
 * before, without a read. A failed read refuses the number (never a guess).
 */
export async function workspaceTypedPhone(
  client: unknown,
  organizationId: string,
  typed: unknown,
): Promise<{ phone: string; addedCountry: boolean } | { error: string }> {
  const first = enteredPhone(typed, null);
  if (first.ok || first.problem !== "needs_country") return typedPhone(typed, null);
  const code = await loadDefaultCountryCode(client, organizationId);
  if ("error" in code) return { error: code.error };
  return typedPhone(typed, code.code);
}
