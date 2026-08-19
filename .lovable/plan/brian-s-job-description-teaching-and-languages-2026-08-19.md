# Brian's job description, teaching, and languages

Four connected changes to the AI employee: a declared set of jobs (skills), the ability to be taught by correction, real multilingual behaviour, and one honest, visible prompt.

## Part 1 — Skills: what Brian's job is

New organisation-scoped table `ai_skills` (key, name, use_when, do_not_use_when, enabled, is_custom, requires jsonb, sort_order), unique per workspace + key, RLS via the existing helpers, seeded for every workspace (existing ones backfilled, new ones through the org-creation seed):

| key | name | needs |
| --- | --- | --- |
| faq_support | Questions about the business | at least one knowledge source |
| product_discovery | Finding and recommending products | catalog_search + at least one product |
| order_status | Where is my order | lookup_order |
| returns_refunds | Returns and refunds | a returns-policy knowledge source |
| lead_qualification | Capturing interest from new buyers | nothing |
| human_handoff | Handing over to a person | nothing |
| opt_out | Stop-messaging requests | nothing — always on |

`opt_out` cannot be switched off (enforced in the database, not only the UI).

Readiness is computed per workspace from what the workspace actually has: brokered tools, knowledge sources, product count. Only skills that are both **enabled** and **ready** are written into the system prompt — name, use_when, do_not_use_when — which sharpens routing and keeps the prompt (and the per-message cost) short.

On `/app/employee`, a new "What Brian's job is" section: one card per skill with a toggle and a plain state — Ready ("Brian handles this."), Not ready ("Brian can't answer returns questions yet — add your returns policy." plus a button that goes to the right screen), Off ("You've switched this off. Brian will hand these to a person."). A summary line reads "Brian can do 4 of 7 jobs." Merchants can edit use_when / do_not_use_when and add custom skills.

## Part 2 — Teach Brian

No new retrieval pipeline: corrections use the existing `manual_qa` source, chunking, and embeddings (`saveCorrection` already exists).

- A thumbs-down on every AI message in the inbox opens "What should Brian have said?", showing the customer's question and pre-filled with what Brian actually said. Saving writes a manual_qa document into that workspace's corrections source, creating it on first use.
- When a correction is retrieved for an answer, the inbox shows under the reply: "Brian used something you taught him on 19 August." Each correction records a use count.
- Corrections are listed under Knowledge as "Things you've taught Brian (12)", editable and deletable.

## Part 3 — Languages

- New workspaces default to English **and** Hindi.
- The system prompt lists the enabled languages and instructs: reply in the language the customer wrote in, including Hinglish in Latin script; if their language is not enabled, use the first enabled language.
- Each inbound message stores its detected language, so it can be reported.
- The behaviour screen warns when the written instructions mention a language that is not enabled.
- Supported: English, Hindi, Marathi, Gujarati, Tamil, Bengali, Telugu, Kannada.

## Part 4 — Prompt assembly

- `escalation_rules` is currently injected twice (once inside `agentBrief`, again in the `system` array at `src/lib/ai-tasks.server.ts:266`). It will appear once.
- `AGENT_RULES` moves into a new `ai_prompt_blocks` table (key, name, description, content, default_content, version, updated_by, updated_at), seeded with the current text, readable by all members, writable only by super admins and logged through `log_super_admin_write`. If the row is missing or empty the hardcoded constant is used — a database miss never strips the rules.
- The word-limit rule becomes: "Keep replies short — under 60 words for a normal answer. When listing products, one short line per product is fine."
- `ai_runs.prompt_rules_version` records which version of the rules produced each answer.

## Part 5 — Exactly what Brian is told

A read-only panel on `/app/employee` showing the assembled system prompt for that workspace in labelled sections: Platform rules (with an edit link for super admins), Who he is, His jobs, Your instructions, When to fetch a person (empty reads "You haven't set any. Brian only escalates when the system decides to."), What he's been taught, and a note that matched knowledge is appended at answer time. Below it, the assembled character count and an estimated per-message cost, so a longer brief visibly costs more.

## Technical notes

- Migrations applied through `AIDWAR_MUMBAI_DB_URL` and verified by query: `ai_skills` (+ seed and backfill, opt_out guard trigger), `ai_prompt_blocks` (+ seed + super-admin write policy), `ai_runs.prompt_rules_version`, `messages.detected_language`, default languages `{en,hi}` for new instruction rows, and a replacement `match_knowledge_chunks` that also returns source type and document id so correction usage can be attributed and counted.
- Prompt assembly consolidates into one builder used by both `agentAnswer` and `playgroundAnswer`, so the preview panel and the live answer cannot drift apart.
- Language detection runs as a script/keyword heuristic inside the webhook processing path — no extra model call, no added per-message cost.
- Skills, teaching, and the prompt panel each ship behind a feature flag in the registry, with the usual loading, empty, and error states.
