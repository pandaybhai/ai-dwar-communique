# Batch 57 copy: Settings, Billing and wallet, AI assistants

Words now live in one file per screen:
`src/components/settings-v2/copy.ts`, `src/components/billing-v2/copy.ts`,
`src/components/ai-assistants/copy.ts`. The AI assistants page and the
Connected AI apps list are shared with Classic, so their copy files hold a
`classic` set (byte for byte what Classic shows) and a `workspace` set
(Aiden Workspace only, picked with `useNewDesign()`).

| Where | Before | After |
| --- | --- | --- |
| Settings, page line | Workspace details, your team, and the connections that power your messaging. | Your shop's details, your team, and everything AiDwar is connected to. |
| Settings, load failed | (the org error, no button) We couldn't load your workspaces. Please refresh. | Couldn't load your workspace. Check your internet and tap Try again. (+ Try again) |
| Settings, no workspace | We couldn't find your workspace. Please refresh the page. | Couldn't find your workspace. Refresh the page, or pick it again from Switch workspace in your profile menu. |
| Settings > Workspace | How your workspace is named across AiDwar. | Your shop's name, as your team sees it across AiDwar. |
| Settings > Team and roles | Who works in this workspace and what each person may do. | Invite your team and choose what each person can do. |
| Settings > WhatsApp | Your WhatsApp profile, the numbers you send from and their health. | Your WhatsApp profile, the numbers you send from, and how each number is doing. |
| Settings > API and webhooks | Keys for your own systems, the webhook we call, and a console to try requests. | Let your own software work with AiDwar. The API is how it sends messages through us, and a webhook is the address we call to tell it what happened. Your keys and a test console are below. |
| Settings > Notifications | Who on your team is told when a chat needs a person. | Who on your team gets a message when a customer needs a person. |
| Settings > Opt-out keywords | Words that stop marketing messages to a customer. | When a customer sends one of these words, they have opted out, and we stop sending them offers. |
| Settings > Integrations | Your Shopify store. | Link your Shopify store so your products and orders show up in AiDwar. |
| Settings > Flow connections | Accounts your flows use: Google Sheets and Razorpay payment links. | Accounts your chat flows use, like Google Sheets and Razorpay payment links. |
| Settings > Send settings | Quiet hours, marketing caps, win-back timing, linking sales to messages and tax. | Quiet hours, how many offers one customer can get, win-back timing, linking sales to your messages, and tax. |
| Settings > Lead sources | Where new contacts come from. | See where new customers come from, using the words in their first message. |
| Settings > Danger zone | Actions that can't be undone. | Delete this workspace for good. This can't be undone. |
| Settings, profile picker (screen reader) | Which number's profile | Choose which number's profile to edit |
| Connected AI apps, none (Aiden Workspace) | No AI apps are connected to your AiDwar account. | No AI apps are connected yet. Add AiDwar to Claude, ChatGPT, Codex or Cursor once, and it shows up here. [See how to connect] |
| Connected AI apps, load failed (Aiden Workspace) | We couldn't load your connected apps. Please try again. | Couldn't load your connected AI apps. Check your internet and tap Try again. (+ Try again) |
| Connected AI apps, remove failed (Aiden Workspace) | We couldn't remove that app. Please try again. | Couldn't remove that app. Check your internet and tap Remove again. |
| Billing, page line | Your credits, what each message costs, payments and invoices — all in one place. | Your credits, what each message costs, and every payment and invoice, in one place. |
| Billing, no workspace | No workspace selected / Pick a workspace from the switcher to see its billing. | Pick a workspace first / Choose one from Switch workspace in your profile menu to see its credits and invoices. |
| Billing, flag off | Billing isn't switched on / This workspace doesn't manage credits here yet. Talk to us if you'd like it turned on. | Billing isn't on for this workspace yet / Credits and invoices for this workspace aren't kept here yet. Write to us if you'd like them switched on. [Write to us] |
| Billing, no permission | Billing is restricted / You need the "View billing" permission for this workspace. Ask an owner or admin to grant it. | Billing is open to some people only / Ask an owner or admin of this workspace to give you the “View billing” permission. |
| Billing, load failed | We couldn't load your billing / Please try again in a moment. | Couldn't load your billing / Check your internet and tap Try again. |
| Billing, nothing spent | Nothing spent yet this month — your first campaign will show up here. | Nothing spent yet this month. Once you send your first campaign, you'll see here where your credits went. |
| AI assistants, no access (Aiden Workspace) | You don't have access to AI assistants | AI assistants aren't open to you yet |
| AI assistants, load failed (Aiden Workspace) | We couldn't load this page. Please refresh. | Couldn't load your AI assistants. Check your internet and tap Try again. (+ Try again) |
| AI assistants, Connect (Aiden Workspace) | Connect / Add AiDwar to your AI assistant once; it signs in as you. | Connect your assistant / Add AiDwar to your AI assistant once. It signs in as you. Any assistant that supports MCP works: MCP is the common way AI apps connect to other tools. |
| AI assistants, activity (Aiden Workspace) | What your AI did | What your assistant did |
| AI assistants, empty activity (Aiden Workspace) | Nothing yet. When your assistant creates a segment, drafts… | Nothing here yet. When your assistant makes a group of customers, drafts a campaign or a flow, or sends or switches one on after you confirm, you'll see it here with a link to open it. Try asking it: “Draft a Diwali campaign to customers tagged VIP”. [See things to ask] |
| AI assistants, prompts (Aiden Workspace) | Prompt library / Copy one into your assistant. Each works with today's AiDwar tools. | Things to ask / Copy one, paste it into your assistant and send. Each one works with what AiDwar can do today. |

