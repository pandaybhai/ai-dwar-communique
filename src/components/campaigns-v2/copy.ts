/**
 * Batch 57: every word the new Campaigns screen shows, in one place (plain,
 * warm Indian English; plurals as functions). Meta's own words, message text
 * and every amount stay where they are computed; this file only says them.
 * The routes, code names and API names don't change with the words.
 */

const n = new Intl.NumberFormat("en-IN");

/** "1 customer", "240 customers". */
export const customers = (k: number) => `${n.format(k)} customer${k === 1 ? "" : "s"}`;
/** "1 order", "2 orders". */
export const orders = (k: number) => `${n.format(k)} order${k === 1 ? "" : "s"}`;

export const campaignsCopy = {
  page: {
    title: "Campaigns",
    description:
      "Send one message to many customers, then see how far it got: sent, delivered, read and replied.",
  },
  newCampaign: "New campaign",
  listLabel: "Campaigns",
  loadingList: "Loading campaigns",
  allCampaigns: "All campaigns",
  empty: {
    title: "Send your first campaign",
    description:
      "Pick who gets it and an approved message design. It goes to every customer who said yes to offers, in one go.",
    action: "Start a campaign",
  },
  loadError: "Couldn’t load your campaigns just now. Tap Try again.",
  notFound:
    "Couldn’t open this campaign. It may have been removed, or the connection dropped. Tap Try again.",
  off: {
    description: "Reach every customer who said yes to offers with one message.",
    title: "Campaigns are turned off",
    body: "Campaigns aren’t switched on for your workspace yet. Ask your administrator to turn them on.",
  },
  bars: (delivered: number, read: number, replied: number) =>
    `${delivered}% delivered, ${read}% read, ${replied}% replied`,
} as const;

export const resultsCopy = {
  approve: "Approve and send",
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel campaign",
  toast: {
    pause: "Campaign paused.",
    resume: "Campaign resumed.",
    approve: "Approved. Sending starts now.",
    cancel: "Campaign cancelled.",
  },
  pausedNoCredits:
    "Paused because your credits ran out. Add credits, then tap Resume to send the rest.",
  resultsLabel: "Results",
  shareOfAll: (share: number) => `, ${share}% of everyone you picked`,
  sales: "Sales from this campaign",
  failed: "Couldn’t send",
  failedNote: (share: number) => `${share}% of everyone you picked`,
  tookCode: (code: string) => `Took code ${code}`,
  usedCode: "Used it",
  timeline: "What happened",
  recipients: "Who got it",
  searchPlaceholder: "Search by phone number",
  searchLabel: "Search recipients by phone number",
  filterLabel: "Show recipients",
  filterAll: "All",
  noMatch: "Nobody matches. Try another status or phone number.",
  noneYet: "Nobody here yet. People show up as the campaign sends.",
  col: { phone: "Phone", status: "Status", detail: "Note", updated: "Updated" },
  nothingToReport: "Nothing to report",
  now: "Now",
  phoneLabel: "The message this campaign sends",
  phoneTitle: (name: string) => `${name}: the message`,
  templateGone: (name: string) => `The message design “${name}” isn’t in your library any more.`,
  usesName: "{{name}} is each customer’s own name.",
  sameForAll: "What every customer gets.",
  loading: "Loading results",
} as const;

/** The wizard's numbered steps (wizard-parts.tsx); Launch is the last button. */
export const stepsCopy = {
  labels: ["Audience", "Message", "Personalise", "Test send", "Review and cost"],
  listLabel: "Steps",
  backTo: (label: string) => `Back to ${label}`,
  stepOf: (step: number, total: number) => `Step ${step} of ${total}: `,
} as const;

/** The wizard's side panel and footer line (wizard-parts.tsx, ndCostLine). */
export const costCopy = {
  label: "Cost",
  whoGetsIt: "Who gets it",
  skipped: "Skipped (haven’t said yes to offers)",
  cost: "Cost",
  walletAfter: "Your wallet after this",
  perMessage: (rate: string) => `An estimate, about ${rate} a message.`,
  counting: "Counting who gets it.",
  pickTemplate: "Pick a message design to see the cost.",
  pickAudience: "Pick who gets it to see the cost.",
  short: (amount: string) => `Your wallet is ${amount} short. Add credits, then send.`,
  needsApproval:
    "This is above your approval limit, so it waits for an owner to approve it. Nothing sends before that.",
  dailyLimit: (people: string, days: number) =>
    `Your number can message ${people} people a day right now, so this goes out over about ${days} days.`,
  line: {
    counting: "Counting who gets it",
    pick: "Pick who gets it to see the cost",
    about: (who: string, amount: string) => `${who}, about ${amount}`,
  },
} as const;

/**
 * Batch 57: the wizard's last button and the moment after it (Aiden
 * Workspace only; the review step before it is unchanged). Launching starts
 * the send: the words never claim it has reached everyone yet.
 */
export const sendCopy = {
  sendTo: (k: number) => `Send to ${customers(k)}`,
  scheduleFor: (k: number) => `Schedule for ${customers(k)}`,
  forApproval: "Send for approval",
  starting: (k: number | null) =>
    k === null ? "Starting your campaign…" : `Starting the send to ${customers(k)}…`,
  sent: (k: number | null) =>
    k === null
      ? "Sent! It's on its way. I'll show you who reads and replies."
      : `Sent! It's on its way to ${customers(k)}. I'll show you who reads and replies.`,
  scheduled: "Scheduled. I'll send it at the time you picked.",
  approval: "Saved. It sends as soon as an owner approves it.",
} as const;
