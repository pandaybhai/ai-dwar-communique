# Replace Razorpay with Cashfree (full cutover)

## Goal
All payments in AiDwar move from Razorpay to Cashfree: platform billing (plans, credit top-ups, subscriptions, invoices) and merchant-owned payment links in Flows v2. Cashfree API v2026-01-01.

## Approach: add Cashfree alongside, then cut over — never break live money paths
Existing Razorpay subscriptions and in-flight payment links keep working until they end. New payments go to Cashfree. Nothing Razorpay-related is deleted in this phase.

## 1. Credentials (user provides via secure form)
- `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET` — platform keys (sandbox first, then production)
- `CASHFREE_WEBHOOK_SECRET` — platform webhook signing secret (shared with Cashfree dashboard)
- `CASHFREE_ENV` — `sandbox` | `production`
- Merchant flow keys stay per-workspace in Vault (`workspace_connections`, provider `cashfree`) — same pattern as today's Razorpay connection.

## 2. New server module: `src/lib/cashfree.server.ts`
- Auth via `x-client-id` / `x-client-secret` headers; base URL by `CASHFREE_ENV`.
- `createPaymentLink` (hosted link, `link_notes` carry our payment/run ids, expiry, customer details).
- Subscriptions: `createPlan`, `createSubscription` (mandate), `cancelSubscription`, `fetchSubscription`, plan change.
- `verifyWebhookSignature`: HMAC-SHA256 over `timestamp + rawBody`, base64, constant-time compare.

## 3. Platform billing cutover
- `billing.server.ts` / `plan-purchase.server.ts` / `subscriptions.server.ts`: route new purchases, top-ups and mandates through Cashfree when the `cashfree_billing` flag is on (feature flag, default OFF, ON per org after sandbox verification).
- New webhook route `/api/public/cashfree-webhook`: verify signature → record event once in `webhook_events` (provider `cashfree`, dedupe on event id) → settle payment / apply subscription event → 200. Same idempotency rules as the Razorpay webhook (retry-safe, stuck-event reclaim).
- Razorpay webhook route stays live for existing mandates/links until they finish.
- Invoices: unchanged (generated from our own ledger, not the provider).

## 4. Merchant flow payments (Flows v2 "Collect payment")
- `workspace_connections` provider check extended to allow `cashfree` (migration: widen the CHECK constraint).
- Settings → Integrations: "Cashfree" connect card (Client ID, Client Secret, webhook secret, verified with a live API call before saving) alongside Razorpay; merchants can connect either.
- Flow engine: payment-link step uses the workspace's connected provider (Cashfree preferred when both exist).
- New webhook route `/api/public/cashfree-flow-webhook/$orgId`: verifies with that workspace's secret, resumes the run on its Paid path (idempotent via run event key), same as the Razorpay flow webhook.

## 5. Tests
- New `batch30-cashfree.test.ts`: signature verification (valid/invalid/tampered), link creation payload shape, webhook idempotency (same event id processed once), provider selection per workspace, flag off = Razorpay path untouched.
- Re-run existing money tests (batch3-settle, batch18-*, batch19-*, batch21b) — all must pass unchanged.

## 6. Rollout
1. Sandbox keys in, flag ON for the Ai Dwar workspace only.
2. Test: one top-up, one plan purchase, one subscription cycle, one flow payment link — verified via webhooks end to end.
3. Switch `CASHFREE_ENV` to production, flag ON for all orgs.
4. Razorpay code/keys removed in a later phase once all Razorpay mandates and links have ended.

## Not in this phase
- Refunds UI, settlements reconciliation, Cashfree Payouts.
