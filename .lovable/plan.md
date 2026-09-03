# Billing — money core (Prompt 1)

Verified against the live database before writing this: all billing tables (billing_accounts, plans, plan_versions, organization_billing_settings, rate_cards, credit_packs, coupons, wallet_ledger, wallet_balances, payments, subscriptions, invoices, invoice_lines, invoice_sequences, topup_tasks, meta_prepaid_ledger, bsp_accounts, billing_notifications) exist, all seven functions exist (wallet_apply, client_rate_for, org_flag_enabled, ai_answers_allowance, next_invoice_number, meta_consume, meta_balance_estimate), the new columns on organizations / whatsapp_accounts / feature_registry.depends_on exist, the `billing` flag exists with default off, and plans/rate_cards/credit_packs already hold seed rows. No schema work will be done.

Confirmed: `read_vault_secret` does exist, so the Razorpay secrets will be read through it — no fallback query needed. But the Vault currently holds only `aidwar_cron_secret` and `platform_ai_openai`. The three Razorpay secrets (`razorpay_key_id`, `razorpay_key_secret`, `razorpay_webhook_secret`) need to be added before payment links or webhooks can work. Everything else is built and testable without them; payment calls will return a clear "payments not configured" message until they exist.

## Feature registry — database is the source of truth

The registry sync currently only knows what the code manifest declares, so it would blank values the database already holds. Fixing that first:

- Add `depends_on` to the manifest type and set it to exactly the current database values: ai → inbox; analytics → campaigns; automations → inbox; campaigns → templates, contacts; catalog → templates; compliance → contacts; flows → templates, contacts; revenue_attribution → shopify, campaigns; all others empty.
- Add a `billing` manifest entry matching the existing row exactly: icon credit-card, nav `/app/billing` at order 95, nav permission `billing.view`, the four permissions (view/admin, pay/owner, request/marketer, manage/owner) with their existing wording, usage meters `credits_consumed` and `credits_purchased`, and the eighteen billing data tables.
- Make the sync protective: before generating SQL it compares the manifest against the live rows and **fails with a printed diff** if `depends_on`, `permissions` or `data_tables` would be emptied or changed. Nothing is silently overwritten.


## What gets built

**1. Money engine (server)**
A single `src/lib/billing.server.ts` holding: `assignPlan`, `setFeatureOverride`, `recommendPlan`, `getClientBillingSummary`, `createCreditPurchase`, `handleRazorpayWebhook`, `requestTopup`, `adminBillingOverview`, `completeTopupTask`. All service-role, all permission-checked against the caller's org first. The ledger is only ever written through `wallet_apply`; no debit logic is re-implemented since triggers already do it.

Feature dependency handling: turning a feature off first reports what breaks — dependent features plus real counts of what is live (Shopify integrations and synced products, enabled flows, pending scheduled sends, AI conversations, running campaigns) — and changes nothing until forced. Forcing pauses rather than deletes. Manual super-admin overrides are remembered in `organization_billing_settings.limits_override._manual_flags` so a later plan assignment does not stomp them.

**2. Campaign spend guard**
Only active when the org has the `billing` flag. The audience step shows estimated cost against available credits, blocks Continue when short (with Buy credits / Request top-up depending on permission), routes over-threshold campaigns to owner approval, holds the estimate on dispatch and releases the unused remainder at the end. It also reads the number's Meta daily tier and offers to spread an oversized audience across days. The campaign report gains cost, charged and returned columns.

**3. Client Billing page — /app/billing**
Plan / Credits / AI-answers header cards, month-to-date usage split into Messaging, Automation, Inbox and AI with a category chip row, a rates table showing client rates only, a Buy-credits dialog (packs, coupon, GST, Razorpay link, return polling), Invoices and Payments tabs, and a collapsible ledger with CSV export. Nav appears only when the flag is on.

**4. Super admin — /admin/billing**
Overview table across all orgs with balances, margin, pending top-ups and number health, plus a Top-ups due drawer with a Mark done form. A Billing tab on the organisation detail page covers plan assignment with recommendation, per-feature switches with the dependency confirm dialog, billing account details, rate editing (new rate-card rows, never edits to history), settings, wallet actions and ledger.

**5. Notifications and sweeps**
`/api/internal/billing-notify` drains the notification queue over the platform's own number, falling back to a per-kind template and marking `template_missing` rather than crashing. `/api/internal/billing-sweep` handles low-balance and float-low alerts, auto-top-up links, top-up reminders and credit expiry. Both are cron-secret guarded; I will give you the two URLs to schedule.

**6. Public pricing data**
`GET /api/public/plans` returns active public plans with price, limits and highlights. No rate cards.

## Technical notes

- Files created: `src/lib/billing.server.ts`, `src/lib/billing.ts` (shared money formatting and types), `src/lib/razorpay.server.ts`, `supabase/migrations/20260903120000_billing_v1_schema.sql` (marker comment only), route files for `/app/billing`, `/admin/billing`, the admin org billing tab, and components under `src/components/billing/` and `src/components/admin/billing/`.
- Server routes added: `POST /api/billing/purchase`, `POST /api/billing/request-topup`, `GET /api/billing/summary`, `GET /api/billing/ledger`, `POST /api/admin/billing/*` (assign plan, feature override, settings, rates, wallet, complete topup), `GET /api/admin/billing/overview`, `POST /api/public/razorpay-webhook`, `GET /api/public/plans`, `POST /api/internal/billing-notify`, `POST /api/internal/billing-sweep`, plus `GET /api/billing/razorpay-key`.
- Feature registry gets the `billing` entry wired so nav and permissions come from the manifest; the registry sync runs after.
- Supabase types regenerated so the new tables are typed.
- Razorpay secrets read through the existing `read_vault_secret` RPC pattern used for `platform_ai_openai`. Only `key_id` is ever exposed to the browser, via a server route.
- Rates: client code calls `client_rate_for` only; `message_rates`, `meta_rate` and `markup_percent` never leave super-admin surfaces.
- Money comparisons use explicit null checks throughout; ₹0 is a real value.
- Webhook is signature-verified and idempotent on the Razorpay event/payment id; invoice creation is left as a draft-row stub for Prompt 2.

## Build order

Money engine and webhook first, then the client page, then the campaign guard, then the admin surfaces, then the two cron routes and the public plans endpoint. At the end I will list every file and route touched and confirm the marker migration is in place.
