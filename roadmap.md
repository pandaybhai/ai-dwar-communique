# AiDwar roadmap — Aiden control centre (/admin/aiden)

## Done
- [x] Policy-claim check (ai-run.server.ts, policy_claims_stripped)
- [x] Website: hero badge, @Lovable removed, AiDwar og/twitter image
- [x] Nudges use approved aidwar_onboarding_start + en_US lookups
- [x] Repeated code within 5 s gets one reply

## Open (phased, each needs its own build)
- [ ] Phase 1 — /admin/aiden shell (super-admin gate), shared behaviour-save helper, version-conflict check ("Updated by <name> <time>"), "Last changed by" labels, audit rows
- [ ] Phase 2 — Rules tab (move PromptBlocksEditor, link from /admin/ai)
- [ ] Phase 3 — Scripts tab: getScript + 12 keys in ai_prompt_blocks, tests, stranger_greeting metadata counter, read-only approved templates
- [ ] Phase 4 — Workspaces tab + admin behaviour editor + persona generator (auto after first read, review banner)
- [ ] Phase 5 — Reading settings in platform_settings, URL priority/skip rules, per-source URL list, nightly backfill, on-demand read, refresh by content hash, Firecrawl credit caps, merchant "What I know" controls + full-read banner/WhatsApp
- [ ] Phase 6 — Test tab (preview: true → billingExempt)
- [ ] Phase 7 — /admin → Users: super admin list, add/remove, logged + email (email sending is still a stub)
