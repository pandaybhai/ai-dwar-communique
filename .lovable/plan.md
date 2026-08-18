# The AI employee

Build the AI layer as an employee a merchant hires, briefs, tests and supervises — not as settings. Shipped in nine parts, everything off by default for every workspace.

Verified starting point (checked against the live backend and code):
- `src/lib/ai-tools.server.ts` already brokers tools (flag + permission gating, server-bound organization, confirmation, write rate limit). It stays the only execution path and is extended, never replaced.
- No `ai_*` or `knowledge_*` tables exist yet; pgvector is not installed yet.
- The registry's `ai` feature exists with `ai.use` and `ai.configure`, no page and no data tables. The `ai_features` flag is currently **on** in the database despite the registry default of off — this build turns it off so nothing appears until a Super Admin enables it.

## Part 1 — The model layer

New tables (RLS + grants on every one, org-scoped through `is_org_member` / `has_permission`):
`ai_providers` (provider, model, is_default, status, vault secret **name** only — keys live in Supabase Vault and never leave the server), `ai_rates` (provider, model, input/output rate, currency, effective_from — same pattern as `message_rates`, rates are data), `ai_runs` (org, conversation, acting role, provider, model, input summary, output, confidence, tool_call_count, tokens, cost_amount, cost_source, latency_ms, status ok|refused|escalated|capped|error, error), `ai_tool_calls` (one row per call, linked to the run and to its `activity_log` entry), `ai_usage` (daily rollup per org).

`/api/internal/ai-run` is the single place in the codebase that calls a model. Service-role only. It resolves the provider, loads tools through `brokerTools()`, executes only through `invokeTool()`, prices the run from `ai_rates`, and writes the run plus its tool calls. Every other surface (inbox suggestions, agent, playground) calls this route.

Defaults: `lovable` provider works with zero configuration, so a workspace is useful before anyone supplies a key; a direct key is configuration only. Per-org `ai_enabled` (default false, seeded off) and `ai_monthly_cap_amount` enforced against real recorded spend — over cap the run returns `status='capped'` and refuses rather than quietly degrading.

## Part 2 — What they know

Enable pgvector first.

Two classes, kept apart by design:
- **Live** — orders, stock, catalogue price/availability. Queried at question time through the tool broker, never embedded. Embedding an order would tell a customer a delivered parcel is in transit.
- **Static** — parsed, chunked, embedded, retrieved by meaning.

`knowledge_sources` (type website|pdf|spreadsheet|manual_qa|meta_catalog|shopify, config, status, last_synced_at, item count, last error, refresh cadence), `knowledge_documents` (one normalised item whatever the origin), `knowledge_chunks` (text + embedding, each carrying source_id and source_ref back to origin).

One connector interface: a source type implements a single "fetch and return documents" function. Chunking, embedding, retrieval, the agent and the UI know nothing about origin, so WooCommerce or Meta catalogue later is one new file and no other change. Connectors now: website crawl (robots.txt respected, page cap, weekly re-crawl), spreadsheet (CSV/XLSX rows), PDF, manual Q&A.

Conversations, contacts and order data are never embedded — business content only, which also keeps the retention rules intact.

## Part 3 — How they should behave

`ai_instructions` per organisation: persona_name, tone, free-form instructions, escalation rules, languages, working-hours behaviour, updated_at/updated_by — every change versioned so a merchant can revert.

## Part 4 — Suggested replies and summaries (first visible value)

In the shared inbox, and needing no knowledge base: **Suggest a reply** (a human always presses send), **Summarise this conversation** (three lines above a long thread), **Auto-tag** (proposed tags applied only on acceptance). Each writes an `ai_runs` row.

## Part 5 — The agent

Answers inbound messages from retrieved knowledge plus live tools. Every answer carries provenance — the source or tool it came from. Below the confidence threshold, or when the instructions say so, it escalates into the existing inbox queue with a note explaining why; it never guesses at a customer. Never messages opted-out contacts, respects quiet hours, and holds exactly the permissions a human agent holds. Three modes: Off (default), Draft only (recommended first step), Replying.

## Part 6 — Try them out

A playground that touches no customer: answer, sources used, tools called, sure/not-sure, cost and speed. Pre-loaded with real past questions from the inbox so a test is realistic. Nothing here sends a message.

## Part 7 — The revise loop

In a conversation or a playground result, a merchant corrects a wrong answer inline. The correction is stored as a manual Q&A source, attributed and dated, and used from then on. No prompt writing required.

## Part 8 — Their work

Answered, passed to you, refused. Escalation rate over time. Cost per answered conversation. **Top questions it couldn't answer** — the screen that tells a merchant exactly what to add. Every run inspectable: asked, answered, sources, tools, sure/not-sure, cost.

## Part 9 — The interface

Route `/app/employee`, in this order: Meet your AI employee (name, avatar, mode, one honest line — "Answered 41 questions this week. Passed 6 to you.") → What they know → What they can do (brokered tools in plain words; unavailable ones greyed **with the reason shown**) → How they should behave → Try them out → Their work.

No jargon on screen: never tokens, inference, model, RAG, embedding, vector, confidence score, run. Say cost, sure / not sure, sources, answered, passed to you.

Accessibility to the Flows-page standard, non-negotiable: logical keyboard order with a ≥3:1 focus ring, text contrast ≥4.5:1, status by icon + word never colour alone, ≥44px targets, real `<table>`/`<th>`, `role="switch"` with `aria-checked` on the mode control, polite live regions, `prefers-reduced-motion`, usable at 200% zoom, no disabled control without a visible reason. Mobile-first: phone layout designed first, tables become cards, no horizontal scrolling at any width.

Where cost or certainty is unavailable, the screen says so rather than estimating.

## Technical notes

- Migrations applied through `AIDWAR_MUMBAI_DB_URL` with psql and verified by querying the external project; every new public table gets GRANTs, RLS and `has_permission`-based policies.
- Feature registry: `ai` gains `nav_path: /app/employee`, the new permissions `ai.view` / `ai.manage` alongside existing `ai.use`, the new AI tool declarations, activity actions, analytics event types, usage meters and its `data_tables`. `ai_features` default flipped to off and set off in the database.
- Server-only files: connectors, embedding, retrieval, provider resolution and Vault reads live behind `.server.ts` / internal routes; keys never enter the client bundle.
- Website crawl, embedding refresh and weekly re-crawl run as cron-guarded internal routes following the existing `x-cron-secret` worker pattern.
- Tool calls remain logged to `activity_log` exactly as today; `ai_tool_calls` links to those rows rather than duplicating them.

## Order of delivery

1. Model layer + kill switch + registry/permissions (Parts 1, 9 scaffold)
2. Inbox suggest / summarise / auto-tag (Part 4) — value before the knowledge base
3. Knowledge base + connectors (Part 2) and instructions (Part 3)
4. Agent with escalation and modes (Part 5)
5. Playground, revise loop, their work (Parts 6–8)
6. Full `/app/employee` interface polish and accessibility pass (Part 9)
