# AiDwar design spec (Batch 44 onward)

The approved preview is **`docs/design/preview.html`** (the founder's artifact,
saved unchanged). Open it in a browser: hash routes `#home #inbox #campaigns
#customers #automate #shop`; the phone layout starts at 700px. Screenshots of it
at 1440 and 390 are in `docs/screenshots/batch44/preview/`. When this file and
the preview disagree, the preview wins, except where a colour is listed under
"Contrast fixes" below.

The live reference in the app is **`/app/design`** (every token and shared
component, with motion). Batches 45 to 50 build screens from this spec.

## Rollout

The whole new look sits behind the per-workspace feature flag **`new_design`**
(feature registry entry `new_design`, migration
`supabase/aidwar-migrations/20261180_batch44_new_design_flag.sql`, default off).

- Flag off (or the flag row missing): the Batch 39 to 41 look and sidebar,
  byte for byte.
- Flag on: `<html data-design="new">` turns on the tokens below, the new shell
  (`src/components/shell/new-shell.tsx`) replaces the sidebar, and the `nd:`
  Tailwind variant restyles the shadcn primitives.
- One switch decides it: `useNewDesign()` in `src/lib/new-design.ts`.

Rules for Batches 45 to 50 while the flag exists:

1. New-look styles go behind `html[data-design="new"]` (CSS) or the `nd:`
   variant (class strings): `nd:bg-ink nd:text-ink-foreground`.
2. A screen rebuilt for the new design renders its new version only when
   `useNewDesign()` is true and keeps its current version otherwise.
3. The classic shell (`src/components/app-shell.tsx`) stays until Batch 50 is
   done and the founder says to remove it.

## Tokens

Defined in `src/styles.css` under `html[data-app][data-design="new"]`. Light
only for now; the dark values are defined under `.dark` but the theme switch is
hidden while the new design is on (Batch 50 decides dark).

| Token | Value | Use |
| --- | --- | --- |
| `--ground` → `background` | `#F3F7F6` | Porcelain page canvas |
| `--surface` → `card`, `popover` | `#FFFFFF` | Cards, menus, inputs, the active nav pill |
| `--line` → `border`, `input` | `#DCE7E4` | Every hairline and control border |
| `--text` → `foreground`, `ink` | `#0D2B2A` | Deep peacock ink: text, dark primary buttons, the phone frame |
| `--muted` → `muted-foreground` | `#4F6663` | Secondary text, idle nav items |
| `--aiden` | `#0F9D74` | Emerald: Aiden's orb, bars, focus ring |
| `--aiden-deep` → `primary` | `#0A7A5A` | Emerald text on light: links, "Aiden" labels, active tab text |
| `--aiden-soft` | `#E3F6EF` | Selected tab, active bottom-bar item, tags |
| `--aiden-glow` | `rgb(15 157 116 / .32)` | The orb's glow |
| `--gold` | `#F2B544` | Decisions: gold buttons, waiting counts, beam |
| `--gold-ink` | `#6E4100` | Text on gold and on gold-bg |
| `--gold-bg` → `warning-soft` | `#FFF6E3` | The "needs you" card, system notes in a chat |
| `--gold-line` → `warning-border` | `#F1DDB3` | Gold card hairlines, the countdown track |
| `--bubble-in` → `secondary`, `muted` | `#EEF3F2` | Customer bubble on white, quiet fills |
| `--bubble-out` | `#DDF6EA` | Business / Aiden bubble |
| `--on-dark` → `ink-foreground` | `#FFFFFF` | Text on ink |
| `--shadow-ink` | `rgb(13 43 42 / .16)` | The only shadow colour |
| `--av1..5` / `--av1..5-ink` | peach, blue, violet, green, pink | Contact avatars |

Status tokens map onto the family: `success*` = Aiden, `warning*` = gold;
`danger*` and `info*` keep Batch 39's hues.

### Contrast fixes (decided in Batch 44)

Every text pair is at least 4.5:1. Two preview colours failed and were nudged
darker; nothing else changed:

| Pair | Preview | Ratio | Now | Ratio |
| --- | --- | --- | --- | --- |
| aiden-deep on aiden-soft / bubble-out | `#0B7F5E` | 4.44 / 4.38 | `#0A7A5A` | 4.74 / 4.68 |
| gold-ink on gold | `#7A4800` | 4.16 | `#6E4100` | 4.74 |

Checked pairs: text on ground 13.9, muted on ground 5.7, muted on white 6.2,
muted on bubble-in 5.5, white on ink 15.0, gold-ink on gold-bg 8.1, every
avatar pair 6.7 or more. Focus ring (aiden on ground) 3.2, above the 3:1 for
non-text.

## Type

