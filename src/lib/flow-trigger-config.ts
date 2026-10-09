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

/**
 * Batch 28: an unpinned flow ("All numbers") starts on every number of its
 * workspace except the AiDwar setup (onboarding) number, where only flows
 * pinned to it run (dispatchInboundTriggers, onThisNumber). Said when such a
 * flow is saved in the workspace that owns that number; null elsewhere.
 */
export function unpinnedFlowNote(
  numbers: Array<{ label: string; onboarding: boolean }>,
  pinned: string | null | undefined,
): string | null {
  if (pinned) return null;
  const setup = numbers.find((n) => n.onboarding);
  if (!setup) return null;
  const others = numbers.filter((n) => !n.onboarding).length;
  return others > 0
    ? `“All numbers” runs this flow on your other numbers, but not on the AiDwar setup number (${setup.label}). To run it there, pick that number under Flow settings → Which number.`
    : `“All numbers” doesn't include the AiDwar setup number (${setup.label}), and this workspace has no other number — so this flow won't start anywhere. Pick that number under Flow settings → Which number.`;
}
