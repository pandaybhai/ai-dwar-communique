import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { emitClientEvent } from "@/lib/events-capture";
import { callApi } from "@/lib/whatsapp-client";

/**
 * Assigning a chat to a teammate (or nobody): the Inbox's own action, moved
 * here in Batch 45 so Home's waiting queue assigns exactly the same way — one
 * update of conversations.assigned_to under the member's RLS, the activity
 * log and the client event. Says how it went in a toast; true when saved.
 */
export async function assignConversation(
  organizationId: string,
  conversation: { id: string; whatsapp_account_id?: string | null },
  assignee: string | null,
): Promise<boolean> {
  const { error } = await aidwar
    .from("conversations")
    .update({ assigned_to: assignee })
    .eq("id", conversation.id);
  if (error) {
    toast.error("We couldn't update the assignment. Please try again.");
    return false;
  }
  toast.success(assignee ? "Conversation assigned." : "Conversation unassigned.");
  void logActivity("conversation_assigned", organizationId, {
    conversation_id: conversation.id,
    assigned_to: assignee,
  });
  emitClientEvent("conversation.assigned", organizationId, {
    entityType: "conversation",
    entityId: conversation.id,
    whatsappAccountId: conversation.whatsapp_account_id ?? null,
    properties: { assigned_to: assignee },
  });
  return true;
}

/**
 * A free-form text from a person to a customer: the Inbox composer's send
 * (POST /api/whatsapp/send-message, message_type "text"), which checks the
 * 24-hour window, opt-out and permissions on the server. Home's draft Send
 * uses this same call (Batch 45). `error` is the server's own words.
 */
export function sendInboxText(organizationId: string, conversationId: string, text: string) {
  return callApi<{ message_id: string }>("/api/whatsapp/send-message", {
    body: {
      organization_id: organizationId,
      conversation_id: conversationId,
      message_type: "text",
      body: text,
    },
  });
}
