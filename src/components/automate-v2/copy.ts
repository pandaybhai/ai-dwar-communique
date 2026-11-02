/**
 * Batch 57: every word the new Automate screens (Aiden, Flows, Automations,
 * the builder's step card) show, in one place, so a later Hindi pass is one
 * file. Plain objects and functions only (plurals are functions); nothing here
 * reads, writes or decides anything.
 *
 * Where Aiden talks, Aiden says "I". The mode names Off / Drafts / Replying,
 * WhatsApp policy words, billing amounts and the classic screens' own toasts
 * (kept word for word where the code is the classic code) do not change.
 */

const count = new Intl.NumberFormat("en-IN");
/** "1 page" / "126 pages", Indian digit grouping. */
export const plural = (n: number, one: string, many: string) =>
  `${count.format(n)} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------ Aiden */

export const aidenPage = {
  noWorkspace: {
    title: "Pick a workspace first",
    description:
      "Choose a workspace from the switcher at the top to see what Aiden is doing there.",
  },
  restricted: {
    title: "You can't see Aiden yet",
    description:
      'This needs the "Use AI" permission. Ask the shop owner or an admin to give it to you.',
  },
  description: (name: string) =>
    `Your teammate on WhatsApp. See what ${name} is doing, teach the answers ${name} doesn't know yet, and try a test chat first.`,
  aiOnToast: "AI is on for your workspace.",
  aiOffToast: "AI is off for your workspace.",
  everythingHeading: (name: string) => `Everything ${name} does`,
  everythingLine:
    "My job, what I know, when I hand a chat to you, my brain and tools, and every answer I've given.",
  /** The Employee page's tab names, unchanged (the classic tabs below use them too). */
  tabs: {
    job: "My job",
    knows: "What I know",
    gaps: "Questions for you",
    behaviour: "How I behave",
    brains: "My brain & tools",
    forms: "Forms",
    try: "Try me",
    work: "My work",
  },
  refresh: "Refresh",
  /** The Employee page's test gate, word for word. */
  gate: {
    title: "Let me show you my work first",
    body: "You haven't tested me yet. Want to see how I'd have answered your last 20 customer questions first?",
    notNow: "Not now",
    anyway: "Switch anyway",
    run: "Run the test on my last 20 questions",
  },
} as const;

export const aidenModes = {
  off: { label: "Off", meaning: "Your team answers every message." },
  draft: { label: "Drafts", meaning: "I write each reply, you read it and send it." },
  replying: {
    label: "Replying",
    meaning: "I reply to customers and pass anything I'm unsure about to you.",
  },
} as const;

export const aidenStatusWords = {
  switchedOff: (name: string) => ({
    title: `${name} is switched off`,
    meaning: "I can't answer, draft or even test until AI is turned on for your workspace.",
  }),
  replying: (name: string) => ({
    title: `${name} is replying to customers`,
    meaning: "I answer your customers on WhatsApp and pass anything I'm unsure about to you.",
  }),
  draft: (name: string) => ({
    title: `${name} writes, you send`,
    meaning: "I'll write replies and you send them. You're always in control.",
  }),
  off: (name: string) => ({
    title: `${name} is off`,
    meaning: "Your team answers every message. I don't send or draft anything.",
  }),
};

export const statusCard = {
  aiOffTitle: "AI is off for your workspace",
  aiOffLine: "Turn it on, then pick Drafts or Replying.",
  turningOn: "Turning on…",
  turnOn: (name: string) => `Turn ${name} on`,
  modeGroup: (name: string) => `Choose what ${name} does`,
  locked: "Turn AI on for your workspace first.",
  answered: "Answered this week",
  passed: "Passed to you",
  cost: "Cost this month",
  notTested: (name: string) =>
    `You haven't tried me yet. Before I reply on my own, test me with real customer questions: use Test ${name} below, or compare two setups under Try me.`,
  viewOnly:
    'You can see everything I do. To change how I work you need the "Configure AI" permission. Ask the shop owner.',
} as const;

export const reviewCopy = {
  heading: "Needs your answer",
  loading: "Loading what needs your answer",
  empty: {
    title: "Nothing is waiting on you",
    description:
      "When I can't answer a customer, I'll bring the question here. Answer it once and I'll remember it.",
    action: "See my answers this week",
  },
  gapsTitle: (n: number) =>
    `${plural(n, "customer question", "customer questions")} I couldn't answer`,
  gapsLine:
    "I kept each chat going and saved the question. Answer it once: if the chat is still open, your answer goes to the customer now, and I'll remember it for next time.",
  seeAll: (n: number) => `See all ${count.format(n)} questions`,
  checkHeading: "Answers to check",
  checkLine:
    "This week I passed these on to you or didn't answer. Teach me the right answer and I'll use it from now on.",
  seeEverything: "See everything I did",
  asked: (when: string) => `Asked ${when}`,
  openChat: "Open chat",
  testChat: "From your test chat",
  answerLabel: "Your answer, the way you'd say it",
  teach: (name: string) => `Teach ${name}`,
  cancel: "Cancel",
  dismiss: "Skip this one",
  writeFirst: "Write the answer first.",
  shouldHaveLabel: "The answer I should have given",
  learned: "Got it. I'll use your answer from now on.",
  /** WorkLog's own message, word for word. */
  bothNeeded: "Write both the question and the answer it should have given.",
} as const;

