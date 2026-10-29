import { aidwar } from "@/integrations/aidwar/client";

/**
 * The Inbox's live updates (Batch 45 moved them here so Home listens the same
 * way): every change to this workspace's messages and conversations, filtered
 * on the server by organization_id. Realtime applies the reader's RLS to each
 * insert and update, so a member only hears about their own workspace; the
 * callbacks treat a payload as a signal and read again through RLS.
 * Returns the unsubscribe.
 */
export function subscribeInboxChanges(
  topic: string,
  organizationId: string,
  handlers: {
    onMessage: (payload: { new: unknown }) => void;
    onConversation: (payload: { new: unknown }) => void;
  },
): () => void {
  const channel = aidwar
    .channel(topic)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "messages",
        filter: `organization_id=eq.${organizationId}`,
      },
      (payload) => handlers.onMessage(payload as { new: unknown }),
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "conversations",
        filter: `organization_id=eq.${organizationId}`,
      },
      (payload) => handlers.onConversation(payload as { new: unknown }),
    )
    .subscribe();

  return () => {
    void aidwar.removeChannel(channel);
  };
}
