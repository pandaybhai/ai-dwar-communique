import { aidwar } from "@/integrations/aidwar/client";

export type ActivityAction =
  | "user.logged_in"
  | "organization.created"
  | "organization.updated"
  | "member.invited"
  | "invitation.accepted"
  | "conversation_assigned"
  | "conversation_closed";

/**
 * Append-only activity logging. Never pass message contents or credentials —
 * actions and safe metadata only.
 */
export async function logActivity(
  action: ActivityAction,
  organizationId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { data } = await aidwar.auth.getUser();
    const uid = data.user?.id;
    if (!uid) return;
    await aidwar.from("activity_log").insert({
      action,
      organization_id: organizationId,
      user_id: uid,
      details,
    });
  } catch {
    // logging must never break a user action
  }
}
