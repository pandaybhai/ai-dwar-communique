# AiDwar design system (Batch 39)

> **Replaced by [`docs/design/spec.md`](design/spec.md) (Batch 44).** The new
> design (approved preview: [`docs/design/preview.html`](design/preview.html))
> is rolled out per workspace behind the `new_design` flag. This file still
> describes the classic look that a workspace with the flag off sees, and it is
> removed with that look after Batch 50.

The live reference is **`/app/design`** (signed in; not in the nav — open it by
address or from ⌘K → "Design system"). It shows every token and component in
light and dark. This file is the short version for whoever builds the next
screen (Batches 41–43: Home/Campaigns/Templates, Flows/Contacts/Aiden,
Settings/Billing/Onboarding/website).

## Rules

1. **Semantic tokens only.** `bg-card`, `text-muted-foreground`,
   `border-border`, `bg-warning-soft text-warning-soft-foreground` … never
   `bg-white`, `text-slate-500`, `bg-amber-50` or hex values. Raw scales
   (`brand-*`, `gray-*`) are for charts and illustrations.
2. **Every pair works in both themes.** Text tokens on their surfaces meet
   WCAG AA (4.5:1) in light and dark. If you need a new pair, add it to
   `src/styles.css` (light in `:root`/`html[data-app]`, dark in
   `html[data-app].dark`) and check it.
3. **The app's look is scoped.** Tokens switch to the app's values under
   `html[data-app]` (set on `/app` only), so the marketing site and the
   developer portal are untouched until Part 4 moves them over.
4. **One primary button per view.** Outline for secondary actions, ghost in
   toolbars, `soft` for a tinted secondary, destructive only to confirm loss.

## Tokens (src/styles.css)

| Kind | Use |
| --- | --- |
| Surfaces | `background` (canvas), `card` (panes, inputs), `popover` (menus, dialogs), `subtle`, `muted`, `accent` (hover/selected), `border`, `border-strong`, `primary` |
| Text | `foreground`, `muted-foreground`, `faint` (placeholders, quiet hints), `primary` |
| Status | `success` / `warning` / `danger` / `info`, each with `-foreground` (on solid), `-soft` + `-soft-foreground` (tinted), `-border` |
| WhatsApp | `wa-wall`, `wa-in`, `wa-out`, `wa-text`, `wa-meta`, `wa-meta-out`, `wa-tick`, `wa-link`; classes `.wa-wall`, `.wa-bubble-in/out`, `.wa-tail`, `.wa-meta` |
| Type | `type-display` (page title), `type-title`, `type-heading`, `type-label` (overline), `text-body` (15px reading), `text-sm` (14px dense UI), `text-xs`, `text-2xs`, `.tabular` |
| Space | Tailwind's 4px grid |
| Radii | `rounded-md` 8 · `rounded-lg` 10 (buttons, inputs) · `rounded-xl` 14 (cards, popovers, dialogs) · `rounded-2xl` 18 |
| Elevation | `shadow-xs` (buttons, inputs, cards) · `sm` · `md` (tooltips, hovered cards) · `lg` (menus) · `xl` (toasts, palette) · `2xl` (dialogs, sheets) |
| Motion | `ease-out` / `ease-in-out` / `ease-spring`; `--dur-fast` 120ms, `--dur-base` 180ms, `--dur-slow` 280ms; `.msg-arrive`, `.page-enter`. Reduced motion turns it all off. |
| Focus | 2px `--ring` on `:focus-visible`; inputs show a 3px `ring-ring/20` halo |

## Components (src/components/ui + shared)

Same APIs as before Batch 39, restyled; additions are optional:

- `Button` — variants `default · soft · outline · secondary · ghost · link · destructive`; sizes `xs · sm · default · lg · icon · icon-sm`.
- `Badge` — adds `success · warning · danger · info · muted`.
- `Alert` — adds `success · warning · info` (destructive is the danger tint).
- `Kbd` — keyboard key hints.
- `PageHeader` — optional `actions`.
- `EmptyState` — optional `variant="plain"` (no card frame, for empty panes).
- `ErrorState`, `PageSkeleton`, `Skeleton`, `Card`, `Dialog`, `Sheet`, `DropdownMenu`, `Popover`, `Tooltip`, `Tabs`, `Table`, `Select`, `Input`, `Textarea`, `Checkbox`, `Switch`, `RadioGroup`, `Progress`, `Avatar`, toasts (`sonner`).

## Shell hooks (for new pages)

- Navigation stays in the feature registry (`nav_path`, `nav_order`); the
  sidebar group comes from `GROUPS` in `src/components/shell/use-nav.ts`
  (presentation only; an unknown path shows under "More").
- A page that must fill the work area (no padding) goes in `FULL_BLEED` in
  `src/components/app-shell.tsx` and lays itself out with `flex-1 min-h-0`.
- The work area scrolls, not the window: use `sticky top-0` inside a page.
- Command palette actions that open a page's own dialog use
  `runAppCommand` / `useAppCommand` (`src/lib/app-commands.ts`) — the page
  runs the same code as its button.
- Single-key shortcuts must check `isTypingTarget` (`src/lib/keyboard.ts`);
  list them in `SHORTCUTS` (`src/components/shell/shortcuts-dialog.tsx`).

## Screenshots

`scripts/ui-shots/shoot.mjs` drives the dev server with fake data (see the
file header). Batch 39's are in `docs/screenshots/batch39/{before,after,compare}`.