export const knowsCopy = {
  heading: (name: string) => `What ${name} knows`,
  manage: "Manage",
  reading: "Reading now",
  problem: "Needs a look",
  website: "Website",
  websiteEmpty: "Not added yet",
  websiteMore: (first: string, more: number) => `${first} and ${more} more`,
  websiteReading: (pages: number) => `Reading now, ${plural(pages, "page", "pages")} so far`,
  websiteBroken: "My last read didn't finish",
  pages: (n: number) => plural(n, "page", "pages"),
  documents: "Documents",
  documentsEmpty: "None uploaded yet",
  files: (n: number) => plural(n, "file", "files"),
  answers: "Your answers",
  answersCount: (n: number) => plural(n, "answer you wrote", "answers you wrote"),
  answersEmpty: "None written yet",
  catalogue: "Catalogue",
  products: (n: number) => plural(n, "product", "products"),
  catalogueEmpty: "No products yet",
  fresh: {
    never: "not read yet",
    today: "updated today",
    yesterday: "updated yesterday",
    days: (d: number) => `updated ${d} days ago`,
  },
} as const;

export const testCopy = {
  heading: (name: string) => `Test ${name}`,
  line: "Ask me anything a customer might. Nothing here goes to a real customer.",
  phoneLabel: (name: string) => `Test chat with ${name}`,
  hello: "This is a test chat. Each answer shows how long I took and what it cost.",
  inputLabel: "A question a customer might ask",
  placeholder: "Where's my order?",
  ask: (name: string) => `Ask ${name}`,
  typing: (name: string) => `${name} is typing`,
  suggestions: "Try a question your customers really asked",
  compare: (n: number) => `Compare two setups on your last ${n} questions`,
  couldNot: "I couldn't answer this one.",
  /** The Playground's cost words, unchanged. */
  nothingCharged: "nothing charged",
  costUnknown: "cost unknown",
  priceOnRequest: "Price on request",
  turnOnAndAsk: (name: string) => `Turn ${name} on and ask again`,
  turningOn: "Turning on…",
} as const;

/* ------------------------------------------------------------------ Flows */

export const flowsPage = {
  title: "Flows",
  description:
    "A flow is a chat that runs by itself, step by step: a menu, a few questions, a follow-up. Your store's automatic messages live here too.",
  noShop: {
    title: "Pick a shop first",
    description: "Choose a shop at the top of the page to see its flows.",
  },
  notOn: {
    title: "Flows aren't on for you yet",
    description: "Ask us or your admin to switch them on for your account.",
  },
  noAccess: {
    title: "You don't have access to flows",
    description: "Ask the shop owner to give you permission to see them.",
  },
  tabs: { chat: "Chat flows", store: "Store flows", log: "What was sent" },
  newFlow: "New chat flow",
} as const;

export const chatFlowsCopy = {
  loadError: "Couldn't load your flows. Check your internet and tap Try again.",
  loading: "Loading your flows",
  backToFlows: "Back to your flows",
  deletedToggle: (n: number) => `Deleted flows (${count.format(n)})`,
  deletedEmpty: {
    title: "No deleted flows",
    description: "A flow you delete waits here for 30 days so you can bring it back.",
  },
  deletedRow: (when: string, days: number) =>
    `Deleted ${when}, ${plural(days, "day", "days")} left to bring it back`,
  restore: "Restore",
  restored: (name: string) => `“${name}” is back. Publish it again if it was off.`,
  empty: {
    title: "Your chat flows will show up here",
    description:
      "A flow is a chat that runs by itself: a menu, a few questions, then a hand-over to your team. No AI needed. Start from a ready-made one and change the words.",
    action: "Create your first flow",
  },
  steps: (n: number, when: string) => `${plural(n, "step", "steps")}, changed ${when}`,
  startsLabel: "How it starts",
  usedLabel: "How often it ran",
  counting: "Counting how often it ran",
  usedNone: "Not used yet",
  usedTimes: (n: number) => (n === 1 ? "time" : "times"),
  usedPrefix: "Used",
  usedLast: (when: string) => `, last ${when}`,
  edit: "Edit flow",
  open: "Open",
  history: "Run history",
  responses: "Responses",
  deleteLabel: (name: string) => `Delete ${name}`,
  deleteTitle: "Delete flow",
  historyHeading: (name: string) => `Run history: ${name}`,
  historyLine:
    "The last 10 customers who went through this flow, step by step. Tap Run history on another flow to see its customers.",
  createTitle: "Start from a ready-made flow",
  createFailed: "Couldn't create the flow. Check your internet and try again.",
} as const;

