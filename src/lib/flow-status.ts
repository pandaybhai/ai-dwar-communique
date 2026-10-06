/**
 * The status chip on a chat flow (Flows list and editor). A flow is switched
 * on and off with flows.is_enabled; "published" means it has a published
 * version. A published flow that is switched off starts nothing, so it says
 * "Off" rather than "Published".
 *
 * `published` null = not known (the versions read failed): the chip then
 * reads exactly as it did before this existed (is_enabled → "Published").
 */
export type FlowStatus = "Published" | "Off" | "Draft";

export function flowStatus(isEnabled: boolean, published: boolean | null): FlowStatus {
  if (isEnabled) return "Published";
  if (published === null) return "Draft";
  return published ? "Off" : "Draft";
}
