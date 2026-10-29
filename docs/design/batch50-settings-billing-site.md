# Settings, Billing and wallet, the public site and sign-up in the new design (Batch 50)

Section notes for `docs/design/spec.md` (kept in this file while Batches 48 and
49 edit the spec in parallel; fold it in once they land). With `new_design` off
Settings, Billing and the first-run journey are the Batch 39 to 41 screens,
unchanged; with `new_site` off the landing, pricing, sign-up and log-in pages
are today's (`src/lib/batch50-settings-billing-site.test.tsx` pins both).

## Settings (`/app/settings`, avatar menu > Settings)

`src/components/settings-v2/`. A left sub-nav (a scrolling row of pills at 700px
and under) and one section at a time, picked by `?tab=` so every old link lands
where it did: `?tab=team` (avatar menu), `?tab=api` (developer docs),
`?tab=integrations` (Shop > Shopify), `?google=` (Google's return opens Flow
connections). Each section is the classic tab's own component, shown under the
same flag and permission:

| Section | Cards | Shown when |
| --- | --- | --- |
| Workspace | the classic General form (`GeneralTab`, handed in by the route) | always |
| Team and roles | `TeamSettings` | always |
| WhatsApp | **WhatsApp profile** as its own card on top (the default number's, a picker when there are several), then `WhatsAppTab` (numbers, health, catalogue, test send) | always; the profile card only with `settings.manage`, as before |
| API and webhooks | `ApiSettingsTab`, `ApiConsoleCard` (Try-it) | `public_api` flag and `public_api.manage` |
| Notifications | the Aiden page's hand-off alerts card (`HandoffAlertsCard`, edits need `ai.configure`) | `ai_features` and `ai.use` |
| Opt-out keywords | `OptOutKeywordsCard` | `compliance` flag |
| Integrations | `IntegrationsTab` (Shopify) | `shopify` and `integrations.view` |
| Flow connections | `FlowConnections` | `flows_v2` and `integrations.view` |
| Send settings | `SendSettingsTab` | `flows` and `flows.view` |
| Lead sources | `LeadSourcesTab` | always (the classic tab, kept) |
| Danger zone | `DeleteWorkspaceCard`, behind a red rule, last in the sub-nav | the owner |

⌘K (new shell only) has a "Settings" group: WhatsApp profile, Team and roles,
and API and webhooks (only with the API flag and permission), each a link to
its section.

## Billing and wallet (`/app/billing`)

`src/components/billing-v2/`. The classic page's states in the classic order:
trial and locked choose a plan first (`PlanChooser`, before the billing flag),
then the `billing` flag, then `billing.view`.

| Block | Where it comes from |
| --- | --- |
| Plan-status note | `organizations.plan_status` (+ `trial_ends_at`): trial, locked, paused, past due, cancelled, each with one next step (choose a plan, reactivate, see the open invoice, write to us); active says nothing |
| Credits available (ticker) | `/api/billing/summary` wallet `available`, held amount under it; the low note at `low_credit_threshold` |
| Top up / Request a top-up | the classic `BuyCreditsDialog` (`/api/billing/purchase`, Cashfree checkout) and `RequestTopupDialog`, same permissions and the same `creditPurchaseBlock` gate |
| This month | summary `usage_total`, AI answers used of included, the plan name and price |
| Where your credits went | summary `usage`, one bar per kind spent, largest first |
| What a message costs you | summary `rates` (the classic table's words) |
| Invoices, auto-pay, history | the classic `InvoicesPanel` and `HistoryTabs` (download, CSV export) |
| Plans | `GET /api/billing/plan`, the workspace's plan in ink with "Current plan"; read only (an active workspace changes plan by writing to us, as before). Trial and locked use `PlanChooser`, its cards restyled with `nd:` classes only |

Coming back from Cashfree (`?payment=`) the page asks our server to confirm the
payment with the gateway (`confirmCashfreeReturn`), exactly as the classic page.

## Public site: the `new_site` switch

Default **off**. `VITE_NEW_SITE=on` at build time turns it on for everyone;
`?site=new` on any of the four pages previews it without turning it on (the new
pages keep it on their own links). `src/lib/new-site.ts`.

- **Landing** (`/`): the same words (`landing-copy.ts`, moved unchanged), the
  same demo form, written walkthrough and plans read. The product is shown with
  the design's pieces: Aiden answering a customer in a phone (types, sends the
  product, pauses for the owner on a discount; plays once when it comes into
  view, "Play it again"), the shared Inbox with the gold "Waiting for you" and
  Aiden's suggestion, a campaign's results (ticking numbers, growing bars) and
  its message on a phone. All labelled "Examples with a sample shop".
- **Pricing** (`/pricing`): the same plans and INR message rates read on the
  server, the same words (`pricing-copy.tsx`) and the existing
  `MessageRatesTable`; plan cards with Growth ringed in emerald.
- **Unchanged**: every policy page, contact, demo, the footer, SEO meta
  (title, description, og, canonical, JSON-LD), sitemap, `llms.txt`, the
  developer portal.
- **Fonts**: Bricolage Grotesque and Instrument Sans load after the page is up
  and idle (the head is main's, byte for byte), so the first paint never waits
  for them.

## Sign-up, log-in, first-run journey

Sign-up and log-in have no workspace, so they follow `new_site`: the app's
new-design tokens (`useDesignSurface`) and a new `AuthShell` frame; fields,
steps, checks and copy unchanged. The journey (`/app/start`) follows
`new_design` (the app layout already turns the tokens on); its frame, headline,
rail and primary button gain `nd:` classes only.
