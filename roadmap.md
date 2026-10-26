# AiDwar roadmap — Aiden control centre (/admin/aiden)

## Done
- [x] Policy-claim check (ai-run.server.ts, policy_claims_stripped)
- [x] Website: hero badge, @Lovable removed, AiDwar og/twitter image
- [x] Nudges use approved aidwar_onboarding_start + en_US lookups
- [x] Repeated code within 5 s gets one reply

- [x] Phase 5a — Firecrawl monthly caps (platform + workspace), per-call credit recording, fallback to own reader, day0_page_limit 15

## Open (in this order)
- [x] Phase 1 — /admin/aiden shell (super-admin gate), shared behaviour-save helper, version-conflict check ("Updated by <name> <time>"), "Last changed by" labels, audit rows
- [x] Phase 2 — Rules tab (move PromptBlocksEditor, link from /admin/ai)
- [x] Phase 3 — Scripts tab: getScript + 12 keys in ai_prompt_blocks, tests, stranger_greeting metadata counter, read-only approved templates
- [x] Phase 4 — Workspaces tab + admin behaviour editor + persona generator (auto after first read, review banner)
- [x] Phase 5b — reading priority/skip, per-source URL list, nightly backfill, on-demand read, content-hash refresh, merchant buttons + full-read banner/WhatsApp, admin UI for reading settings
- [x] Phase 6 — Test tab (preview: true → billingExempt)
- [x] Phase 7 — /admin → Users: super admin list, add/remove, logged + email — after email is set up

## Sep 24 batch
- [x] Reading independent of AI switch; pages save even when search prep fails
- [x] Rendered re-read for client-loaded pages; re-read pages from a different engine
- [x] /pricing + homepage plans in first HTML; sitemap/robots/root use aidwar.in
- [ ] Email domain aidwar.in — waiting on user to complete setup dialog
- [ ] Lovable AI credit limit reached — search prep for 6 aidwar.in pages waits on it

## Flows v2 (flag flows_v2, Ai Dwar only)
- [x] Drop 1 engine
- [x] Drop 2a canvas, core steps, validation, publish/unpublish, versions, test chat, starters
- [x] Drop 2b extras (built)
- [ ] Team email — waits on email domain setup for aidwar.in
- [x] Google Sheets step + merchant connects own Google (built)
- [ ] Google sign-in client for AiDwar — waits on user creating it in Google Cloud
- [x] Payment request step on merchant's own Razorpay (built)
- [x] Drop 3 triggers + per-step counts + inbox run log + live demo

## Sep 28 order
- [x] Step A regressions (a–i)
- [x] Flows v2 live fixes (a–f): held replies, trigger fires, which number, keyword winner, 4 new steps, speed
- [ ] Step B Forms Phase A finish + publish; ask before test form to +91 79812 23192
- [ ] Step C Aiden collects node + start_collect/record_fields (flag aiden_collect, Ai Dwar only)

## Cashfree cutover (Oct 26)
- [x] cashfree.server.ts (links, subscriptions, webhook verify), platform + flow webhooks, provider selection behind cashfree_billing flag, merchant Cashfree connection in Settings → Integrations, migration 20261026 applied, batch30 tests (12) + all money tests green
- [ ] User adds CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET / CASHFREE_WEBHOOK_SECRET / CASHFREE_ENV (secure form was declined; ask again or they add in Project Settings → Secrets; mirror into Vault as cashfree_client_id/cashfree_client_secret/cashfree_webhook_secret/cashfree_env)
- [ ] Cashfree dashboard webhooks: https://aidwar.in/api/public/cashfree-webhook (platform) — merchant webhook URL is per-workspace, shown in Settings → Integrations
- [ ] Sandbox end-to-end: top-up, plan purchase, subscription cycle, flow payment link (flag ON for Ai Dwar org only)
- [ ] Validate Cashfree subscription field names against sandbox responses (sub_auth_link, subscription_id, SUBSCRIPTION_* payloads) — written from docs, untested
- [ ] Switch CASHFREE_ENV=production, flag ON for all orgs
- [ ] Later phase: remove Razorpay code/keys once all Razorpay mandates and links have ended
