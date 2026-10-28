# Batch 39 — UI audit (Step 0)

Every app route and its main components, as of `main` at 3b751c8, before any
Batch 39 change. Parts 2–4 of the redesign start from this list.

## App (`/app`, signed in — `src/routes/app/route.tsx` → `AppShell`)

| Route | File | Main components |
| --- | --- | --- |
| `/app` (Home) | `app/index.tsx` | aiden-setup-card, persona-review-banner, send-health-banner, empty-state |
| `/app/inbox` | `app/inbox.tsx` | inbox/inbox-view → inbox/chat-thread, flow-run-banner, flow-run-history, aiden-rules-badge, send-card-button, send-form-button, correction-dialog, templates/template-picker-dialog |
| `/app/contacts` | `app/contacts.tsx` | contacts/contacts-view, segments/segments-view |
| `/app/campaigns` | `app/campaigns.index.tsx` | campaigns/campaigns-view |
| `/app/campaigns/$id` | `app/campaigns.$id.tsx` | campaigns/campaign-detail |
| `/app/templates` | `app/templates.tsx` | templates/templates-view |
| `/app/catalog` | `app/catalog.index.tsx` | catalog/catalog-view, products-summary, whatsapp-shop-card, category-words-card |
| `/app/catalog/collections` | `app/catalog.collections.tsx` | catalog/collections-view |
| `/app/automations` | `app/automations.tsx` | automations/automations-view |
| `/app/employee` (AI employee) | `app/employee.tsx` | aiden-setup-card, employee/* (behaviour-editor, handoff-alerts-card, price-reviews-card, brain-picker, corrections-list, knowledge-manager, playground, forms-manager, prompt-preview, skills-manager, tools-list, weekly-report, work-log) |
| `/app/flows` | `app/flows.index.tsx` | flows/flows-view, sends-log, v2/chat-flows-list |
| `/app/flows/$id` | `app/flows.$id.tsx` | flows/flow-detail |
| `/app/flows/v2/$id` | `app/flows.v2.$id.tsx` | flows/v2/flow-editor |
| `/app/cards` | `app/cards.tsx` | cards/cards-view |
| `/app/analytics` | `app/analytics.tsx` | analytics/analytics-view |
| `/app/receipts` (Sales from messages) | `app/receipts.tsx` | receipts/receipts-view |
| `/app/settings` | `app/settings.tsx` | team/team-settings, whatsapp-settings, contacts/lead-sources-settings, contacts/opt-out-keywords-settings, settings/delete-workspace-card, integrations/integrations-settings, integrations/flow-connections, settings/send-settings, settings/api-settings, settings/api-console |
| `/app/billing` | `app/billing.tsx` | billing/billing-view, billing/plan-chooser |

Shell: `components/app-shell.tsx` (top bar with wordmark, `OrgSwitcher`,
`UserMenu`; left `NavLinks` from the feature registry; `PlanBanner`), gate in
`app/route.tsx` (loading skeleton, error, `OrgOnboarding`, locked/paused →
Billing). Shared: `components/empty-state.tsx` (`EmptyState`, `ErrorState`,
`PageHeader`, `PageSkeleton`), `components/ui/*` (shadcn on Radix).

## Super Admin (`/admin` → `AdminShell`)

| Route | Main components |
| --- | --- |
| `/admin` | empty-state |
| `/admin/organizations` | data-pagination, admin/org-features-sheet, admin/org-billing-sheet |
| `/admin/customers` | data-pagination, admin/org-billing-sheet |
| `/admin/users` | data-pagination, admin/super-admins-panel |
| `/admin/billing` | data-pagination, admin/topups-drawer, admin/ai-runs-dialog, admin/invoices-tab |
| `/admin/ai` | empty-state |
| `/admin/aiden` | admin/prompt-blocks-editor, aiden-test, aiden-runs, reading-settings, shopify-custom-app, workspace-reading, employee/behaviour-editor |
| `/admin/flags`, `/admin/sending`, `/admin/activity`, `/admin/leads` | empty-state, data-pagination |

## Public

`/` (marketing), `/pricing`, `/login`, `/signup`, `/join/$token`, `/demo`,
`/contact`, legal pages (`/terms`, `/privacy`, `/refund-policy`, `/refunds`,
`/cancellation-policy`, `/shipping`, `/data-deletion`), `/pay/$paymentId`,
`/r/$token`, the developer portal (`/developers/*`, Batch 38 — the visual bar),
and the generated `llms.txt`, `sitemap.xml`, `openapi.json`, Postman files.

## What the BEFORE screenshots show

- No dark theme exists in the app (only the developer portal has one).
- No Home entry in the sidebar; the wordmark isn't a link.
- Desktop Inbox: the page title + description take ~150 px, so the chat's
  composer is cut off below the fold at 1440×900.
- Mobile chat (390): the header shows initials, status and buttons but no
  name; the composer is pushed below the screen.
- Primary green on white text is ~2.6:1 (below WCAG AA).
