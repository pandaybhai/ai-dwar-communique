/**
 * Batch 35: the WhatsApp business profile a customer sees (Meta Cloud API
 * /{phone-number-id}/whatsapp_business_profile) — the fields, Meta's limits
 * and the categories, shared by the Settings form and the server.
 */

export type BusinessProfile = {
  about: string;
  address: string;
  description: string;
  email: string;
  websites: string[];
  vertical: string;
  profile_picture_url: string | null;
};

export type DisplayNameStatus = {
  verified_name: string | null;
  /** Meta: APPROVED, DECLINED, PENDING_REVIEW, … — "The name_status field indicates its approval status." */
  name_status: string | null;
  new_display_name: string | null;
  new_name_status: string | null;
};

export type ProfilePatch = Partial<
  Pick<BusinessProfile, "about" | "address" | "description" | "email" | "websites" | "vertical">
>;

/** Meta's accepted vertical values, with the words WhatsApp shows for them. */
export const PROFILE_VERTICALS: Array<{ value: string; label: string }> = [
  { value: "", label: "Not set" },
  { value: "ALCOHOL", label: "Alcoholic Beverages" },
  { value: "APPAREL", label: "Clothing and Apparel" },
  { value: "AUTO", label: "Automotive" },
  { value: "BEAUTY", label: "Beauty, Spa, and Salon" },
  { value: "EDU", label: "Education" },
  { value: "ENTERTAIN", label: "Entertainment" },
  { value: "EVENT_PLAN", label: "Event Planning and Service" },
  { value: "FINANCE", label: "Finance and Banking" },
  { value: "GOVT", label: "Public Service" },
  { value: "GROCERY", label: "Food and Grocery" },
  { value: "HEALTH", label: "Medical and Health" },
  { value: "HOTEL", label: "Hotel and Lodging" },
  { value: "NONPROFIT", label: "Non-profit" },
  { value: "ONLINE_GAMBLING", label: "Online Gambling and Gaming" },
  { value: "OTC_DRUGS", label: "Over-the-Counter Drugs" },
  { value: "OTHER", label: "Other" },
  { value: "PHYSICAL_GAMBLING", label: "Non-Online Gambling and Gaming" },
  { value: "PROF_SERVICES", label: "Professional Services" },
  { value: "RESTAURANT", label: "Restaurant" },
  { value: "RETAIL", label: "Shopping and Retail" },
  { value: "TRAVEL", label: "Travel and Transportation" },
];

export const PROFILE_LIMITS = {
  about: 139,
  address: 256,
  description: 512,
  email: 128,
  website: 256,
  websites: 2,
};

/** Profile photo: JPG or PNG, at most 5 MB, cropped square and sent as 640 × 640. */
export const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PROFILE_PHOTO_SIZE = 640;
export const PROFILE_PHOTO_TYPES = ["image/jpeg", "image/png"];

/** Everything wrong with a profile change, in plain words (Meta's own limits). */
export function profileProblems(patch: ProfilePatch): string[] {
  const problems: string[] = [];
  if (patch.about !== undefined) {
    const about = patch.about.trim();
    if (!about) problems.push("About can't be empty — WhatsApp needs a line there.");
    else if (about.length > PROFILE_LIMITS.about)
      problems.push(`About can be ${PROFILE_LIMITS.about} characters at most.`);
  }
  if (patch.address !== undefined && patch.address.length > PROFILE_LIMITS.address) {
    problems.push(`The address can be ${PROFILE_LIMITS.address} characters at most.`);
  }
  if (patch.description !== undefined && patch.description.length > PROFILE_LIMITS.description) {
    problems.push(`The description can be ${PROFILE_LIMITS.description} characters at most.`);
  }
  if (patch.email !== undefined && patch.email.trim()) {
    const email = patch.email.trim();
    if (email.length > PROFILE_LIMITS.email)
      problems.push(`The email can be ${PROFILE_LIMITS.email} characters at most.`);
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      problems.push("That email address doesn't look right.");
  }
  if (patch.websites !== undefined) {
    const sites = patch.websites.map((w) => w.trim()).filter(Boolean);
    if (sites.length > PROFILE_LIMITS.websites) problems.push("WhatsApp shows at most 2 websites.");
    for (const site of sites) {
      if (!/^https?:\/\/\S+\.\S+/i.test(site))
        problems.push(`“${site.slice(0, 40)}” needs to start with http:// or https://.`);
      else if (site.length > PROFILE_LIMITS.website)
        problems.push(`A website can be ${PROFILE_LIMITS.website} characters at most.`);
    }
  }
  if (patch.vertical !== undefined && !PROFILE_VERTICALS.some((v) => v.value === patch.vertical)) {
    problems.push("Pick a category from the list.");
  }
  return problems;
}

/** "PENDING_REVIEW" → "Waiting for Meta's review", in the words the Settings card shows. */
export function nameStatusLabel(status: string | null | undefined): string {
  switch (String(status ?? "").toUpperCase()) {
    case "APPROVED":
      return "Approved";
    case "AVAILABLE_WITHOUT_REVIEW":
      return "Approved without review";
    case "PENDING_REVIEW":
      return "Waiting for Meta's review";
    case "DECLINED":
      return "Declined by Meta";
    case "EXPIRED":
      return "Expired";
    case "NONE":
    case "":
      return "Not reviewed";
    default:
      return String(status).replace(/_/g, " ").toLowerCase();
  }
}

/**
 * The square of the picture that becomes the profile photo: zoom 1 is the
 * largest square that fits, higher zooms a smaller one; x and y (0–1) slide it
 * across the picture. Pixel values for canvas drawImage.
 */
export function squareCropRect(
  width: number,
  height: number,
  zoom = 1,
  x = 0.5,
  y = 0.5,
): { sx: number; sy: number; size: number } {
  const side = Math.min(width, height) / Math.max(1, zoom);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return {
    sx: Math.round((width - side) * clamp(x)),
    sy: Math.round((height - side) * clamp(y)),
    size: Math.round(side),
  };
}