| Role | Face | Size / line / weight | Tracking |
| --- | --- | --- | --- |
| Display (page title, `h1`) | Bricolage Grotesque | clamp(32px, 4.6vw, 52px) / 1.02 / 800 | -1.6px (-1px on phones, 30px) |
| Page head (`.phead h1`) | Bricolage Grotesque | clamp(28px, 3.4vw, 40px) / 1.05 / 800 | -1px |
| Section head (`h2`, `.h3x`) | Bricolage Grotesque | 18 to 22px / 1.25 / 600 | 0 |
| Big number | Bricolage Grotesque | 24 to 28px / 600 | tabular numbers |
| Wordmark | Bricolage Grotesque | 22px / 800 | -0.5px, lower case "aidwar" |
| Body | Instrument Sans | 16px / 1.5 / 400 | 0 |
| Nav, buttons | Instrument Sans | 14 to 15px / 600 to 700 | 0 |
| Small, meta | Instrument Sans | 13 to 14px / 500 | 0 |
| Bottom-bar label | Instrument Sans | 11.5px / 600 | 0 |

Fonts load from Google Fonts in the document head (no package). Labels are
never tracked capitals: under the new design `type-label` is sentence case,
untracked.

## Radii

| Thing | Radius |
| --- | --- |
| Buttons, inputs, kbd hosts | 11 to 12px (`rounded-lg` = 11px) |
| Menus, chat rows, suggestion box | 14px (`rounded-xl` = 15px) |
| Cards, feed items, drafts | 18 to 20px (`rounded-2xl` = 19px) |
| Big panels (inbox) | 22px (`rounded-3xl` = 23px) |
| Bottom sheet | 24px top corners |
| Phone frame / screen | 36px / 28px |
| Nav items, tabs, chips, counts | full pill |

`--radius` is 11px under the new design; Tailwind's `rounded-*` steps follow.

## Shadows

All from one colour, `--shadow-ink`, soft and low:

| Token | Value | Use |
| --- | --- | --- |
| `shadow-xs` | `0 1px 2px` | Active nav pill, chat bubbles |
| `shadow-sm` | `0 1px 2px` + `0 8px 20px -16px` | Buttons on hover, small cards |
| `shadow-md` | `0 10px 28px -20px` | Feed items, list cards |
| `shadow-lg` | `0 18px 40px -16px` | Menus, popovers |
| `shadow-xl` | `0 20px 50px -30px` | Big panels, the bulk bar |
| `shadow-2xl` | `0 30px 60px -30px` | Phone frame, dialogs, sheets |

## Motion

- Easing `cubic-bezier(.2,.8,.2,1)` for everything that arrives; linear only
  for the beam.
- Durations: hover 200 to 250ms; list items slide in 500ms (`translateY(-12px)
  scale(.98)` to rest); views fade 350ms (`translateY(6px)`); sheets rise 300ms;
  bars grow 1.2s; numbers tick 1.2s ease-out cubic.
- Only `transform` and `opacity` animate (plus `background-color` / `color` on
  hover). Never `transition: all`, never width / height / top / left.
- Loops (orb ripple 2.4s, orb breathe 4s, beam 4s, caret blink 1s, oldest
  waiting pulse 2s) are reserved for live state: Aiden working, Aiden waiting,
  something needs you.
- `prefers-reduced-motion: reduce` turns every animation and transition off;
  tickers show the final number, typing shows the whole text, lists show all
  items.

## Layout

- Container: max 1200px, centred, 16px side gutter (safe-area aware), 28px
  between blocks.
- Desktop top bar (over 700px): wordmark, six pill nav items (Home, Inbox with
  the gold waiting count, Campaigns, Customers, Automate, Shop), spacer,
  "Search or jump ⌘K" (opens the command palette), the avatar menu.
- Phone (700px and under): wordmark and avatar on top; a fixed bottom bar
  Home / Inbox (gold badge) / Campaigns / Customers / More, safe-area padded;
  More opens a bottom sheet (Automate, Shop, Analytics, Settings, Billing and
  wallet, Team). Inside an open chat both bars step aside
  (`html[data-chat-open]`).
- Page head (`.phead`): the section's name as the title, its sub-tabs as pills
  (selected = aiden-soft / aiden-deep), actions on the right; under 700px the
  actions wrap below.

## Sections and sub-tabs

