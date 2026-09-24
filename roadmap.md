# AiDwar roadmap — Aiden control centre (/admin/aiden)

## Done
- [x] Policy-claim check (ai-run.server.ts, policy_claims_stripped)
- [x] Website: hero badge, @Lovable removed, AiDwar og/twitter image
- [x] Nudges use approved aidwar_onboarding_start + en_US lookups
- [x] Repeated code within 5 s gets one reply

- [x] Phase 5a — Firecrawl monthly caps (platform + workspace), per-call credit recording, fallback to own reader, day0_page_limit 15

## Open (in this order)
- [ ] Phase 1 — /admin/aiden shell (super-admin gate), shared behaviour-save helper, version-conflict check ("Updated by <name> <time>"), "Last changed by" labels, audit rows
- [ ] Phase 2 — Rules tab (move PromptBlocksEditor, link from /admin/ai)
- [ ] Phase 3 — Scripts tab: getScript + 12 keys in ai_prompt_blocks, tests, stranger_greeting metadata counter, read-only approved templates
- [ ] Phase 4 — Workspaces tab + admin behaviour editor + persona generator (auto after first read, review banner)
- [ ] Phase 5b — reading priority/skip, per-source URL list, nightly backfill, on-demand read, content-hash refresh, merchant buttons + full-read banner/WhatsApp, admin UI for reading settings
- [ ] Phase 6 — Test tab (preview: true → billingExempt)
- [ ] Phase 7 — /admin → Users: super admin list, add/remove, logged + email — after email is set up