export const runTimelineCopy = {
  loading: (name: string) => `Loading runs of ${name}`,
  failed: "Couldn't load the run history. Check your internet and tap Try again.",
  empty: (name: string) =>
    `Nobody has gone through ${name} yet. Each customer's steps show up here once it runs.`,
  someone: "A customer",
  from: (how: string) => `, from ${how.charAt(0).toLowerCase()}${how.slice(1)}`,
} as const;

/** How a flow starts, in the Triggers panel's names. A trigger is what starts a flow. */
export const triggerCopy = {
  keyword: (shown: string, more: number) =>
    `Keyword ${shown}${more > 0 ? ` and ${more} more` : ""}`,
  none: "Nothing starts it yet",
  allOff: "What starts it is switched off",
  startsOn: (first: string, more: number) =>
    more > 0 ? `Starts on: ${first} and ${more} more` : `Starts on: ${first}`,
} as const;

/** What happened at a step, in words. Unknown events keep their own name. */
export const runEventWords: Record<string, string> = {
  started: "Started",
  entered: "Reached",
  exited: "Moved on from",
  send: "Sent",
  text: "Sent",
  reply: "Customer answered",
  ended: "Finished",
  failed: "Stopped with a problem at",
  timeout: "No reply at",
  window_closed: "24-hour window closed at",
  quiet_hours: "Waited for quiet hours at",
  products_shown: "Showed products at",
  card_sent: "Sent a card at",
  card_failed: "Card not sent, plain message instead at",
  http_ok: "Web request answered at",
  http_failed: "Web request failed at",
  email_sent: "Emailed the team at",
  email_failed: "Email failed at",
  sheet_row_added: "Added a sheet row at",
  sheet_failed: "Sheet row failed at",
  paid: "Paid at",
  not_paid: "Not paid at",
  goto: "Went to another flow from",
  note: "Note at",
  nudge: "Nudged the customer at",
  order_draft_created: "Created an order draft at",
  reply_dropped: "Reply ignored at",
  template_skipped: "Template skipped at",
  tag_skipped: "Tag skipped at",
  pause: "Paused",
  resume: "Resumed",
  stop: "Stopped",
};

/** The builder's step card (drawing only). */
export const stepCardCopy = {
  statsTitle: "Customers who reached this step, moved on, and stopped here",
  next: "Next",
} as const;

/* ------------------------------------------------------------ Automations */

export const automationsCopy = {
  title: "Automations",
  description:
    "Automations are instant replies that go out by themselves: a welcome for new customers, answers to keywords, and a note when you're closed. One reply per message, never more.",
  notOn: {
    title: "Automations aren't on for your workspace yet",
    description: "Ask us or your admin to switch them on.",
  },
  loadError: "Couldn't load your automations. Check your internet and tap Try again.",
  loading: "Loading your automations",
  newAutomation: "New automation",
  empty: {
    title: "Your automations will show up here",
    description:
      "Greet new customers, answer common questions by keyword and reply when you're closed, all by themselves. A welcome message is a good first one.",
    action: "Create your first automation",
  },
  groups: {
    welcome: {
      title: "Welcome message",
      line: "Goes only once, the first time someone ever messages you.",
    },
    keyword: {
      title: "Keyword replies",
      line: "Goes when a customer's message matches one of your keywords.",
    },
    away: {
      title: "Off-hours replies",
      line: "Goes when you're closed, at most once every 4 hours per customer.",
    },
  },
  on: "Running",
  off: "Paused",
  switchLabel: (on: boolean, name: string) => `${on ? "Pause" : "Turn on"} ${name}`,
  replyLabel: "Your reply",
  lastSent: (when: string) => `Last sent ${when}`,
  notSent: "Not sent yet",
  priority: (n: number) => `, priority ${n}`,
  edit: (name: string) => `Edit ${name}`,
  delete: (name: string) => `Delete ${name}`,
  confirm: {
    title: "Delete this automation?",
    body: (name: string) =>
      `“${name}” stops replying straight away and its history is removed. You can't undo this.`,
    cancel: "Cancel",
    delete: "Delete",
  },
} as const;
