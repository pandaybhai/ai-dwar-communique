# Batch 57 audit: Aiden Workspace, before the polish pass

Screenshots: `docs/screenshots/batch57/before/` (1440 and 390, fake backend
only, `node scripts/ui-shots/shoot.mjs --set b57 --design new`, Automate and
Shop with `b49-shots.mjs`, the switch and intro with `b53-shots.mjs`).
Reference: `docs/design/preview.html` + `spec.md`, and the founder-approved
Batch 57 preview `docs/design/batch57-preview.html`.

Ranked by impact on the first minute (1 = biggest). Each line says what is
wrong today; the fix is in the PR.

## 1. Home (every mode, empty, new workspace)

1. **No "what to do now".** Three things compete on load: the hero, the gold
   "Needs you" card (up to 3 items, each with its own line) and the feed. The
   approved preview has one gold card with one action. *Fix: greeting by name,
   one-line status, then ONE gold card naming the oldest thing that waits, with
   a single button; the rest stays in the Inbox.*
2. **Loads with a blank, then pops.** Home shows nothing while it reads, then
   every block appears at once. *Fix: shimmer skeleton in the page's own shape,
   then a blur-fade top to bottom.*
3. **Numbers do not count up** in the Today panel (the ticker is used on two
   numbers only, and re-ticks on every live update). *Fix: NumberTicker on every
   Today number, once on first load only.*
4. **No greeting / no person.** The page never says the owner's name. *Fix:
   "Good morning, Riya" from the profile's first name (time of day from the
   browser's clock).*
5. **Live feed has no sense of Aiden working.** *Fix: a reply bubble with typing
   dots while a customer's newest message has no answer yet in a chat Aiden is
   on (real data only), then the real reply.*
6. **Empty workspace:** a one-line white card ("Aiden's replies show here…")
   floating alone under the hero. *Fix: illustrated empty state with the orb and
   one next step.*
7. Mode switch reads "Aiden replying / Aiden drafts / Aiden off" while the
   Automate page says "Off / Drafts / Replying". *Kept as is: mode names are a
   stop-and-ask item; copy around them is warmer.*
8. Phone: the main action (Reply / Approve) scrolls away. *Fix: sticky main
   action above the bottom bar, safe-area padded.*

## 2. Shell (top bar, bottom bar, More sheet, avatar menu, ⌘K)

1. **Nav highlight jumps** between items. *Fix: a sliding pill
   (shared-layout motion), the sub-tab pill slides the same way.*
2. **More sheet** rises linearly, has no grab handle, and "Switch to Classic"
   lives only in the avatar menu. *Fix: spring rise, grab handle, "Switch to
   Classic" as the last row (the same `DesignSwitchItem` action).*
3. Pages appear with no entrance on route change. *Fix: page-enter blur-fade
   (350ms, `translateY(6px)`), no layout shift.*
4. More sheet labels "All numbers" (jargon for Analytics). *Copy fix.*

## 3. Inbox (list, open chat, empty)

1. **"Aiden is typing" is missing** (Batch 46 left it out). *Fix: in the header
   and as a dots bubble at the end of the chat, shown only when the chat is
   Aiden-on-it, Aiden is Replying, and the newest message is the customer's
   from the last 90 seconds. It disappears the moment the reply arrives over
   the live channel. No new read.*
2. **Empty state is two different empties side by side** (list column icon +
   a white card in the chat pane). *Fix: one illustrated empty state with the
   orb in the chat pane; the list says "All caught up".*
3. List shows no skeleton while loading (blank). *Fix: shimmer rows.*
4. Copy: "Waiting for you / Aiden on it / Done" fine; "Catch me up", "Suggest
   labels" fine; "Type a message, or / for templates" uses jargon. *Copy fix.*
5. A sale from a chat (Receipts' attribution) is not celebrated. *Fix: the
   customer panel's order shows a one-time gold sparkle chip when the chat has
   an attributed order.*

## 4. Campaigns, Templates, Cards

1. **Sending feels like nothing happened.** After the confirm step, the
   wizard closes and the list updates. *Fix: the wizard's final button says
   "Send to N customers" (N = the real estimate), the confirm step stays
   exactly as today; after a successful launch, a progress ring then one burst
   of confetti and "Sent", once.*
2. Empty Campaigns: generic card. *Fix: illustrated, one next step.*
3. "Templates" and "Cards" as visible labels are jargon. *Fix (approved):
   visible label "Message designs" (routes and code names unchanged); Cards
   keep their name with a one-line explanation.*
4. Bars on the results card grow, but the numbers above them do not tick.
   *Fix: NumberTicker.*

## 5. Customers (contacts, segments, drawer, sales from chats)

1. **Empty list** shows "No customers match these filters" in a table frame.
   *Fix: illustrated empty state with avatars and Import as the one step.*
2. "Segments" is jargon. *Fix (approved): visible label "Groups" with a one-line
   explanation; route `?tab=segments` and code unchanged.*
3. "opt-in" appears raw in the page description and the bulk action ("Mark all
   unknown as opted in"). *Copy fix with a plain explanation the first time.*
4. Drawer slides with the default sheet easing. *Fix: spring.*

## 6. Automate (Aiden, Flows, Automations)

1. **Aiden page is long and flat**: the status card, needs-answer list, review
   list, weekly report and the classic tabs are stacked with equal weight.
   *Fix: tighter spacing, numbers tick, "Needs your answer" leads.*
2. Copy speaks about Aiden in third person where Aiden is talking ("Aiden
   answers customers…"). *Fix: first person where Aiden talks.*
3. Flows/Automations empty states generic. *Fix: illustrated.*

## 7. Shop (Catalogue, Collections)

1. Counts are static. *Fix: NumberTicker.*
2. Empty catalogue generic. *Fix: illustrated, one next step.*

## 8. Settings, Billing and wallet, AI assistants

1. Loading uses spinners in places. *Fix: shimmer skeletons.*
2. Wallet balance does not tick. *Fix: NumberTicker (amount unchanged).*
3. Billing amounts, legal and policy text, and anything Batch 56 owns
   (`/privacy`, `/ai-assistants` FAQ, `/oauth/consent`, MCP server files): **not
   touched**.

## 9. Everywhere

1. Two EmptyState looks (icon tile vs plain line vs white card). *Fix: one
   `EmptyState` with an `nd:` illustrated look (orb + one step).*
2. Skeleton pulses instead of shimmering. *Fix: `nd:` shimmer on `Skeleton`.*
3. Cards and buttons lack hover/press feedback in places. *Fix: shared
   `nd:` lift on hover, scale .98 on press.*
4. Reduced motion: all new motion is off, numbers show final values, typing
   shows whole text.
5. Classic: untouched (every `nd:` class and every new branch is behind
   `useNewDesign()` / `html[data-design="new"]`).
