/**
 * Batch 57: every visible word of the Customers screens in Aiden Workspace
 * (Contacts, Groups, Sales from chats, the drawer's summary and notes, the
 * guided import) in one place, so a Hindi version can follow. Plain objects;
 * anything with a count is a function. Words drawn by the classic components
 * these screens reuse (ContactDrawer, SegmentBuilderDialog,
 * MarkAllUnknownOptedIn, DateRangePicker, Pagination) stay theirs.
 *
 * Words used here: "Group" is a segment (routes, ?tab=segments, tables and
 * code keep that name); "Said yes" / "No answer yet" / "Said no" are the
 * opt-in statuses opted_in / unknown / opted_out. Meta's and WhatsApp's own
 * words, the import's consent box and every number stay as they are.
 */

const num = (n: number) => n.toLocaleString("en-IN");
/** "1 customer", "1,240 customers". */
export const count = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;

/** The opt-in status in plain words: the chip, and the longer form for a filter. */
export const optInCopy = {
  opted_in: { chip: "Said yes", long: "Said yes to messages" },
  unknown: { chip: "No answer yet", long: "No answer yet" },
  opted_out: { chip: "Said no", long: "Said no to messages" },
} as const;

/** Helpers' words: filter chips, last chat, bulk count, flow runs, receipts ratio. */
export const listCopy = {
  tagChip: (name: string) => `Tag: ${name}`,
  boughtChip: (days: number) => `Bought in the last ${days} days`,
  groupChip: (name: string) => `Group: ${name}`,
  noChat: "No chat yet",
  justNow: "just now",
  minAgo: (m: number) => `${m} min ago`,
  hoursAgo: (h: number) => `${h} ${h === 1 ? "hour" : "hours"} ago`,
  daysAgo: (d: number) => `${d} ${d === 1 ? "day" : "days"} ago`,
  nothingSpent: "—",
  selected: (n: number) => `${num(n)} selected`,
  backPerRupee: (value: string) => `₹${value} back per ₹1`,
  flowRun: {
    running: "Running",
    waiting: "Waiting for a reply",
    paused: "Paused",
    done: "Finished",
    failed: "Stopped with an error",
    expired: "Timed out",
    ended: "Ended",
  },
} as const;

export const contactsCopy = {
  /** The page's name (read out by screen readers; the shell shows "Customers"). */
  title: "Contacts",
  description:
    "Everyone who has messaged you on WhatsApp or been added by your team, with their tags, last chat and what they bought. “Said yes” means they agreed to get messages from you.",
  importList: "Import a list",
  add: "Add a customer",
  searchPlaceholder: "Search by name or phone",
  searchLabel: "Search customers",
  removeFilter: (label: string) => `Remove filter: ${label}`,
  addFilter: "+ Filter",
  filterOptIn: "Said yes to messages?",
  filterTag: "Tag",
  noTagsYet: "No tags yet",
  filterBought: "Bought in the last…",
  days: (d: number) => `${d} days`,
  filterGroup: "Group",
  download: "Download list",
  downloading: "Preparing your file…",
  downloadFailed: "Couldn't download your list. Check your internet and try again.",
  loadFailed: "Couldn't load your customers. Check your internet and tap Try again.",
  empty: {
    title: "Your customers will show up here",
    description:
      "Everyone who messages you on WhatsApp is added here on their own. Have a list in Excel? Save it as CSV and import it to bring everyone in at once.",
  },
  noMatch: {
    title: "No one matches these filters",
    description: "Try another name or number, or remove a filter to see everyone again.",
    action: "Show everyone",
  },
  tableCaption: "Your customers",
  selectAll: "Select all customers on this page",
  select: (label: string) => `Select ${label}`,
  col: {
    customer: "Customer",
    tags: "Tags",
    messages: "Messages",
    lastChat: "Last chat",
    spent: "Spent",
  },
  noName: "No name yet",
  noTags: "No tags",
  lastChat: (when: string) => `Last chat ${when}`,
  sourcesTitle: "Where your customers come from",
  loading: "Loading your customers",
  bulk: {
    region: "Ticked customers",
    addTag: "Add a tag",
    noTagsYet: "No tags yet. Open a customer to make one.",
    markYes: "Mark as said yes",
    saving: "Saving…",
    sendCampaign: "Send them a campaign",
    clear: "Clear",
    note: "Anyone who said no stays a no.",
    alreadyTagged: (tag: string) => `Everyone you ticked already has “${tag}”.`,
    tagged: (tag: string, n: number) => `Added “${tag}” to ${count(n, "customer", "customers")}.`,
    tagFailed: "Couldn't add that tag. Check your internet and try again.",
    markFailed: "Couldn't update these customers. Check your internet and try again.",
  },
} as const;

