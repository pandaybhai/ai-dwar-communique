# The AI employee

Build the AI layer as an employee a merchant hires, briefs, tests and supervises — not as settings. Everything ships off by default for every workspace.

Verified starting point (checked against the live database and the repository):
- `src/lib/ai-tools.server.ts` already brokers tools — feature-flag gating, permission gating, server-bound `organization_id`, confirmation gating, write rate limiting. It stays the only execution path and is extended, never replaced.
- No `ai_*` or `knowledge_*` tables exist. pgvector is not installed.
- Live permission keys are `ai.use` and `ai.configure`. The `ai_features` flag is `default_enabled = true` in the database despite the registry default of off — this build sets it off so nothing appears until a Super Admin enables it.

## Part 1 — The model layer

Tables, each with RLS, GRANTs and `has_permission`-based policies:

- `ai_agents` — org, name, avatar, mode (off|draft|replying, default off), is_default, timestamps. Exactly one seeded per workspace, no agent-switcher UI in this build; the schema simply permits more later, because retrofitting that dimension across instructions, runs and knowledge is a five-table migration.
- `ai_providers` — org, provider (anthropic|openai|google|lovable), model, is_default, status, and the Vault secret **name** only. Keys live in Supabase Vault and never reach the client.
- `ai_models` — provider, model_id, display_name, is_available, supports_tools, context_window, recommended_for, is_deprecated. Merchants pick from this catalogue; never a free-text model string, which breaks silently when a provider retires a model.
- `ai_task_models` — org, task (suggest_reply|summarise|auto_tag|agent_reply|embedding), provider, model_id. Resolution at run time: per-task → per-agent → workspace default → platform default, first match wins. Seeded cheap-and-fast for auto_tag and summarise, strongest available for agent_reply. Only `supports_tools = true` models may be chosen for agent_reply — enforced in validation, not only in the UI.
- `ai_rates` — provider, model, input/output rate, currency, effective_from. Same pattern as `message_rates`; rates are data, never hardcoded.
- `ai_runs` — org, agent_id, conversation, acting role, provider, model, task, input summary, output, confidence, escalation_signal, tool_call_count, tokens, cost_amount, cost_source, latency_ms, status (ok|refused|escalated|capped|error), error, nullable comparison_id.
- `ai_tool_calls` — one row per call, linked to the run and to its existing `activity_log` entry rather than duplicating it.
- `ai_usage` — daily rollup per org.

`/api/internal/ai-run` is the single place in the codebase that calls a model. Service-role only. It resolves provider and model, loads tools through `brokerTools()`, executes only through `invokeTool()`, prices the run from `ai_rates`, and writes the run and its tool calls. Every surface — inbox suggestions, agent, playground, comparison — goes through it.

`lovable` works with zero configuration so a workspace is useful before anyone supplies a key. Per-org `ai_enabled` defaults false and is seeded off. `ai_monthly_cap_amount` is enforced against real recorded spend; over cap a run returns `status='capped'` and refuses rather than quietly degrading.

## Part 2 — What they know

Enable pgvector first.

**Live** sources — orders, stock, catalogue price and availability — are queried at question time through the tool broker and never embedded. Embedding an order means telling a customer a delivered parcel is still in transit.

**Static** sources are parsed, chunked, embedded and retrieved by meaning:
- `knowledge_sources` — type (website|pdf|spreadsheet|manual_qa|meta_catalog|woocommerce|shopify), config, status, last_synced_at, item count, last error, refresh cadence, nullable agent_id (null = every agent).
- `knowledge_documents` — one normalised item whatever its origin: a web page, a PDF section, a spreadsheet row, a product.
- `knowledge_chunks` — text, embedding, embedding_model, dimensions, plus source_id and source_ref back to origin. Retrieval filters to the active embedding model, so a model change can run both side by side instead of forcing one big re-embed.

One connector interface: a source type implements a single "fetch and return documents" function. Chunking, embedding, retrieval, the agent and the UI know nothing about origin, so WooCommerce or Meta catalogue later is one new file and no other change. Connectors in this build: website crawl (robots.txt respected, page cap, weekly re-crawl), spreadsheet (CSV/XLSX rows), PDF, manual Q&A.

Conversations, contacts and order data are never embedded — business content only, which also keeps the retention rules intact.

## Part 3 — How they should behave

`ai_instructions` hanging off agent_id: persona_name, tone, free-form instructions, escalation_rules, languages, working_hours_behaviour, updated_at, updated_by. Every change versioned so a merchant can revert.

## Part 4 — Suggested replies and summaries (first visible value)

In the shared inbox, needing no knowledge base so it works for merchants with no store: **Suggest a reply** (a human always presses send), **Summarise this conversation** (three lines above a long thread), **Auto-tag** (proposed tags applied only on acceptance). Each writes an `ai_runs` row.

## Part 5 — The agent

Answers inbound messages from retrieved knowledge plus live tools. Every answer carries provenance — the source or tool it came from.

