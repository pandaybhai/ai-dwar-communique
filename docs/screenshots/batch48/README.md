# Batch 48: the new Customers

Fake data only (`scripts/ui-shots/fake-backend.mjs` with `fake-customers.mjs`);
nothing touched the live database, WhatsApp, Meta or Cashfree.

- `compare/`: the approved preview (`docs/design/preview.html#customers`) next
  to the app with `new_design` on, at 1440 (`-desktop`) and 390 (`-phone`): the
  list and three rows selected (the bulk bar). The preview draws only the list,
  so the drawer, the three import steps, Segments and Sales from chats are shown
  on their own. `node scripts/ui-shots/compare-customers.mjs`
- `new/`: every state with the flag on, 1440 and 390: the list, a filter chip
  on (`?opt_in=unknown`), rows selected, the drawer (a sheet on the phone), the
  empty list, the import's upload / match columns / confirm steps, Segments and
  Sales from chats. `node scripts/ui-shots/shoot.mjs --set b48 --design new --out docs/screenshots/batch48/new`
- `classic/`: Contacts, Segments and Receipts with the flag off.
  `node scripts/ui-shots/shoot.mjs --set b44 --design classic --only contacts,segments,receipts --out docs/screenshots/batch48/classic`

Flag off against untouched `main` (both shot one after the other, same fake
data): Contacts, Segments and Receipts are pixel-identical at 1440 and 390
(one segment count's loading pulse differs by 1 colour level on the phone).
