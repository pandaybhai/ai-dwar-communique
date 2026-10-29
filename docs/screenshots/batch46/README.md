# Batch 46: the new Inbox

Fake data only (`scripts/ui-shots/fake-backend.mjs`); nothing touched the live
database, WhatsApp or Meta.

- `compare/`: the approved preview (`docs/design/preview.html#inbox`) next to
  the app with `new_design` on, at 1440 and 390: list, an open chat (Aiden on
  it), a chat waiting for you (with "Draft a reply" pressed), and the empty
  Inbox (the preview has no empty state). `node scripts/ui-shots/compare-inbox.mjs`
- `new/`: every state with the flag on, 1440 (`-desktop`) and 390
  (`-mobile`): list, chat, needs-human, taken over, window closed, empty, and
  the phone after the back arrow. `node scripts/ui-shots/shoot.mjs --set b46 --design new --out docs/screenshots/batch46/new`
- `classic/`: the same pages with the flag off, the Batch 39 Inbox.
  `node scripts/ui-shots/shoot.mjs --set b46 --design classic --only inbox-list,inbox-chat,inbox-empty --out docs/screenshots/batch46/classic`

Flag off against untouched `main` (Batch 44's `classic/inbox-*.png`, same fake
data): the list is pixel-identical at 1440 and 390; the open chat differs only
in the bubbles' clock times (0.11% / 0.29% of pixels), which are relative to
when the shot was taken.
