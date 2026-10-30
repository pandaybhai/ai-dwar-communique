/**
 * Batch 57: every word the new Templates screen shows, in one place. The
 * visible name is "Message designs" (the shell tab's name); the route
 * (/app/templates), code names and API names stay "templates". Meta's own
 * words stay as Meta says them: the review states (Approved, In review,
 * Rejected, or Meta's word for a paused one), the categories (Marketing,
 * Utility, Authentication), Meta's reason for a rejection, and the 30-day
 * name rule when a template is deleted.
 */

export const templatesCopy = {
  page: {
    title: "Message designs",
    // The one-line explanation, the first time the word appears on the screen.
    description:
      "WhatsApp approves these before you can send. Once approved, a design can go out any time, even after the 24-hour reply window. A new one is usually reviewed within minutes.",
  },
  refreshAll: "Refresh from WhatsApp",
  refreshOne: "Refresh this number",
  refreshed: "Message designs updated from WhatsApp.",
  loadError: "Couldn’t load your message designs just now. Tap Try again.",
  starters: {
    heading: "Start a new one",
    blank: { title: "A blank design", detail: "Your own words, buttons and picture." },
    invoice: {
      title: "Invoice or receipt with a PDF",
      detail: "A utility message with the file at the top.",
    },
  },
  empty: {
    title: "No message designs yet",
    description:
      "Start one and send it to WhatsApp for approval. Already have approved ones on your business account? Tap Refresh from WhatsApp.",
    action: "Start a blank design",
  },
  libraryHeading: "Your message designs",
  searchPlaceholder: "Search message designs",
  searchLabel: "Search message designs",
  numberFilterLabel: "Number",
  allNumbers: "All numbers",
  filterLabel: "Show message designs",
  noMatch: {
    title: "Nothing matches",
    description: "Try a different name, wording, number or review state.",
    action: "Show all",
  },
  noNumber: "No connected number",
  moreFor: (name: string) => `More for ${name}`,
  deleteAction: "Delete message design",
  metaReason: "Meta’s reason:",
  tileLabel: (name: string) => `${name}: the message`,
  loading: "Loading message designs",
} as const;

/** The Delete dialog (delete-template.tsx). Meta's 30-day rule is kept word for word. */
export const deleteCopy = {
  title: (name: string | undefined) => `Delete “${name ?? ""}”?`,
  body: (language: string | undefined) =>
    `It is deleted on your WhatsApp business account too (${language ?? ""}). Meta doesn’t let a deleted template’s name be used again for 30 days, and this can’t be undone.`,
  keep: "Keep it",
  confirm: "Delete message design",
  done: (name: string) => `Deleted “${name}”.`,
} as const;
