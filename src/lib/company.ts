/**
 * The business behind AiDwar, as shown on the public pages and the footer.
 * Every page reads it from here, so a detail changes in one place.
 * A field left as "" is not shown at all — a page omits that line.
 */
export type Company = {
  legalName: string;
  brand: string;
  email: string;
  city: string;
  registeredAddress: string;
  /** As displayed, e.g. "+91 79812 23192". */
  phone: string;
  /** For the tel: link, digits with the leading +, e.g. "+917981223192". */
  phoneTel: string;
  supportHours: string;
  gstin: string;
};

export const COMPANY: Company = {
  legalName: "Meezoy Ventures Private Limited",
  brand: "AiDwar",
  email: "support@aidwar.in",
  city: "Hyderabad, Telangana, India",
  registeredAddress: "3-3-303, Subric Street, Secunderabad, Telangana 500003, India",
  phone: "+91 79812 23192",
  phoneTel: "+917981223192",
  supportHours: "10:00 AM - 10:00 PM IST, all days",
  gstin: "",
};

/** True when a detail is set and should be shown. */
export function hasDetail(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** The tel: target for the phone: phoneTel when set, else the shown number without spaces. */
export function telHref(company: Company): string {
  const raw = hasDetail(company.phoneTel) ? company.phoneTel : company.phone;
  return `tel:${raw.replace(/[^\d+]/g, "")}`;
}
