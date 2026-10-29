# Batch 49: the new Automate and Shop

Fake data only (`scripts/ui-shots/b49-backend.mjs` over the shared
`fake-backend.mjs`, which is unchanged); nothing touched the live database,
WhatsApp, Meta or Cashfree.

- `compare/`: for each screen at 1440 (`-desktop`) and 390 (`-phone`), three
  pictures side by side: the approved preview's `#automate` / `#shop`
  (`docs/design/preview.html` draws only the heading, the sub-tabs and one
  line for these sections), the app with `new_design` on, and the app with it
  off. `node scripts/ui-shots/b49-compare.mjs`
- `new/`: every state with the flag on, 1440 (`-desktop`) and 390
  (`-mobile`): Aiden (replying, drafts, switched off, nothing waiting, a test
  answer in the phone, Teach Aiden open), Flows (list with run history,
  deleted flows, empty), the builder, Automations (and empty), Catalogue (and
  empty), Collections. `node scripts/ui-shots/b49-shots.mjs --design new --out docs/screenshots/batch49/new`
- `classic/`: the same six screens with the flag off.
  `node scripts/ui-shots/b49-shots.mjs --design classic --only aiden,flows,flow-builder,automations,catalogue,collections --out docs/screenshots/batch49/classic`

Flag off against untouched `main` (a worktree of `origin/main` on another
port, same script, same fake data): all 12 classic shots (6 screens at 1440
and 390) are pixel-identical.

Every run reported no console errors and no horizontal page scroll at either
width. Lighthouse accessibility (snapshot mode, 1440): Aiden, Flows,
Automations, Catalogue and Collections 100; the builder 96 (its existing
flow-name input has no label: `flow-editor.tsx`, classic code, left as is).