Escalation does not depend on self-reported confidence; models judge their own certainty badly. The confidence column stays for later analysis, but escalation fires on observable signals, each recorded in `escalation_signal`:
- no knowledge chunk matched above the similarity floor
- a tool call failed, errored, or returned empty
- the customer repeated the same question, or shows frustration
- the question touches refunds, complaints, cancellations, or anything the merchant's escalation rules name
- the agent would otherwise answer citing no source and no tool

Escalation goes into the existing inbox queue with a note explaining why. Never messages opted-out contacts, respects quiet hours, holds exactly the permissions a human agent holds. Modes: Off (default), Draft only (recommended first step), Replying.

## Part 6 — Try them out

A playground that touches no customer: answer, sources used, tools called, sure/not-sure, cost and speed. Pre-loaded with real past questions from the inbox so a test is realistic. Nothing here sends a message.

**Side-by-side comparison** — one question through two configurations (different brains, or the same brain with different instructions) showing answer, sources, tools, would-it-answer-or-pass-to-you, cost and speed.

**Batch comparison**, the important one — the last 20 real customer questions run through both configurations, summarised as how many each answered, how many each passed on, total cost, average speed, then the individual pairs for reading.

**Pick a winner** — one button on the winning column writes that choice to `ai_task_models`. No copying names by hand.

`ai_comparisons` — org, agent, question set, config A, config B, results, winner, created_by, created_at. Every run inside a comparison writes a normal `ai_runs` row tagged with the comparison id, so cost counts honestly against the cap.

**Gate the mode change** — switching from Draft only to Replying with no playground or comparison run in the last 7 days shows: "You haven't tested this yet. Want to see how it would have answered your last 20 customer questions first?" Offer to run it, allow skipping, make skipping deliberate.

## Part 7 — The revise loop

In any conversation or playground result, a merchant corrects a wrong answer inline. The correction is stored as a manual Q&A source, attributed and dated, and used from then on. No prompt writing required.

## Part 8 — Their work

Answered, passed to you, refused. Escalation rate over time broken down by which signal caused it. Cost per answered conversation, by task. Top questions it couldn't answer — the screen that tells a merchant exactly what to add. Every run inspectable: asked, answered, sources, tools, sure/not-sure, cost.

## Part 9 — The interface

Route `/app/employee`, in this order: **Meet your AI employee** (name, avatar, mode, one honest line — "Answered 41 questions this week. Passed 6 to you.") → **What they know** (plain list: "Your website — 24 pages, checked today", "Price list.xlsx — 112 products"; every item openable and deletable) → **What they can do** (brokered tools in plain words; unavailable ones greyed with the reason shown) → **How they should behave** (instructions, tone, escalation rules, plus "Which brain to use": Recommended, or Choose myself revealing per-task pickers described in outcomes — "Faster and cheaper — good for sorting and summarising" versus "Smarter — use this when talking to customers") → **Try them out** → **Their work**.

No jargon on screen, ever: never tokens, inference, model, RAG, embedding, vector, confidence score, run, prompt. Say cost, sure / not sure, sources, answered, passed to you, brain.

Accessibility to the Flows-page standard, non-negotiable: logical keyboard order with a ≥3:1 focus ring, text contrast ≥4.5:1, status by icon and word never colour alone, ≥44px targets, real `<table>`/`<th>`, `role="switch"` with `aria-checked` on the mode control, polite live regions, `prefers-reduced-motion` respected, usable at 200% zoom, no disabled control without a visible reason. Mobile-first — phone layout designed first, tables become cards, no horizontal scrolling at any width.

Where cost or certainty is unavailable, the screen says so rather than estimating.

## Permissions

No new keys. `ai.manage` duplicates `ai.configure`; `ai.view` is unnecessary because anyone who can use the AI can see its work.
- `ai.use` — inbox suggestions, summaries, auto-tag, playground, comparison, viewing Their work. Owner, admin, marketer, agent.
- `ai.configure` — providers and keys, brain choice, spend cap, knowledge sources, instructions, mode changes. Owner and admin.

Genuinely new actions later follow the existing `<feature>.<verb>` convention (anticipated: `ai.publish`, `ai.knowledge.manage`); never a key duplicating an existing scope.

## Technical notes

- Migrations applied to the Mumbai project and verified by querying it; every new public table gets GRANTs, RLS and `has_permission`-based policies.
- Feature registry: `ai` gains `nav_path: /app/employee`, the new tool declarations, activity actions, analytics event types, usage meters and `data_tables`. `ai_features` default flipped to off and set off in the database.
- Connectors, embedding, retrieval, provider resolution and Vault reads live behind `.server.ts` or internal routes — keys never enter the client bundle.
- Website crawl, embedding refresh and weekly re-crawl run as cron-guarded internal routes following the existing `x-cron-secret` pattern.
- Add `.env` to `.gitignore` — it is currently tracked.

## Order of delivery

1. Model layer, agents, brain catalogue, kill switch, registry and permissions
2. Inbox suggest / summarise / auto-tag — value before the knowledge base
3. Knowledge base, connectors, instructions
4. Agent with signal-based escalation and modes
5. Playground, comparison, revise loop, Their work
6. Full `/app/employee` interface and accessibility pass