export const groupsCopy = {
  title: "Groups",
  description:
    "A group is a set of customers sorted by rules, like a tag or what they bought. It keeps itself up to date as customers change, and a campaign can go to just one group.",
  make: "Make a group",
  makeFirst: "Make your first group",
  loadFailed: "Couldn't load your groups. Check your internet and tap Try again.",
  empty: {
    title: "Your groups will show up here",
    description:
      "Sort customers by a tag, whether they said yes to messages, or anything you imported. Then send a campaign to just those people.",
  },
  noNote: "No note added",
  pickedByHand: "Picked by hand",
  matchAll: "Matches every rule",
  matchAny: "Matches any rule",
  customers: (n: number) => (n === 1 ? "customer" : "customers"),
  teammate: "Teammate",
  madeBy: (who: string, when: string) => `Made by ${who} on ${when}`,
  edit: "Edit",
  copy: "Make a copy",
  deleteLabel: (name: string) => `Delete the group ${name}`,
  deleteFailed: "Couldn't delete this group. Check your internet and try again.",
  deleted: "Group deleted.",
  confirm: {
    title: "Delete this group?",
    body: (name: string) =>
      `“${name}” will be removed. The customers in it stay exactly as they are.`,
    keep: "Keep it",
    delete: "Delete group",
  },
  loading: "Loading your groups",
} as const;

export const salesCopy = {
  allNumbers: "All WhatsApp numbers",
  numberLabel: "WhatsApp number",
  refresh: "Refresh",
  download: "Download report",
  loadFailed: "Couldn't load your sales from chats. Check your internet and tap Try again.",
  kpi: {
    sales: "Sales from your messages",
    orders: "Orders",
    cost: "Message cost with tax",
    back: "Back for every ₹1",
    noneYet: "None yet",
  },
  costsMissing: "Some costs not known yet",
  nothingBillable: "No cost yet",
  tableTitle: "Every campaign and flow, side by side",
  tableHelp: (gst: number) =>
    `What you sent, what customers did with it, and what Meta charged you. We add ${gst}% tax (change it in Settings). Open a row to see each message inside it.`,
  empty: {
    title: "No sales from chats in these dates",
    description:
      "Send a campaign or switch on a flow, and what it earned and what it cost will show up here. Or pick other dates above.",
  },
  tableCaption: "Sales and message costs for each campaign and flow in the selected dates",
  col: {
    name: "Name",
    sent: "Sent",
    delivered: "Delivered",
    read: "Read",
    clicked: "Clicked",
    orders: "Orders",
    sales: "Sales",
    cost: "Cost",
    withTax: "With tax",
    perRupee: "Back per ₹1",
  },
  flow: "Automatic message",
  campaign: "Campaign",
  made: (day: string) => `, made ${day}`,
  messageN: (n: number) => `Message ${n}: `,
  showMessages: (open: boolean, n: number) => `${open ? "Hide" : "Show"} each message (${n})`,
  stepLine: (sent: string, read: string, orders: string, inAmt: string, outAmt: string) =>
    `${sent} sent, ${read} read, ${orders} orders. ${inAmt} in, ${outAmt} out.`,
  total: "Everything together",
} as const;

export const summaryCopy = {
  chat: "Last chat",
  lastMessage: (when: string, closed: boolean) =>
    `Last message ${when}. ${closed ? "Marked done." : "The chat is still open."}`,
  openChat: "Open the chat",
  noChat: "No chat yet. Their messages show here once they write to you.",
  consent: "Messages from you",
  optedOut: "They said no to messages. Only they can change that, by replying START.",
  optedInUnrecorded: "They said yes. How and when wasn't recorded.",
  notAsked: "No answer yet. Campaigns reach them once they say yes to messages.",
  aiden: "What Aiden knows",
  writesIn: (language: string) => `Writes in ${language}.`,
  asked: (q: string) => `Waiting for your answer: “${q}”`,
  aidenNothing: "Nothing yet. Aiden learns the language they write in once they message you.",
  orders: "Orders",
  order: (orderNumber: string | null, day: string) =>
    `${orderNumber ? `Order ${orderNumber}` : "Order"}${day ? `, ${day}` : ""}`,
  spentOver: (spent: string, n: number) => `Spent ${spent} over ${count(n, "order", "orders")}.`,
  noOrders: "No orders from your shop yet.",
  flows: "Automatic flows",
  aFlow: "A flow",
  noFlows: "No automatic flow has run for this customer yet.",
  loading: "Loading this customer's details",
} as const;

