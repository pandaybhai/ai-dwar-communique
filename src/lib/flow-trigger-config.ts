/** Flows v2 trigger config: cleaned and checked before it is saved. */

/**
 * `defaultMatch`: what a keyword trigger matches with when no mode is given.
 * New triggers default to "exact"; edits keep the historical "contains" so an
 * existing trigger never changes behaviour behind the owner's back.
 */
export function cleanConfig(kind: string, config: Record<string, unknown>, defaultMatch: "exact" | "contains" = "contains"): Record<string, unknown> {
  switch (kind) {
    case "keyword": {
      const keywords = ((config["keywords"] as string[] | undefined) ?? []).map((k) => String(k).trim()).filter(Boolean).slice(0, 20);
      const priority = Math.min(Math.max(Math.round(Number(config["priority"] ?? 0)) || 0, 0), 1000);
      return { keywords, match: ["exact", "contains", "starts_with"].includes(String(config["match"])) ? config["match"] : defaultMatch, priority };
    }
    case "store_event":
      return { event: String(config["event"] ?? "").trim() };
    case "form_submitted":
      return { form_id: config["form_id"] ? String(config["form_id"]) : null };
    case "tag_added":
      return { tag: String(config["tag"] ?? "").trim() };
    case "campaign_button":
      return {
        campaign_id: config["campaign_id"] ? String(config["campaign_id"]) : null,
        button: config["button"] ? String(config["button"]).trim() : null,
      };
    case "no_reply": {
      const days = Math.min(Math.max(Number(config["days"] ?? 3), 1), 90);
      return { days };
    }
    default:
      return {};
  }
}

export function configError(kind: string, config: Record<string, unknown>): string | null {
  if (kind === "keyword" && !((config["keywords"] as string[] | undefined) ?? []).length) return "Add at least one keyword.";
  if (kind === "store_event" && !config["event"]) return "Pick the store event.";
  if (kind === "tag_added" && !config["tag"]) return "Pick the tag.";
  return null;
}

/** A CSV import starts "tag added" flows only when it explicitly opts in. */
export function importStartsFlows(payload: Record<string, unknown>): boolean {
  return payload["start_flows"] === true;
}
