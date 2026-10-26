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
- src/lib has its own AGENTS.md — read it before changing files there. It holds the rules for flows, billing/payments, campaigns, the website reader, and Aiden.
- scripts/schema-parity.sql is generated from supabase/aidwar-migrations by `node scripts/schema-parity.mjs` and must be regenerated with every new migration (batch28-schema-parity.test.ts fails while stale) — why: it is the after-publish check for migrations that never reached live.
- tslib is resolved to its own pure-ESM file at build time (tslibEsm in vite.config.ts, tslib-esm.build.ts) — why: tslib's modules/index.js default import came out undefined in the server bundle and pdf-lib crashed on load (invoice PDFs).