export const notesCopy = {
  title: "Team notes",
  summary: (when: string) => `Aiden’s last summary, ${when}`,
  summaryFrom: "From “Catch me up” in the Inbox.",
  loading: "Loading notes",
  unavailable: "Notes aren’t switched on for this workspace yet.",
  loadFailed: "Couldn’t load notes. Check your internet and tap Try again.",
  retry: "Try again",
  fieldLabel: "Add a note about this customer",
  placeholder: "Write something your team should know, like a size or a good time to call",
  add: "Add note",
  empty: "No notes yet. Only your team sees notes; Aiden doesn’t read them.",
  teammate: "Teammate",
  deleteLabel: "Delete this note",
  /** addNote / deleteNote's answers (shown as a toast). */
  writeFirst: "Write the note first.",
  notOn: "Notes aren't switched on for this workspace yet.",
  saveFailed: "Couldn't save that note. Check your internet and tap Add note again.",
  deleteFailed: "Couldn't delete that note. Check your internet and try again.",
} as const;

export const importCopy = {
  trigger: "Import a list",
  title: "Import customers",
  step: (n: number, hint: string) => `Step ${n} of 3: ${hint}.`,
  steps: ["Upload", "Match", "Import"] as const,
  hints: ["pick your file", "tell us what each column holds", "check and import"] as const,
  stepsLabel: "Import steps",
  noRows:
    "That file has no customer rows. Check it has a heading row and at least one row below it.",
  tooMany: (max: number) => `Only the first ${num(max)} rows will be imported.`,
  drop: "Drop your CSV file here",
  limits: (max: number) =>
    `Up to ${num(max)} rows, with one column of phone numbers. From Excel, use Save as CSV.`,
  fileLabel: "CSV file",
  choose: "Choose a file",
  sample: "Download a sample file",
  rowsIntro: (file: string, rows: number) =>
    `${file}: ${count(rows, "row", "rows")}. Tell us what each column holds.`,
  column: (i: number) => `Column ${i + 1}`,
  example: (s: string) => `For example: ${s}`,
  emptyColumn: "Empty in the first rows",
  holds: (h: string) => `What "${h}" holds`,
  option: {
    attr: "Extra detail",
    phone: "Phone number (needed)",
    name: "Name",
    tags: "Tags (separate with commas)",
    ignore: "Leave this column out",
  },
  savedAs: (key: string) => `Saved on each customer as “${key}”`,
  previewCaption: "The first rows of your file",
  field: { phone: "Phone", name: "Name", tags: "Tags" } as Record<string, string>,
  leftOut: "Left out",
  extra: "Extra detail",
  needPhone: "Pick the column with phone numbers to continue.",
  back: "Back",
  next: "Continue",
  summary: {
    file: "File",
    rows: "Rows",
    phoneFrom: "Phone from",
    nameFrom: "Name from",
    tagsFrom: "Tags from",
    extras: "Extra details",
  },
  consentOn:
    "They'll be marked as said yes to messages. Anyone who replied STOP stays marked as said no. Your answer is recorded in the workspace activity log.",
  consentOff: "They’ll stay as No answer yet, so campaigns won't reach them until they say yes.",
  startFlows:
    "Also start automatic flows that begin when these tags are added. Leave this off to import quietly.",
  start: (rows: number) => `Import ${count(rows, "row", "rows")}`,
  running: "Importing your customers",
  progressLabel: "Import progress",
  percent: (p: number) => `${p}% done`,
  done: "All done. Your customers are in.",
  results: { created: "Added", updated: "Updated", skipped: "Skipped" },
  errorReport: "Download the skipped rows",
  close: "Done",
} as const;