| Section | Sub-tabs (route) |
| --- | --- |
| Home | (none); Analytics lives here (`/app/analytics`, "See all numbers", ⌘K) |
| Inbox | (none) |
| Campaigns | Campaigns `/app/campaigns` · Templates `/app/templates` · Cards `/app/cards` |
| Customers | Contacts `/app/contacts` · Segments `/app/contacts?tab=segments` · Sales from chats `/app/receipts` |
| Automate | Aiden `/app/employee` · Flows `/app/flows` · Automations `/app/automations` |
| Shop | Catalogue `/app/catalog` · Collections `/app/catalog/collections` · Shopify `/app/settings?tab=integrations` |
| Avatar menu | Settings · Billing and wallet · Team (`/app/settings?tab=team`) · Switch workspace · Super Admin · Log out |

Every tab and item is filtered by the same feature flags and permissions as
the sidebar (`filterNavItems` in `src/components/shell/use-nav.ts`); a
registry page the map doesn't know yet appears in the avatar menu and the More
sheet. `src/lib/batch44-shell.test.ts` fails if any page the sidebar shows, for
any role and flag mix, can't be reached in the new shell.

## Buttons

| Variant | Look | Use |
| --- | --- | --- |
| `default` | Ink fill, white text, 700 | The one primary action per view |
| `gold` | Gold fill, gold-ink text, 700 | A decision the owner makes (approve, send the suggestion) |
| `outline` / `secondary` | White, line border, ink text, 600 | Everything else |
| `ghost` | No fill, muted text | Toolbars |
| `soft` | aiden-soft fill, aiden-deep text | Tinted secondary |
| `destructive` | Danger fill | Confirming loss only |

## Shared components

All in `src/components/design-v2/` (motion sources from Magic UI in
`src/components/magicui/`, restyled to the tokens):

| Component | What it is |
| --- | --- |
| `AidenOrb` | The emerald orb. `state="replying"` ripples, `"draft"` breathes, `"off"` (team) is pale and pulses gently |
| `NeedsYouCard` | Gold card with the moving border beam; title, body, actions |
| `NumberTicker` | Counts up to a number once in view (Indian grouping by default) |
| `AnimatedList` | Items slide in from the top, newest first |
| `TypingText` | Types a reply with a blinking caret |
| `WhatsAppBubble` | `in` / `out` / `system`, sender label, time, ticks; `ProductBubble` for a product card |
| `PhoneFrame` | The ink phone with a dotted chat wall |
| `CountdownRing` | Gold ring for a closing 24-hour window |
| `PageHeader` | Title, sub-tabs, actions (the section's tabs come from the shell) |
| `BottomSheet` | Phone sheet that rises from the bottom, safe-area padded |
| `AvatarCircles` | Overlapping contact avatars with a "+N" |

## Hallmark floor (applies to every new-design screen)

Tokens only; no `transition: all`; no tracked-capitals labels; no middle-dot
strings; no decorative dots; no card inside a card; `:focus-visible` on every
control; a reduced-motion fallback for every animation; `overflow-x: clip` on
html and body; no invented metrics.

## Home (Batch 45)

`/app` with the flag on renders `NewHome` (`src/components/home-v2/`); with it
off, the Batch 41 Home in `src/routes/app/index.tsx` exactly as before
(`batch45-home.test.tsx` pins its code). Which of the three Homes shows is the
mode Aiden really runs in (`homeModeFor` in `src/lib/new-home.ts`: the plan's
AI, the workspace AI switch, the default agent's mode; a plan without AI is
always Off).

| Block | Where the number comes from |
| --- | --- |
| "Aiden is replying to N customers" | Open chats, not assigned, not waiting for a person, with a customer message in the last 30 minutes |
| Aiden's latest replies | `agent_reply` runs matched to the message that was sent (the Inbox's `aiRunFor`), one per chat; `ai_runs.metadata` is not readable by members, so background runs are told apart this way |
| Needs you | `needs_human` chats, then held owner questions (`/api/home/summary` waiting), at most 3 |
| Today | Chats and Aiden's replies from `/api/home/summary`; sales from chats (Receipts' attribution, when any order in 30 days), else credits; drafts written today; flow runs today |
| "N replies are ready for you" | Draft-mode `suggest_reply` runs with no `user_id` from the last 24 hours, latest per chat, with nothing sent in that chat since |
| "N customers are waiting" | Open chats from the last 7 days whose newest message is the customer's, or that wait for a person; oldest first |
| Free replies running out | Chats whose 24-hour window, from their newest customer message, closes within 2 hours (exactly 2 h in, closed out) |
| Your flows today | Flows v2 `flow_runs` since the local day began, per flow |

Every send (draft Send / Edit / Write my own) goes through the Inbox's
`sendInboxText`, every assign through `assignConversation`, the mode switch
through `set_mode`. Live updates use the Inbox's `subscribeInboxChanges`.

## Inbox (Batch 46)

