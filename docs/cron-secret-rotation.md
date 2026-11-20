# Rotating the cron secret

The cron secret authenticates every pg_cron call to `/api/internal/*`. The jobs
send it in the `x-cron-secret` header, read at run time from the Vault secret
`aidwar_cron_secret`. The app compares it with its `CRON_SECRET` environment
variable (`cronSecretAccepted`, `src/lib/cron-auth.server.ts`).

## Why it must be rotated now

Three early Lovable migrations had the secret written in plain text:
`supabase/migrations/20260814100220_…`, `…100304_…` and `…100347_…`. They now
read it from the Vault, but the old value is still in git history. History
can't be rewritten (Lovable), so the old value must be treated as public and
replaced.

## Steps (no cron run is missed)

1. **Make a new secret** (48+ random characters), for example:
   `openssl rand -base64 36 | tr '+/' '-_' | tr -d '='`
2. **App environment** (where `CRON_SECRET` is set today):
   - set `CRON_SECRET_PREVIOUS` to the **current** value;
   - set `CRON_SECRET` to the **new** value;
   - redeploy.
   The routes now accept both values.
3. **Vault** (Supabase SQL editor, as an owner):
   ```sql
   select vault.update_secret(
     (select id from vault.secrets where name = 'aidwar_cron_secret'),
     '<new value>'
   );
   ```
   The next tick of every job sends the new value.
4. **Check.** Each cron job's next run answers 200. You can see this in
   `net._http_response` (status_code) or the job logs, and campaigns, flows
   and billing notices keep moving.
5. **Remove `CRON_SECRET_PREVIOUS`** from the app environment and redeploy.
   From then on the old value gets 401 on every `/api/internal/*` route.

If you'd rather skip the overlap, change `CRON_SECRET` and the Vault value
together. Cron calls answer 401 until both match, usually a minute or two;
the workers catch up on their next run.
