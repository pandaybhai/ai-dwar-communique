# Batch 41 — UI audit (Step 0): Home, Campaigns, Templates

Part 2 of 4 of the app redesign. Starts from Batch 39 (design system, shell,
Inbox — PR #48), so BEFORE already has the new tokens, shell and dark theme;
this batch redesigns the pages themselves.

| Route | File | Main components |
| --- | --- | --- |
| `/app` Home | `routes/app/index.tsx` | `Stat`, waiting list, "learned this week", quick links; `SendHealthBanner`, `AidenSetupCard`, `PersonaReviewBanner` |
| `/app/campaigns` | `routes/app/campaigns.index.tsx` | `campaigns/campaigns-view` (status chips, table), `QualityBanner`, `campaigns/campaign-wizard` (5 steps), `campaigns/campaign-test-send` |
| `/app/campaigns/$id` | `routes/app/campaigns.$id.tsx` | `campaigns/campaign-detail` (header + progress, 5 stats, cost, offer performance, recipients table + pagination) |
| `/app/templates` | `routes/app/templates.tsx` | `templates/templates-view` (search, number filter, sync, cards grouped by business account), `templates/template-preview`, `templates/create-template-dialog` (+ `format-toolbar`, `button-editor`, `media-uploader`), `templates/template-picker-dialog` (Inbox, wizard) |

What the BEFORE shots (`docs/screenshots/batch41/before`, light + dark, 1440 + 390) show:

- **Home**: five stat cards of equal weight, no hierarchy between today's work
  and account facts; the three quick links repeat the sidebar.
- **Campaigns list**: hand-built table with uppercase headers; progress is
  "2630/4210" text, no bar; status colours are hard-coded sky/amber/emerald
  classes (not the status tokens), so dark mode leans on `dark:` fallbacks;
  nine filter chips wrap on phones.
- **Campaign detail**: good bones; stat cards don't relate to each other
  (no funnel), recipients table uses its own classes, the offer end date is a
  raw `toLocaleString()`.
- **Wizard**: a plain dialog stepper; fine, restyle only.
- **Templates**: the preview is a white card on grey — it doesn't look like
  WhatsApp, which is the whole point of a preview; cards stretch to the
  tallest in their row; the info note is a large tinted block.
- **Create template**: two columns, the preview column is small and generic.