`/app/inbox` with the flag on renders `NewInboxView`
(`src/components/inbox/v2/`); with it off, the Batch 39 `InboxView` exactly
as before (`batch46-inbox.test.tsx`). Three panes: chat list | chat | customer
panel (inline from 1280px, a sheet below); on a phone the list, then the chat
full screen with a back arrow, both bars stepping aside (`data-chat-open`,
set only at 700px and under).

| Piece | Where it comes from |
| --- | --- |
| Waiting for you (gold count) | The classic "Waiting for you" filter: `needs_human` |
| Aiden on it | Open, not `needs_human`, not assigned: the chats `ai-agent.server.ts` answers. Reads "Nobody on it" when Aiden's mode is Off or Draft |
| Done | The classic "Closed" filter. All chats, Open and Assigned to me stay under "More filters"; Unread, Unassigned, search, number and j/k/Enter/r/e/a/"/" as before |
| Aiden badge on a row | That row is an Aiden-on-it chat and Aiden's mode is Replying |
| 24-hour window chip | `isServiceWindowOpen` on `last_customer_message_at` (every send path's rule; exactly 24 h is still open): "Free replies for N more hours/minutes", gold under 2 hours, else "Window closed: send a template" |
| Take over from Aiden / Hand back to Aiden | The per-chat switch Aiden already obeys: take over = assign to me (`assignConversation`); hand back = unassign and Mark as handled (`needs_human` cleared), only what is set |
| "Aiden paused" note | `needs_human_reason` in Aiden's words (`handoverReasonText`), the question, what the customer was told, who on the team was told |
| Aiden suggests | The composer's "Draft a reply" (`suggest_reply`), shown with Send (`sendInboxText`) and Edit; never run on its own |
| "/" in an empty box | The template, picture card and form pickers already in the composer |
| Customer panel | Labels, opt-in, the language they write in and their question (Aiden knows), this chat, the shop's `orders` for the contact (with `integrations.view`), photos and files in the chat |

"Aiden is typing" is left out: nothing the Inbox reads says Aiden is mid-reply.

## Automate and Shop (Batch 49)

The preview draws only these sections' headings and tabs, so the screens are
designed in its language. Each route switches on `useNewDesign()`; with it off
the classic page renders, and `batch49-automate-shop.test.tsx` pins the classic
page's code to main's bytes. New code lives in `src/components/automate-v2/`
and `src/components/shop-v2/`; every existing control stays, as the same
component with the same props, below the new blocks.

| Screen | New (read only, or the classic call) | Kept as it is |
| --- | --- | --- |
| Automate > Aiden `/app/employee` | Orb + status card (Off / Drafts / Replying, the Employee page's lock while AI is switched off, `set_mode` through the shared `useAidenModeSwitch`, Turn on = `save_settings`); Test Aiden in a `PhoneFrame` (the Playground's `playground` run); Needs your answer (gaps with `answer_gap` / `dismiss_gap`, the week's passed-on answers with the work log's `correct`); What Aiden knows (overview sources and the catalogue's count, with freshness) | AidenSetupCard, WeeklyReport, the test gate, and every tab: My job, What I know, Questions for you, How I behave (behaviour, hand-off alerts, prompt), My brain & tools, Forms, Try me, My work |
| Automate > Flows `/app/flows` | Chat flow cards: mini map from the published (else draft) graph, status, triggers in the Triggers panel's names, runs; run history per flow (last 10 runs on the `(flow_id, started_at)` index, each step named from the run's own version) | Restore, create from a starter and the Batch 35 delete dialog (the classic calls); Store flows (FlowsView); What was sent (SendsLog) |
| Flow builder `/app/flows/v2/$id` | `.nd-flow-builder` styles (canvas dots, links, minimap, zoom, palette in sentence case) and a step card coloured by palette group: Messages emerald, Ask gold, Logic violet, Actions blue, Start ink | The editor, its reads, saves, publish and every handle id (the test renders both step cards for every step type and compares handles) |
| Automate > Automations `/app/automations` | Grouped by kind (Welcome message, Keyword replies, Off-hours), the reply as a WhatsApp bubble | The switch and delete (the classic functions, line for line), AutomationDrawer |
| Shop > Catalogue `/app/catalog` | Overview: counts (all, website, store, hidden, without a photo, collections), newest change, ProductsSummary's Refresh from website; a phone showing two real visible products as a WhatsApp shop message | WhatsAppShopCard, CategoryWordsCard, CatalogView (grid, filters, bulk actions, product dialog, upload) |
| Shop > Collections `/app/catalog/collections` | A card per collection with up to four of its products' photos | CollectionsView (new, edit, order, assign, delete) |

Keyword replies are automations of the keyword kind, so they live on the
Automations tab; Forms stay on Aiden's Forms tab (the shell's Automate tabs are
Batch 44's map). Shopify stays the shell's jump to Settings > Integrations.
