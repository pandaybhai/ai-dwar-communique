Cashfree PG webhook samples (webhook version 2025-01-01), built field for
field from the sample payloads on Cashfree's "Payment webhooks" page — order
`order_OFR_2`, payment `1453002795` (UPI `rishab@ybl`), and the failed
net-banking payment `1504280029` (`GATEWAY_ERROR` / `invalid_amount`). Kept
as raw single-line files because the signature is over the body exactly as
sent (`2.00` must stay `2.00`). Test-only; never used by the app.

The signatures in batch31-cashfree.test.ts were computed outside the code under
test, with:

    printf '%s%s' "$TS" "$(cat payment-success.json)" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64
