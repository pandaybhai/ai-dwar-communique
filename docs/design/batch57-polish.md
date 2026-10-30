# Batch 57: Aiden Workspace polish, motion and copy

The founder-approved preview is `docs/design/batch57-preview.html` (saved
unchanged); it sits on top of `spec.md`. The audit that drove the work is
`docs/design/batch57-audit.md`. Copy tables, before and after, per screen:
`docs/design/batch57-copy/*.md`.

## The 2-minute click-through

1. **Home** (`/app`). The page opens with shimmer in the page's own shape, then
   blocks rise in order: "Good morning, <your first name>" (workspace
   timezone), Aiden's live line under it ("Aiden is replying to 3 customers")
   and one line in Aiden's voice ("I've sent 41 replies today. 4 customers
   need you."). Right under it, ONE gold card with a moving border: the
   oldest customer who waits ("Asha Iyer asked: '…'"), the others named on one
   line, one main action. Today's numbers count up once. Switch the mode pill
   (Aiden replying / drafts / off): the ink pill slides. On a phone the gold
   card's Reply button sits above the bottom bar.
2. **Inbox** (`/app/inbox`). Open a chat Aiden answers where the customer has
   just written: the header reads "Aiden is typing…" and a dots bubble sits on
   Aiden's side, until Aiden's reply arrives live (or 90 seconds pass). If the
   customer ordered in the last 24 hours, the customer panel shows "New order
   today: ₹…" with a gold sparkle, once per order. No chats yet: the
   illustrated empty state with "Try me in a test chat".
3. **Campaigns** (`/app/campaigns`), New campaign, walk to the last step. The
   review step is exactly as before. The last button says "Send to 1,186
   customers" (or "Schedule for …", or "Send for approval" above your approval
   limit). Press it: a ring turns while the request runs, then completes, one
   burst of confetti, and "Sent! It's on its way to 1,186 customers. I'll show
   you who reads and replies." The dialog then closes onto the campaign, as
   before. The sub-tab pill slides to "Message designs" (Templates) and
   "Cards".
4. **Customers** (`/app/contacts`). Plain words for consent ("Said yes"), the
   "Groups" tab (Segments), illustrated empty list with Import a list.
5. **Automate** (`/app/employee`). Aiden's card speaks for itself ("I answer
   your customers on WhatsApp and pass anything I'm unsure about to you"),
   tiles count up, "Needs your answer" leads.
6. **Phone** (390px). Tap More: the sheet rises on a soft spring with a grab
   handle; "Switch to Classic" is the last row whenever the avatar menu offers
   it.
7. **Reduced motion** (OS setting): every number shows its final value, typing
   shows whole, nothing moves; the shimmer is still.

## Decisions made within spec.md and the brief

- **Greeting is the title, Aiden's line is the subtitle.** The approved preview
  greets by name; the existing live headline (real counts) stays right under
  it, so no information is lost.
- **One gold card on Home.** The first waiting customer up front, the others
  named on one line ("Also waiting: Rohan, Manish and 1 more."). Nothing is
  removed: every item is still one tap away in the Inbox, and Approve /
  Decline (Batch 51) stay on the card.
- **"Aiden is typing" is inferred, never invented.** Shown only when Aiden is
  Replying, the chat is one Aiden answers (open, not assigned, not waiting for
  a person), the newest message is the customer's and is under 90 seconds old.
  Home shows the dots on feed rows from its existing realtime subscription. No
  new read.
- **The send moment never claims delivery.** After launch the words say it is
  on its way; the campaign page shows sent / delivered / read as before. A
  scheduled campaign or one waiting for approval gets no confetti.
- **The sale sparkle** marks an order the shop synced in the last 24 hours
  for this customer (the panel's existing orders read), once per order per
  tab. It does not claim the chat caused the sale.
- **Confetti has no dependency.** Magic UI's confetti needs `canvas-confetti`;
  ours is a 70-particle canvas burst in `magicui/confetti-burst.tsx`.
- **Empty-state orb breathes ("draft"), it does not ripple.** spec.md keeps
  ripples for Aiden actually replying.
- **Shimmer is CSS only** (`.animate-pulse` under `html[data-design="new"]`),
  so Classic's markup stays byte for byte.
- **Blur on page enter is desktop-only.** A blur over a whole phone screen
  costs frames on a mid phone; phones get the plain fade.
- **Entrances fill `backwards`.** A finished entrance must not keep a
  transform, or it anchors every `position: fixed` child (the sticky action).
- **Visible names only:** "Message designs" (Templates), "Groups" (Segments),
  "Your numbers" (Analytics in More). Routes, query params, code and API names
  are unchanged.
- **Kept word for word:** mode names Off / Draft / Replying, Meta's template
  categories and review states, opt-out and 24-hour policy lines, every amount
  and billing line, invoices and GST, Batch 56's AI-access and privacy text.
- **The wizard's last button** lives in the shared classic wizard; its new
  label, the ring and the confetti are behind `useNewDesign()` there. Classic
  still says "Launch campaign" and shows its toast.
