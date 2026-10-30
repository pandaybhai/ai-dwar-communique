/**
 * Batch 57: the words Aiden Workspace's Inbox shows that this batch rewrote,
 * in one place (a later Hindi pass edits this file). The tab names, the
 * 24-hour window chip and Take over / Hand back stay in inbox-v2.ts, where
 * their rules are tested; the opted-out banner keeps its WhatsApp policy text.
 */
export const INBOX_COPY = {
  typing: "Aiden is typing…",
  typingLabel: "Aiden is typing",
  noName: "No name saved",
  listEmpty: {
    none: "All caught up",
    noneBody: "New WhatsApp chats will appear here the moment a customer writes.",
    filtered: "Nothing in this view",
    filteredBody: "Try another tab, or clear the search and filters.",
  },
  paneEmpty: {
    pick: "Pick a chat",
    pickBody: "Open a chat on the left to read it and reply. I keep answering the rest.",
    noneTitle: "Your WhatsApp chats will show up here",
    noneBody:
      "When a customer writes to your number, the chat lands here and I answer it in seconds. Want to see how I'd reply first?",
    noneAction: "Try me in a test chat",
  },
  noMessages: "No messages yet",
  noMessagesBody: "Say hello with a message below.",
  composer: {
    placeholder: "Type a reply, or press / for message designs",
    placeholderCompact: "Reply, or / for more",
  },
  orders: {
    newToday: (amount: string) => `New order today: ${amount}`,
  },
} as const;
