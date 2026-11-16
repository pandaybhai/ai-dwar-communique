# Batch 80b — /999 Meta events: Step 0 report

What the code on `main` does today for each /999 event, read from the source.
Batch 80b doesn't change how any event is sent; it adds Test Events mode,
`meta_capi_log`, and the admin ₹1 live test.

## Rules that apply to every event

- **Browser pixel (`fbq`)** runs only after the visitor presses **Accept** on the cookie banner (`pixelAllowed` → `readConsent() === "accepted"`, `src/lib/meta-pixel.ts`).
- **Server copy (Conversions API)** goes through `queueMetaEvent` / `sendMetaEvent` (`src/lib/meta-capi.server.ts`). A person who opted out of Meta measurement is never sent.
- **Dedup:**
  - Meta counts a browser event and a server event as one when both carry the same `event_name` + `event_id`.
  - Every id is `<Event>.<key>` (`metaEventId`).
  - A server event marked `once` is also recorded in `activity_log` (`meta_event_sent`, `details.event_id`) on the platform workspace, so it is never sent twice.

## Each event

| Event | When | Browser pixel | Server copy | `event_id` (same on both) | Sent once |
|---|---|---|---|---|---|
| PageView | page shown | after Accept | none | random | — |
| ViewContent | /999 shown (`pageChanged`, `content_name: "999_page"`) | after Accept | `relayToServer` → `/api/public/meta-event` → `queueMetaEvent` (website, with the visitor's request: IP, user agent, `_fbp` / `_fbc`) | `ViewContent.<random>` per page view | per page view |
| InitiateCheckout | checkout sheet opened (`trackInitiateCheckout999`, 999 INR) | after Accept | same relay as ViewContent | `InitiateCheckout.<random>` per open | per open |
| CompleteRegistration | account created in the checkout (`trackRegistration(…, "landing_999")`) | after Accept | `/api/public/meta-event`: account created within the last 15 min | `CompleteRegistration.<user id>` | yes (`once`) |
| Lead | — | never for /999 | never for /999 (`source === "landing_999"` returns before the Lead) | — | — |
| AddPaymentInfo | Pay tapped, payment row created (`startCheckoutPayment`) | after Accept (`fireFromServer` with the server's id) | always: the buyer accepted the terms on Pay; website, with the Pay request | `AddPaymentInfo.<payment id>` | yes (`once`) |
| Purchase | payment settled paid (`settlePayment` → `metaSettled` → `metaPaymentSettled`) | after Accept: `confirmCashfreeReturn` → `trackPaidPayment` asks the server, which returns the id only for a paid payment | always, `system_generated`, 999 INR, from whichever path settled it | `Purchase.<payment id>` | yes (see below) |

### What about consent?

The server copies of **ViewContent and InitiateCheckout are relayed only after Accept**: `relayToServer` returns early unless `pixelAllowed()`, and the relay endpoint requires `consent: true`. A visitor who hasn't pressed Accept sends neither event from either side.

Vinay's 15:31 UTC test showed browser events too, so Accept was pressed, which matches this.

**AddPaymentInfo and Purchase are server-side regardless of the cookie choice.**

Per your instruction, this is reported here and not changed.

## Purchase: once per paid payment, whichever path settles it

Three paths can settle a /999 payment:
1. **Webhook:** `/api/public/cashfree-webhook` → `handleCashfreeEvent` → `settlePayment`.
2. **Return page:** `/api/public/cashfree-pay` POST → `confirmCashfreePayment` (GET order from Cashfree) → `settlePayment`.
3. **Billing sweep:** `reconcilePendingCashfree` → `confirmCashfreePayment` → `settlePayment`.

Three layers keep it to one Purchase:
1. `settlePayment` returns early for a payment that is already `paid`, and claims the payment so that two deliveries can't settle it at once.
2. The Purchase is queued only after the payment is marked paid (`metaSettled`).
3. `metaPaymentSettled` sends with `once: true`: the `activity_log` marker stops any later attempt.

`paymentConversion` returns nothing for a payment that isn't `paid`, so a failed, pending or created order never sends a Purchase. Vinay's 15:31 order ended **failed** and sent no Purchase. That is correct and is kept.

Tests (`batch31-cashfree.test.ts`, "Batch 80b: a /999 payment's Purchase reaches Meta once") drive a /999 payment through the real webhook route and the real return-confirm, with a fake Cashfree and a stub Graph:
- return page, then webhook, then return page again → **1** Purchase;
- webhook twice, then return page → **1** Purchase;
- failed webhook, then return page → **0** Purchases.

## What Batch 80b adds (no change to how events are sent)

1. **`?meta_test=<CODE>`**
   - Any page stores the code in an `aidwar_meta_test` cookie for 2 h (`rememberMetaTest`).
   - Every server event made from that browser's requests carries `test_event_code=<CODE>`.
   - The code is also kept on its /999 payment (`raw.meta_test_code`), so the Purchase carries it even when the webhook settles it.
   - Other visitors are unaffected, and `META_CAPI_TEST_CODE` still works as before.
2. **`meta_capi_log`** (SQL `20261440_batch80b.sql`, service role only, 14-day purge in the nightly job):
   - one row per server event: sent, failed or skipped;
   - for a skip, the reason (`token_missing`, `opted_out`, `no_person`, `already_sent`, `admin_test_without_test_code`);
   - Graph's HTTP status, `events_received`, `fbtrace_id` and error;
   - the test code and the source URL.
   - It never holds personal data. A missing table or a failed write never changes a send.
3. **₹1 admin live test** (`/999?admin_test_price=1`):
   - Allowed only for a Super Admin, checked on the server. Anyone else gets 403 and nothing is created.
   - Cashfree charges ₹1 (`ADMIN TEST — …` in the order note), and the payment is tagged `raw.admin_test`.
   - It is left out of Admin > Billing revenue and never fired by the pixel.
   - Its Purchase goes to Meta only as a Test Events call (with `?meta_test=`); without a test code it is skipped and logged.
4. **Cashfree sandbox end-to-end run:** blocked. This container has no Cashfree sandbox client id/secret (see the PR).
