<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->
- Flows v2 runs live in flow_runs/flow_versions/flow_run_events and execute only via src/lib/flow-engine.server.ts (minute tick in flow-worker + webhook reply hook); legacy event flows keep flows/flow_steps/scheduled_sends — why: v2 must never change how existing store flows behave.
- Merchant-owned third-party accounts (Google, Razorpay for flows) live in workspace_connections with secrets only in Vault via service-role RPCs — why: secrets must never reach client-readable tables.
- Flows v2 HTTP-step header values live only in flow_http_secrets/Vault (bound to the step's scheme+host+path) and the graph keeps a secret_id; exports/imports carry header names only — why: flow_versions is readable by every member.
- Flow step names in the palette (NODE_META label/hint) are wording only; the stored NodeType keys (e.g. "carousel" = WhatsApp shop) and /app/catalog routes never change — why: saved flows and old links store those keys.
- campaigns.charged_amount mirrors the sum of the campaign's debit_message ledger rows, written only by syncCampaignCharged/settleCampaignSpend (re-read, raise-only) — why: Meta prices messages after settle, and the ledger is the single source of truth.
- Customer cards are opt-in per place (inbox Send card, Flows v2 "send_card" step, a campaign's attached card); every card goes through customer-cards.server.ts (sendCardToContact / sendCardOrFallback) and a failed card falls back to the plain photo/text. Aiden's and Show products' product card follows organizations.branding.product_cards_in_answers (only an explicit false turns it off) — why: a card must never block a message, and the default must equal pre-switch behaviour.
- AI backup providers (ANTHROPIC_API_KEY / OPENAI_API_KEY) are used only from src/lib/ai-fallback.server.ts via executeRun/embedTexts, only on a primary outage (402/credit 403/429/5xx/unreachable), never for a workspace on its own (BYOA) key; embeddings fall back only to OpenAI text-embedding-3-small — why: no backup key must mean behaviour exactly as before, and stored vectors only match the same embedding model.
