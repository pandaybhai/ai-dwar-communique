# Batch 40 — why new sign-ups never reached "connected"

Live data (28 Oct): `onboarding_sessions` has 7 rows, all `expired`, none ever
`connected`. 4 never left the first step (`step` NULL), 2 stopped at
`await_connect`, 1 at `answering`. Each got one nudge. Zoori and Fanzart
connected through the web app, outside this flow.

Traced in code before anything was changed (main @ 3b751c8):
sign-up (`src/routes/signup.tsx`) → email confirmation (`emailRedirectTo
/login`) → `/app` (`src/routes/app/route.tsx`) → no workspace → business name
(`src/components/org-onboarding.tsx`, `create_organization`) →
`/api/onboarding/start` (session `pending` + code) → "Say hello to Aiden" screen
→ the owner sends the code to the platform number on WhatsApp →
`handleMerchantInbound` (`src/lib/merchant-channel.server.ts`: `pending` →
`bound`/`await_site` → link → `learning`/`reading` → knowledge-worker →
`finishOnboardingCrawl` → `ready`/`answering` → first grounded answer +
`starter_credits` row → `tested`/`await_connect` → "Connect my WhatsApp" →
web Settings → Embedded Signup (`whatsapp-embedded-signup.tsx`,
`/api/whatsapp/es-exchange`) → `handleNumberConnected` → `connected` →
switch-on → `completed`). Nudges and expiry: `onboarding-nudges.server.ts`
inside the knowledge-worker tick.

## The causes, by where each session stopped

### `step` NULL (4 sessions: status `pending`, the code was never sent)

1. **The first thing the product asks is to leave it.** Straight after naming
   the business, the only path forward is to open WhatsApp (on a laptop: scan a
   QR with the phone) and send a code to a number the owner has never seen.
   Nothing has been shown yet that earns that trip, and "Skip for now — open my
   workspace" sits right under it. Nowhere in the web app is the website asked
   for: the website, the reading and the first answer exist only inside that
   WhatsApp chat. Skip it and the workspace is an empty dashboard.
2. **A code can be eaten before the owner channel sees it.** On the onboarding
   number, Flows v2 (`flowsV2Inbound`) runs before `handleMerchantInbound`; a
   keyword flow pinned to that number (e.g. "hi") takes "Hi Aiden, my code is
   AD-…" and the owner gets the flow instead of Aiden — the session stays
   `pending`. Whether such a flow exists live can't be checked from here
   (no live access); the order in the code allows it.
3. **The one nudge asks for the same detour.** After 24 h the code template
   says "Reply with {code} and I'll start reading your website" — from a number
   they never chatted with, with no way back to where they stopped.

### `await_connect` (2 sessions: status `tested`)

4. **"Connect my WhatsApp" goes to a login wall and then to Home.** The chat
   reply links to `/app/settings`. On the phone (where the owner is, in
   WhatsApp) the browser has no AiDwar session, and `/app`'s guard redirects to
   `/login` **without** a `redirect` back, so after logging in the owner lands
   on Home, not on Connect. Nothing on Home says "connect your number next".
5. **Embedded Signup fails silently or vaguely.**
   - Race: the code arrives in the `FB.login` callback, the WABA/phone ids in a
     separate `WA_EMBEDDED_SIGNUP` window message. The client only looks at the
     ids at the moment the callback fires; when Meta's message lands a moment
     later, a sign-up that worked on Meta's side ends with "Meta didn't send
     the account details".
   - Every failure reads the same: `CANCEL` (with the step it was cancelled
     at) and `ERROR` (Meta's error message) are ignored, so "number is still on
     the WhatsApp app", "business needs verification" and "a permission was
     not granted" all look like "Sign-up was cancelled". The one thing most
     people hit (the number is on their phone's WhatsApp) is explained only
     inside the chat, never on the connect screen.
   - There is no human fallback on that screen.
6. **A connection made later was never recorded.** `handleNumberConnected` only
   looked for a session in `tested`/`connected`; and the resume pass expires
   `bound`…`tested` sessions after 7 days without a WhatsApp message — which is
   exactly what happens while the owner goes off to the web to connect. Connect
   on day 8 (or from any other status) and the session stays expired: part of
   "0 ever connected" is this blind spot.
7. **The nudge can't be acted on.** "We stopped at connecting your WhatsApp
   number. Reply here to continue" — replying on WhatsApp can't connect
   anything, and there is no link to the connect screen.

### `answering` (1 session: status `ready`)

8. **The step to Connect needs a credits row that may never exist.** `ready` →
   `tested` (the "Connect my WhatsApp" card) happens only on a grounded answer
   **and** a `starter_credits` ledger row. The welcome-credits trigger
   (`trg_ai_runs_welcome_credits`) grants them only when the workspace has no
   ledger row at all and no plan — any earlier row (coupon, adjustment, plan)
   means no `starter_credits`, and the session stays `ready` for ever. An
   answer without sources (a thin site) doesn't advance either. The only other
   way forward is typing "connect my whatsapp" exactly.

### All 7 `expired`

9. **Progress lived only in the session, and the session dies quietly.** Seven
   days of WhatsApp silence (or an unused code reaching `expires_at`) ends it;
   the web app has no memory of where the owner stopped, so a returning owner
   starts from nothing.

Smaller things found on the way: sign-up attribution was kept in
`sessionStorage`, which the email-confirmation tab doesn't share (lost);
`ensureResumeTemplate` is never called, so the resume template may not exist
on the platform workspace at all.

## How each is fixed (Batch 40)

| # | Fix |
|---|-----|
| 1 | The whole first run is now in the web app (`/app/start`): website first, the business recognised on screen, then Connect → Meet Aiden → Go live. The WhatsApp chat with Aiden stays, as an optional "try him on your own phone" on Meet Aiden and on Home — nothing removed. |
| 2 | On the onboarding number a message carrying an onboarding code is never offered to Flows v2: it goes to the owner channel. |
| 3, 7 | A new utility template `aidwar_onboarding_resume_link` (button `https://aidwar.in/app/start?step={{1}}`) deep-links to the exact step; the admin funnel page submits it to Meta. Until it is approved the old templates are used exactly as before. Web-journey sign-ups get the link nudge, not "reply with your code". |
| 4 | `/app` keeps where you were going (`/login?redirect=…`); the chat's Connect reply links to `/app/start?step=connect`. |
| 5 | The callback waits (bounded) for Meta's session message; `CANCEL`/`ERROR` and the server's Graph errors map to one named outcome each with a plain recovery path; "Need help? We'll call you" alerts the team. |
| 6 | `handleNumberConnected` records the connection on the newest session of the workspace whatever its status (an expired one is revived); the full switch-on still only for `tested`/`connected`, as before. Silent expiry is 30 days, and opening the journey keeps an unused code alive. |
| 8 | A grounded answer moves `ready` → `tested` and offers Connect whether or not starter credits exist; the credits card is shown only when they do. |
| 9 | Web progress is derived from facts (website source, connected number, a test answer, the chosen mode), not from the session, so it can't expire. Closing the tab and coming back lands on the same step. |

The funnel is measured with `analytics_events` (`onboarding.started`,
`website_read`, `connect_opened`, `connected`, `aiden_tested`, `went_live`),
once per workspace per step, shown at `/admin/onboarding`.
