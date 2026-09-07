/**
 * Official GST state codes (as published with the GSTIN scheme), including the
 * union territories and the two special codes used on invoices where the place
 * of supply is not an Indian state.
 */
export type GstState = { code: string; name: string };

export const GST_STATES: GstState[] = [
  { code: "01", name: "Jammu & Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "25", name: "Daman & Diu (old)" },
  { code: "26", name: "Dadra & Nagar Haveli and Daman & Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "28", name: "Andhra Pradesh (old)" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman & Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "97", name: "Other Territory" },
  { code: "99", name: "Centre Jurisdiction" },
];

export const gstStateName = (code: string | null | undefined): string =>
  GST_STATES.find((s) => s.code === code)?.name ?? code ?? "";

/**
 * A GSTIN carries its state in the first two digits. Disagreement is worth a
 * warning, never a block — old numbers and edge cases exist.
 */
export function gstinStateMismatch(
  gstin: string | null | undefined,
  stateCode: string | null | undefined,
): string | null {
  const g = (gstin ?? "").trim().toUpperCase();
  if (g.length < 2 || !stateCode) return null;
  const prefix = g.slice(0, 2);
  if (!/^\d{2}$/.test(prefix)) return null;
  if (prefix === stateCode) return null;
  const named = gstStateName(prefix);
  return `This GSTIN starts with ${prefix}${named ? ` (${named})` : ""}, but the state chosen is ${
    gstStateName(stateCode) || stateCode
  }. Double-check before saving.`;
}
