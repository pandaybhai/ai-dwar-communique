/**
 * Batch 57: every word Aiden Workspace's Home shows, in one place (a later
 * Hindi pass changes this file only). Where Aiden talks, it talks in the first
 * person; Off / Draft / Replying stay the mode names. The headlines that count
 * customers live in src/lib/new-home.ts (replyingHeadline …), tested there.
 */

const n = new Intl.NumberFormat("en-IN");
const plural = (k: number, one: string, many: string) => (k === 1 ? one : many);

export const HOME_COPY = {
  noWorkspace: {
    title: "Pick a workspace to start",
    body: "Choose one of your shops from the switcher and I'll show you today.",
  },
  loading: "Getting your shop ready",
  modeGroup: "Aiden",
  modes: {
    replying: "Aiden replying",
    draft: "Aiden drafts",
    off: "Aiden off",
  },
  modeLocked: "Only someone who can change Aiden's settings can switch this.",
  testFirst: {
    title: "Try Aiden in a test chat first?",
    notNow: "Not now",
    anyway: "Switch anyway",
    test: "Open the test chat",
  },
  today: "Today",
  todayRows: {
    chats: "Chats",
    answered: "Answered by Aiden",
    drafts: "Drafts Aiden wrote",
    flows: "Flow runs",
    sales: "Sales from chats",
    credits: "Credits",
  },
  campaign: {
    read: "Read",
    replied: "Replied",
    people: (k: number) => plural(k, "person", "people"),
  },
  orb: {
    replying: "Aiden is replying",
    draft: "Aiden writes drafts for you",
    off: "Your team is answering",
  },
  replying: {
    lede(answered: number | null, needs: number | null): string {
      const first =
        answered === null
          ? ""
          : answered === 0
            ? "I haven't needed to reply to anyone yet today."
            : `I've sent ${n.format(answered)} ${plural(answered, "reply", "replies")} today.`;
      const second =
        needs === null
          ? ""
          : needs === 0
            ? "Nothing needs you right now."
            : needs === 1
              ? "One customer needs you."
              : `${n.format(needs)} customers need you.`;
      return [first, second].filter(Boolean).join(" ") || "I answer your customers as they write.";
    },
    feedLabel: "Aiden's latest replies",
    aiden: "Aiden",
    aidenTyping: "Aiden is typing",
    emptyTitle: "My replies will show up here",
    emptyBody:
      "When a customer writes to your WhatsApp number, I reply in seconds and you can watch it here.",
    emptyAction: "Try me in a test chat",
  },
  needsYou: {
    title: (k: number) =>
      k === 1 ? "1 customer is waiting for you" : `${n.format(k)} customers are waiting for you`,
    asked: (who: string) => `${who} asked`,
    alsoWaiting: (names: string[], more: number) =>
      more > 0
        ? `Also waiting: ${names.join(", ")} and ${n.format(more)} more.`
        : `Also waiting: ${names.join(" and ")}.`,
    reply: (first: string) => `Reply to ${first}`,
    replyMyself: "Reply myself",
    openInbox: "Open the Inbox",
  },
  drafts: {
    ledeReady: "I wrote these. Nothing goes out until you tap Send.",
    ledeNone: "I'll line up the next ones as customers write.",
    allCaughtUp: "All caught up",
    allCaughtUpBody: "Every reply I drafted has been sent or answered.",
    label: "Aiden's drafts",
    draftFor: (who: string) => `Draft for ${who}`,
    aidenDraft: "Aiden's draft",
    yourReply: (who: string) => `Your reply to ${who}`,
    send: (first: string) => `Send to ${first}`,
    edit: "Edit",
    writeOwn: "Write my own",
    backToDraft: "Back to Aiden's draft",
    openChat: "Open the chat",
    sent: (who: string) => `Sent to ${who}.`,
  },
  off: {
    headlineUnknown: "Your team is answering",
    ledeUnknown: "Aiden is off. Your team replies to every customer.",
    ledeWaiting: "Oldest first. Reply, hand it to someone on your team, or send a message design.",
    ledeNone: "Everyone who wrote in has an answer.",
    queueLabel: "Customers waiting, oldest first",
    waiting: (since: string) => `waiting ${since}`,
    with: (name: string) => `With ${name}`,
    reply: "Reply",
    assign: "Assign",
    assignLabel: (who: string) => `Hand ${who} to someone on your team`,
    assignTo: "Give this chat to",
    seeAll: (k: number) => `See all ${n.format(k)} in the Inbox`,
    tryDraftLead: "Want help in the busy hours?",
    tryDraft: "Let Aiden draft replies for you",
    closingTitle: "Free replies running out",
    closingBody: (k: number) =>
      `${k === 1 ? "1 chat loses" : `${n.format(k)} chats lose`} the free 24-hour window within 2 hours. After that, you'll need a paid message design (a template) to reply.`,
    flowsTitle: "Your flows today",
    flowsNone: "None of your flows has run yet today.",
  },
} as const;
