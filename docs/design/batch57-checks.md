# Batch 57: checks

## Lighthouse (Home and Inbox, before = main a747bc1, after = this branch)

Lighthouse 12.6.1 (dev-only, not a project dependency), run twice on each side
against the Vite dev server with the fake backend (`scripts/ui-shots/
fake-backend.mjs`, Aiden replying, 40 chats), desktop at 1440 and mobile at
390. The app's production build targets Cloudflare (Nitro), which cannot be
served locally, so both sides were measured on the dev server under the same
conditions: absolute LCP and Performance are dominated by unbundled dev
modules and are only comparable side by side.

| Page | Accessibility | Performance | CLS | TBT (ms) |
| --- | --- | --- | --- | --- |
| Home, desktop | 100 → **100** | 25 → 25 | 0.003 → 0.003 | 2,125 / 2,607 → 3,149 / 3,264 |
| Home, mobile | 100 → **100** | 13 / 14 → **24 / 24** | 0.246 / 0.243 → **0.094 / 0.087** | 2,803 / 2,945 → 2,613 / 3,050 |
| Inbox, desktop | 100 → **100** | 25 → 25 | 0.009 / 0.002 → 0.006 / 0.006 | 3,008 / 2,778 → 2,603 / 3,075 |
| Inbox, mobile | 100 → **100** | 27 / 26 → 26 / 26 | 0.001 → 0.001 | 2,368 / 2,800 → 3,024 / 2,975 |

No failing accessibility audit on either side. Home on a phone shifts far less
(the skeleton now has the page's own shape).

Home desktop TBT came out higher in both Lighthouse runs, so it was measured
directly as well: long tasks (time over 50 ms) on Home at 1440 with the CPU
slowed 4×, six loads each after a warm-up: main 2,303 to 2,540 ms (average
2,430), this branch 2,195 to 2,889 ms (average 2,537). The ranges overlap;
unthrottled, 200 to 347 ms against 198 to 361 ms. See the PR for the follow-up.

## Hallmark (github.com/Nutlope/hallmark v2.0.0, dev-only)

`node skills/hallmark/scripts/sloplint.mjs <every Aiden Workspace folder> --scope app`
(static tier: the render tier drives its own browser and cannot reach the fake
backend).

| | FAIL | WARN |
| --- | --- | --- |
| main | 7 | 10 |
| this branch | **1** | 5 |

Fixed: the flow builder CSS stamp (20), colour literals (48, two), `overflow:
hidden` (34), a dash used as an empty table cell (19), a dash in Billing's copy
(19, Billing slice), straight quotes (F1) in the Inbox and Billing.

Left, with the reason:

- FAIL 4, `empty-state.tsx:109`, "card nested in card": Classic's icon tile in
  the Classic branch of `EmptyState`. Classic must stay pixel-identical; Aiden
  Workspace renders the orb version, which has one containment layer.
- WARN 28a (3), "lazy-loaded first image": a flow card's, a collection card's
  and a message preview's pictures. None is the page's LCP (they sit below the
  page head), so they stay lazy.
- WARN 49, chat-list label: the composed screen-reader label of a chat row,
  not visible text.
- WARN F1, `ai-assistants/parts.tsx` "Your team's apps": Batch 56 owns that
  wording; left as is.

The Hallmark floor (spec.md) is also held by tests: `batch57-polish.test.tsx`
checks every Batch 57 animation is in the reduced-motion block and that no
`transition: all` exists; the screen tests check focus-visible and tokens as
before.

## Classic unchanged

`docs/screenshots/batch57/classic-proof/README.md`: 29 screens identical to
main pixel for pixel; 15 differ only in clock-driven times and the frame of
Classic's live dot. The classic markup pins in batch45 to batch53 tests pass.

## Tests

`npx tsc --noEmit -p .` clean; `bun run test` 2,413 passed, 5 skipped;
`bun run test:new-design` 2,413 passed, 5 skipped; `bun run build` passes.