## Polish done

- **Wallet**: the balance and "Spent since" count up once with `NumberTicker`
  (from `@/components/design-v2`). They land on exactly `money()`'s text:
  `amountParts` (billing-v2.ts) splits money()'s own string, so the ticker
  counts whole rupees with ₹ and Indian grouping and the paise sit beside it.
  Below zero or in another currency it shows money()'s text with no ticker.
  A test checks nine amounts, 0 to ₹9,87,65,432.10. "AI answers used" ticks
  only below 1,000, where the text is the same as before (no grouping).
  Screen readers get the plain text.
- **Entrances**: `nd-rise` with a stagger (`--d` 0 to 5) on Billing's blocks,
  on the Settings and Billing headers, the Connected AI apps rows and the AI
  assistants sections (Aiden Workspace only). Settings sections keep
  `nd-view-enter`.
- **Loading**: Settings and Billing show shimmer skeletons in the page's own
  shape (sub-nav pills + section; wallet card + this month's lines) with
  `aria-busy`, not two blank blocks.
- **Empties and errors**: illustrated `EmptyState` (orb) with one next step
  for no connected AI app, an empty AI activity list, and Billing switched
  off. `ErrorState` with Try again (calling the same read again) for
  Settings, Connected AI apps and the AI assistants page.
- **Phone (390px)**: Settings sub-nav pills, Billing buttons, the Connected
  AI apps buttons and the AI activity filters are 44px tall on a phone;
  Settings sub-nav links have a visible focus ring. Billing at 390px checked
  on the fake backend: no sideways scroll, Top up in the first screen.
- Radii follow spec.md (cards 18–20px, skeleton cards 18px).

## Decisions

- **Classic stays identical.** The AI assistants page and the Connected AI
  apps list draw both designs, so each new word, class and empty state is
  behind `useNewDesign()`. Classic gets the `classic` copy set, which is the
  old text byte for byte. `ConnectedAiAppsView` takes a `newDesign` prop that
  its container fills, so it still renders outside an org provider.
  `batch53-assistants.test.tsx` now mocks the design. Every old Classic
  assertion runs in both suite modes, plus new Aiden Workspace tests.
- **Section names kept** (Workspace, Team and roles, API and webhooks…). The
  classic cards inside each section, ⌘K and old links use the same names, so
  only the line under each one changed.
- **Top up is not pinned with StickyAction.** On a phone, `nd-rise` and the
  shell's `nd-view-enter` use `animation-fill-mode: both`, so the element
  keeps its transform after the animation ends. That makes it the containing
  block for `position: fixed` children, and the pinned button landed on top
  of the balance instead of above the bottom bar. Top up already sits in the
  first screen at 390px, so it stays where it is. **Shared fix needed
  (styles.css, not this slice):** use `backwards` instead of `both` on
  `.nd-rise` / `.nd-view-enter`. This affects every StickyAction inside the
  new shell.
- Two new links, each an empty state's one next step: "Write to us"
  (mailto, Billing switched off) and "See how to connect" (/developers#mcp in
  Settings, #connect on the AI assistants page). "See things to ask" jumps to
  #prompts. No new request, write or permission.
- The Home card (connect-card.tsx) moved its words to copy.ts, unchanged.
  Home's look is the Home slice's.

## Left unchanged on purpose (billing/legal/Batch 56)

- **Billing**: every amount and `money()` / `rateMoney()` output; "Credits
  available"; "₹… held for campaigns"; "Ready to spend"; the low-credit note;
  Top up / Request a top-up; "Pick a plan first — a locked or cancelled
  workspace can't buy credits."; "Spent since…", "AI answers", "Included in
  your plan this month", "Charged as you go", "… a month", "Talk to us about a
  plan", "Trial — no plan yet"; the rates table's category words; "Prices are
  per message[, before 18% GST]. Replies inside the 24-hour window are free.";
  Plans, "To change your plan, write to hello@aidwar.in", "Current plan",
  "Custom", "/ month", "+ 18% GST"; the failed-payment toast; every
  plan-state note (trial / locked / paused / past due / cancelled). These
  moved to copy.ts byte for byte, and a test pins them. Classic PlanChooser,
  BuyCreditsDialog, InvoicesPanel and HistoryTabs were not touched.
- **Settings**: "Receipts and low-credit notes go to the billing WhatsApp
  number…" (billing); the Connected AI apps blurb and its how-to line ("Add
  https://aidwar.in/mcp … Sending or switching on always asks you first.").
- **AI assistants (Batch 56: what an AI app may see and do, access given or
  taken back)**: the page description and route meta; the switched-off
  notice; "Removing one ends its access at once."; the workspace switch's
  label and explanation; the team-apps note; Remove / Keep / "Remove its
  access?"; every connect step, safety line and prompt (mcp-connect.ts,
  mcp-prompts.ts); the meters' labels; the Home card's text. Mode names
  Off / Draft / Replying don't appear on these screens.
