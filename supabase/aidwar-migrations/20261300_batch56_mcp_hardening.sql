-- Batch 56: an AI app's token (Supabase OAuth, `client_id` claim) gets nothing
-- from Supabase directly; only the AiDwar MCP server, acting for that person,
-- can use it. Idempotent and additive. NOT applied: apply by hand to the
-- Mumbai project (hcsacmqzspnfqoftoifu) after 20261260. Applying it twice
-- changes nothing the second time (batch56-sql.test.ts applies it twice to a
-- throwaway Postgres).
--
-- Batch 52 stopped OAuth tokens WRITING (restrictive write policies + the
-- PostgREST pre-request guard). Anyone who pulled the raw token out of an AI
-- app could still READ through PostgREST (tables, views, GET /rpc, GraphQL),
-- Realtime and Storage everything that person can read under RLS, past the
-- MCP tools' own rules (phone masking without contacts.export, 50-row pages,
-- the mcp_access kill switch, rate limits, the audit log). Now:
--
-- (1) The MCP server proves itself. Every Supabase request it makes with an
--     OAuth token carries the header x-aidwar-mcp-proof: an HMAC-SHA256 key
--     derived with HKDF (label "aidwar-mcp-db-proof") from the server-only
--     AIDWAR_SUPABASE_SERVICE_ROLE_KEY, signing a fixed message (no new
--     secret; src/lib/mcp-db-proof.server.ts). The database keeps only the
--     sha256 of that value, in aidwar_private.mcp_db_proof (a schema
--     PostgREST doesn't expose, no grants). It is written only by
--     mcp_set_db_proof_hash(), which only service_role may run: the MCP
--     server calls it once per isolate before its first read (the bootstrap,
--     never client code). Until then the hash is unset and OAuth tokens get
--     nothing at all (fail closed); no other request notices.
--
-- (2) mcp_request_has_proof(): true only when request.headers (PostgREST sets
--     it, lower-case names) carries a value whose sha256 equals the stored
--     hash. STABLE, so it runs once per statement (an InitPlan in policies).
--
-- (3) mcp_oauth_request_guard() (PostgREST pre-request, Batch 52, still on the
--     authenticator role): a token with client_id is refused for EVERY method
--     (GET and HEAD too) unless it carries the proof; with the proof it may
--     still only GET / HEAD (MCP writes stay on the server's service-role
--     paths). A token without client_id returns at once, as before.
--
-- (4) mcp_block_oauth_reads(): a RESTRICTIVE SELECT policy on every public
--     table with RLS on that `authenticated` may read, and on storage.objects,
--     storage.buckets and realtime.messages when this role may add them:
--     (client_id is null) or mcp_request_has_proof(). Realtime and Storage
--     don't go through the pre-request guard and never forward our header,
--     so a raw OAuth token's subscription hears nothing and its file list is
--     empty. realtime.messages also gets Batch 52's write rule (no Broadcast
--     sends). Restrictive policies only narrow: app sessions, anon and
--     service_role (BYPASSRLS) read exactly as before. Safe to run again (it
--     only adds what's missing) and must be run, with
--     mcp_block_oauth_writes(), at the end of any later migration that turns
--     RLS on (batch56-sql.test.ts checks).
--
-- pg_graphql: /graphql/v1 is PostgREST's rpc graphql_public.graphql, so the
-- guard refuses it, and what it resolves is read under the same policies.
-- Views: both public views are security_invoker (20261014), so the policies
-- apply through them; PostgREST is guarded anyway.
--
-- The code works without this file: the MCP server's bootstrap gets PGRST202
-- (no mcp_set_db_proof_hash), logs it once and carries on; Batch 52's guard
-- ignores the header (batch56-mcp-proof.test.ts).
--
-- Rollback: run the block between "ROLLBACK BEGIN" and "ROLLBACK END" at the
-- end of this file without its leading "-- " (batch56-sql.test.ts runs it).

SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- (1) Where the proof's hash lives, and its only writer.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS aidwar_private;
REVOKE ALL ON SCHEMA aidwar_private FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA aidwar_private FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA aidwar_private FROM authenticated';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS aidwar_private.mcp_db_proof (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  proof_hash text NOT NULL CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
  set_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON aidwar_private.mcp_db_proof FROM PUBLIC;

-- 'match' = already stored; 'set' = stored for the first time; 'replaced' = a
-- different hash was stored (the service-role key was rotated).
CREATE OR REPLACE FUNCTION public.mcp_set_db_proof_hash(p_hash text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  previous text;
BEGIN
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'mcp_set_db_proof_hash: expected the sha256 hex of the proof' USING ERRCODE = '22023';
  END IF;
  SELECT proof_hash INTO previous FROM aidwar_private.mcp_db_proof WHERE id FOR UPDATE;
  IF previous = p_hash THEN
    RETURN 'match';
  END IF;
  INSERT INTO aidwar_private.mcp_db_proof (id, proof_hash, set_at) VALUES (true, p_hash, now())
  ON CONFLICT (id) DO UPDATE SET proof_hash = excluded.proof_hash, set_at = excluded.set_at;
  RETURN CASE WHEN previous IS NULL THEN 'set' ELSE 'replaced' END;
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_set_db_proof_hash(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.mcp_set_db_proof_hash(text) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.mcp_set_db_proof_hash(text) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.mcp_set_db_proof_hash(text) TO service_role';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- (2) Does this request carry the MCP server's proof?
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mcp_request_has_proof()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  headers json;
  supplied text;
  expected text;
BEGIN
  BEGIN
    headers := nullif(current_setting('request.headers', true), '')::json;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  IF headers IS NULL OR json_typeof(headers) <> 'object' THEN
    RETURN false;
  END IF;
  supplied := headers ->> 'x-aidwar-mcp-proof';
  IF supplied IS NULL OR length(supplied) > 256 THEN
    RETURN false;
  END IF;
  SELECT proof_hash INTO expected FROM aidwar_private.mcp_db_proof WHERE id;
  IF expected IS NULL THEN
    RETURN false; -- not bootstrapped yet: fail closed
  END IF;
  RETURN encode(sha256(convert_to(supplied, 'UTF8')), 'hex') = expected;
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_request_has_proof() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.mcp_request_has_proof() TO anon, authenticated, service_role';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- (3) The PostgREST pre-request guard: OAuth tokens only with the proof, and
--     then only to read.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mcp_oauth_request_guard()
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  claims jsonb;
BEGIN
  BEGIN
    claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    RETURN; -- not JSON: not ours to judge, PostgREST rejects a bad token itself
  END;
  IF claims IS NULL OR jsonb_typeof(claims) <> 'object' OR NOT (claims ? 'client_id') OR claims ->> 'client_id' IS NULL THEN
    RETURN; -- every app session, anon and service_role
  END IF;
  IF NOT public.mcp_request_has_proof() THEN
    RAISE EXCEPTION 'AI apps connected to AiDwar work only through the AiDwar MCP tools at https://aidwar.in/mcp.'
      USING ERRCODE = '42501', HINT = 'aidwar_mcp_proof_required';
  END IF;
  IF upper(coalesce(current_setting('request.method', true), '')) IN ('GET', 'HEAD') THEN
    RETURN;
  END IF;
  RAISE EXCEPTION 'AI apps connected to AiDwar can only read here. They make changes through the AiDwar MCP tools, which ask you to confirm.'
    USING ERRCODE = '42501';
END;
$$;

GRANT EXECUTE ON FUNCTION public.mcp_oauth_request_guard() TO anon, authenticated, service_role;

-- Still attached to PostgREST's login role (as 20261260 left it); another
-- pre-request function is left alone and a NOTICE says so.
DO $$
DECLARE
  current_hook text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    RAISE NOTICE 'No authenticator role: pre-request guard not attached.';
    RETURN;
  END IF;
  SELECT substr(cfg, length('pgrst.db_pre_request=') + 1) INTO current_hook
  FROM pg_db_role_setting s
  JOIN pg_roles r ON r.oid = s.setrole
  CROSS JOIN LATERAL unnest(s.setconfig) AS cfg
  WHERE r.rolname = 'authenticator' AND s.setdatabase = 0 AND cfg LIKE 'pgrst.db_pre_request=%'
  LIMIT 1;
  IF current_hook IS NULL OR current_hook IN ('public.mcp_oauth_request_guard', 'mcp_oauth_request_guard') THEN
    IF current_hook IS NULL THEN
      ALTER ROLE authenticator SET pgrst.db_pre_request = 'public.mcp_oauth_request_guard';
    END IF;
    NOTIFY pgrst, 'reload config';
  ELSE
    RAISE NOTICE 'authenticator already runs pre-request %; mcp_oauth_request_guard not attached. Call it from that function.', current_hook;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- (4) Restrictive SELECT policies: Realtime, Storage and anything else that
--     reads under RLS see nothing for an OAuth token without the proof.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mcp_block_oauth_reads()
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  t record;
  pol constant text := 'aidwar_mcp_oauth_select';
  added integer := 0;
  cond constant text := '(((select auth.jwt()) ->> ''client_id'') is null or (select public.mcp_request_has_proof()))';
  no_oauth constant text := '((select auth.jwt()) ->> ''client_id'') is null';
  open_tables text;
BEGIN
  FOR t IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, c.oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relrowsecurity
    ORDER BY c.relname
  LOOP
    CONTINUE WHEN NOT has_table_privilege('authenticated', t.oid, 'SELECT');
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = t.schema_name AND tablename = t.table_name AND policyname = pol
    );
    EXECUTE format('CREATE POLICY %I ON %I.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (%s)',
      pol, t.schema_name, t.table_name, cond);
    added := added + 1;
  END LOOP;

  -- A public table without RLS that members can read is still behind the
  -- pre-request guard for PostgREST, but Realtime would publish it: say so.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO open_tables
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
    AND has_table_privilege('authenticated', c.oid, 'SELECT');
  IF open_tables IS NOT NULL THEN
    RAISE NOTICE 'mcp_block_oauth_reads: RLS is off on % (readable by authenticated); turn RLS on and run this again.', open_tables;
  END IF;

  -- Files: objects and buckets, when this role may add policies there.
  IF to_regclass('storage.objects') IS NOT NULL THEN
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = pol) THEN
        EXECUTE format('CREATE POLICY %I ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated USING (%s)', pol, cond);
        added := added + 1;
      END IF;
      IF to_regclass('storage.buckets') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'buckets' AND policyname = pol) THEN
        EXECUTE format('CREATE POLICY %I ON storage.buckets AS RESTRICTIVE FOR SELECT TO authenticated USING (%s)', pol, cond);
        added := added + 1;
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'mcp_block_oauth_reads: no permission to add policies on storage; Storage reads with an OAuth token are not covered.';
    END;
  END IF;

  -- Realtime Broadcast / Presence on private channels: receiving is a SELECT,
  -- sending an INSERT on realtime.messages.
  IF to_regclass('realtime.messages') IS NOT NULL THEN
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages' AND policyname = pol) THEN
        EXECUTE format('CREATE POLICY %I ON realtime.messages AS RESTRICTIVE FOR SELECT TO authenticated USING (%s)', pol, cond);
        added := added + 1;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages' AND policyname = 'aidwar_mcp_no_oauth_insert') THEN
        EXECUTE format('CREATE POLICY aidwar_mcp_no_oauth_insert ON realtime.messages AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (%s)', no_oauth);
        added := added + 1;
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'mcp_block_oauth_reads: no permission to add policies on realtime.messages; private Broadcast/Presence channels are not covered.';
    END;
  END IF;

  RETURN added;
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_block_oauth_reads() FROM PUBLIC;

