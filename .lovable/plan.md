# Onboarding chat: fix the dead ends

All five problems are real in the current code. Confirmed by reading the code and the live database.

## What is broken today

1. **Owners who finished setup are treated as strangers.** The session lookup by phone excludes finished sessions, so once an owner is connected or completed, their next message finds nothing and gets the "who are you" reply. Replies to customer handover questions never reach the customer.
2. **Connected but not switched on has no way back.** When switching the assistant on is refused for balance reasons, the chat says "pick a plan" and stops. Nothing remembers that state, so paying later changes nothing until the owner reconnects.
3. **A failed reading leaves the chat stuck.** If reading a website or an uploaded file crashes, the source is marked failed but the chat is never told, so the session stays in "reading" forever and every message answers "Still reading — one moment."
4. **Wrong copy on the trial reading cap** — it tells owners to come back tomorrow, which is not how the cap works.
5. **Nothing expires.** Sessions that were never started, and questions waiting for an owner answer, stay open indefinitely.

## What will change

**Finished owners stay known.** The lookup also finds the newest connected or completed session for that number, and those owners are treated as answering — their replies reach the pending customer question. They never see Day-0 script or the credits card again. The stranger reply only fires when the number has no session at all.

**A paid-later owner gets switched on.** When switching on is refused, the session is parked as waiting for funds. The next message checks whether the plan is now active or the balance is positive, retries once, and on success sends the same "I'm on duty" message and completes the session. That closing sequence becomes one shared function used by both paths.

**Failed reading releases the chat.** Worker failures notify the chat (guarded so a notify failure cannot hide the real error). Uploads that throw reset the session back to waiting for a link with a plain-language reply. A session stuck reading for more than 10 minutes resets itself and the message is processed normally. A workspace code is always honoured even while reading.

**Copy fix.** "I've used up the free reading allowance for your trial. Pick a plan at https://aidwar.in/app/billing and I'll read it straight away."

**Expiry.** The existing background tick also expires never-started sessions past their expiry time, and marks owner questions older than 48 hours as expired. No message is sent for either.

## Technical notes

- Files: `src/lib/merchant-channel.server.ts`, `src/routes/api/internal/knowledge-worker.ts`, `src/lib/onboarding-nudges.server.ts`.
- `findSession`: third lookup for `status in ('connected','completed')`, returns `byCode: false`. `answering` becomes `ready | tested | connected | completed`; `dayOneStep` and the credits card are skipped for `connected`/`completed`.
- `SESSION_COLUMNS` gains `updated_at` (and `expires_at` where needed) — the staleness gate needs it; the column exists in the database.
- The "Still reading" gate moves below stage 1 (code) and gains the 10-minute staleness reset.
- `handleNumberConnected`: on `ai_agents` mode refusal set `step: 'await_funds'`, keep `status: 'connected'`. The on-duty tail (counts, card, hand-over note, completion patch) is extracted to a shared function called from both `handleNumberConnected` and the `await_funds` retry in `handleMerchantInbound`.
- Worker catch: `finishOnboardingCrawl(supabase, sourceId, { ok: false, itemCount: 0, error: detail })` inside its own try/catch.
- Media branch: `ingestUpload` wrapped in try/catch; on throw and `firstMaterial`, reset to `bound / await_site / source_id null` and reply "Couldn't read that one — try a clearer photo or a PDF."
- `runOnboardingNudges`: expire `status='pending'` with `expires_at < now()`; expire `pending_owner_replies` with `status='pending'` and `created_at` older than 48 hours. `pending_owner_replies` has no `expires_at`, so age is measured from `created_at`.

## Untouched

Stage order and prefix-once logic, `teach-guard.ts`, `handleOwnerAnswer`/`handleOwnerPick`, the grounding guard, billing/wallet, the database mode guard, and the Day-0 shallow crawl. No second session lookup helper, no second sender — `findSession`, `patchSession`, `sendServiceText`, `onboardingChannelFor` are reused.

## After the build

Per-file effective diff, then deployment and the new commit hash returned by `/api/internal/knowledge-worker`.