-- Any table RLS'd since 20261260 gets its write policies too, then the reads.
SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();

-- ROLLBACK BEGIN
-- DO $$
-- DECLARE p record;
-- BEGIN
--   FOR p IN SELECT schemaname, tablename FROM pg_policies WHERE policyname = 'aidwar_mcp_oauth_select' LOOP
--     EXECUTE format('DROP POLICY IF EXISTS aidwar_mcp_oauth_select ON %I.%I', p.schemaname, p.tablename);
--   END LOOP;
--   IF to_regclass('realtime.messages') IS NOT NULL THEN
--     EXECUTE 'DROP POLICY IF EXISTS aidwar_mcp_no_oauth_insert ON realtime.messages';
--   END IF;
-- END $$;
-- CREATE OR REPLACE FUNCTION public.mcp_oauth_request_guard()
-- RETURNS void
-- LANGUAGE plpgsql
-- STABLE
-- SET search_path = pg_catalog, public
-- AS $fn$
-- DECLARE
--   claims jsonb;
-- BEGIN
--   BEGIN
--     claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
--   EXCEPTION WHEN others THEN
--     RETURN;
--   END;
--   IF claims IS NULL OR NOT (claims ? 'client_id') OR claims ->> 'client_id' IS NULL THEN
--     RETURN;
--   END IF;
--   IF upper(coalesce(current_setting('request.method', true), '')) IN ('GET', 'HEAD') THEN
--     RETURN;
--   END IF;
--   RAISE EXCEPTION 'AI apps connected to AiDwar can only read here. They make changes through the AiDwar MCP tools, which ask you to confirm.'
--     USING ERRCODE = '42501';
-- END;
-- $fn$;
-- DROP FUNCTION IF EXISTS public.mcp_block_oauth_reads();
-- DROP FUNCTION IF EXISTS public.mcp_request_has_proof();
-- DROP FUNCTION IF EXISTS public.mcp_set_db_proof_hash(text);
-- DROP SCHEMA IF EXISTS aidwar_private CASCADE;
-- NOTIFY pgrst, 'reload config';
-- ROLLBACK END
