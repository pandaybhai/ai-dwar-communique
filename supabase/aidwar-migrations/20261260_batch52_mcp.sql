-- Batch 52: AiDwar MCP (connect AiDwar to Claude, ChatGPT, Codex and Cursor).
-- Idempotent and additive. NOT applied: apply by hand to the Mumbai project
-- (hcsacmqzspnfqoftoifu). Applying it twice changes nothing the second time
-- (batch52-sql.test.ts applies it twice to a throwaway Postgres).
--
-- An AI app the merchant connects gets a Supabase OAuth access token. That
-- token is a normal user JWT for the merchant plus a `client_id` claim; the
-- app's own sessions never carry `client_id` (Supabase OAuth server docs,
-- token-security). The AI app must be able to change things ONLY through the
-- MCP tools at https://aidwar.in/mcp (draft, then the merchant confirms), so:
--
-- (1) mcp_block_oauth_writes(): a RESTRICTIVE policy per write command on
--     every public table that has RLS on and that `authenticated` may write.
--     Each says `auth.jwt() ->> 'client_id' IS NULL`. A restrictive policy
--     only narrows: a token without client_id (every app session) is judged
--     by the existing permissive policies exactly as before; a token with one
--     can't insert, update or delete a single row through PostgREST. The
--     function is safe to run again (it only adds missing policies) and must
--     be run after any later migration that turns RLS on for a new table
--     (batch52-sql.test.ts checks later migrations do). storage.objects gets
--     the same policies when this role may create them.
--
-- (2) mcp_oauth_request_guard(): a PostgREST pre-request check. RLS doesn't
--     cover SECURITY DEFINER functions called through /rpc, nor tables
--     without RLS, so a request whose token carries client_id may only read
--     (GET / HEAD). Every other request is untouched: the function returns at
--     once when the token has no client_id. It is attached to the
--     authenticator role only when no other pre-request function is set (a
--     different one is left alone and a NOTICE says so).
--
-- (3) The mcp_access flag (default ON, every plan incl. trial; Super Admin ->
--     Flags switches one workspace off) and its feature_registry row
--     (feature 'mcp', permission 'mcp.use' for every role). The code treats a
--     missing flag row as on and a missing mcp.use permission row as allowed,
--     so it works before this file is applied (mcp-access tests).
--
-- Rate limits reuse Batch 34's api_rate_take / api_rate_windows (buckets
-- mcp:user:<id> and mcp:send:<org>); no new table.
--
-- The MCP server's own writes run server-side with the service role through
-- the app's existing functions (launchCampaign, the Flows v2 create/publish,
-- the segment insert with segments.manage checked), so nothing here blocks
-- them.
--
-- Rollback:
--   alter role authenticator reset pgrst.db_pre_request; notify pgrst, 'reload config';
--   select format('drop policy %I on %I.%I;', policyname, schemaname, tablename)
--     from pg_policies where policyname like 'aidwar_mcp_no_oauth_%';  -- run the output
--   update public.feature_flags set default_enabled = false where key = 'mcp_access';

SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- (1) Restrictive policies: OAuth (AI app) tokens can't write tables directly.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mcp_block_oauth_writes()
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  t record;
  cmd text;
  pol text;
  added integer := 0;
  cond constant text := '((select auth.jwt()) ->> ''client_id'') is null';
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
    FOREACH cmd IN ARRAY ARRAY['insert', 'update', 'delete'] LOOP
      CONTINUE WHEN NOT has_table_privilege('authenticated', t.oid, upper(cmd));
      pol := 'aidwar_mcp_no_oauth_' || cmd;
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = t.schema_name AND tablename = t.table_name AND policyname = pol
      );
      IF cmd = 'insert' THEN
        EXECUTE format('CREATE POLICY %I ON %I.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (%s)',
          pol, t.schema_name, t.table_name, cond);
      ELSIF cmd = 'update' THEN
        EXECUTE format('CREATE POLICY %I ON %I.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',
          pol, t.schema_name, t.table_name, cond, cond);
      ELSE
        EXECUTE format('CREATE POLICY %I ON %I.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (%s)',
          pol, t.schema_name, t.table_name, cond);
      END IF;
      added := added + 1;
    END LOOP;
  END LOOP;

  -- Files: the same rule on storage.objects, when this role may add policies there.
  IF to_regclass('storage.objects') IS NOT NULL THEN
    BEGIN
      FOREACH cmd IN ARRAY ARRAY['insert', 'update', 'delete'] LOOP
        pol := 'aidwar_mcp_no_oauth_' || cmd;
        CONTINUE WHEN EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = pol
        );
        IF cmd = 'insert' THEN
          EXECUTE format('CREATE POLICY %I ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (%s)', pol, cond);
        ELSIF cmd = 'update' THEN
          EXECUTE format('CREATE POLICY %I ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', pol, cond, cond);
        ELSE
          EXECUTE format('CREATE POLICY %I ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated USING (%s)', pol, cond);
        END IF;
        added := added + 1;
      END LOOP;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'mcp_block_oauth_writes: no permission to add policies on storage.objects; files are covered by the pre-request guard only for PostgREST, not Storage.';
    END;
  END IF;

  RETURN added;
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_block_oauth_writes() FROM PUBLIC;

SELECT public.mcp_block_oauth_writes();

-- ---------------------------------------------------------------------------
-- (2) PostgREST pre-request guard: an OAuth (AI app) token may only read.
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
  IF claims IS NULL OR NOT (claims ? 'client_id') OR claims ->> 'client_id' IS NULL THEN
    RETURN; -- every app session, anon and service_role
  END IF;
  IF upper(coalesce(current_setting('request.method', true), '')) IN ('GET', 'HEAD') THEN
    RETURN;
  END IF;
  RAISE EXCEPTION 'AI apps connected to AiDwar can only read here. They make changes through the AiDwar MCP tools, which ask you to confirm.'
    USING ERRCODE = '42501';
END;
$$;

GRANT EXECUTE ON FUNCTION public.mcp_oauth_request_guard() TO anon, authenticated, service_role;

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
    ALTER ROLE authenticator SET pgrst.db_pre_request = 'public.mcp_oauth_request_guard';
    NOTIFY pgrst, 'reload config';
  ELSE
    RAISE NOTICE 'authenticator already runs pre-request %; mcp_oauth_request_guard not attached. Call it from that function.', current_hook;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- (3) The mcp_access flag (default on) and the feature registry row.
-- ---------------------------------------------------------------------------

INSERT INTO public.feature_flags (key, name, description, default_enabled)
VALUES (
  'mcp_access',
  'AI assistants (MCP)',
  'Let the team connect Claude, ChatGPT, Codex or Cursor to this workspace at https://aidwar.in/mcp: read the workspace and draft campaigns and flows; sending or switching on always needs their confirmation.',
  true
)
ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description;

INSERT INTO public.feature_registry (
  key, name, description, icon, nav_path, nav_order, nav_permission, flag_key, settings_path,
  permissions, analytics, activity_actions, usage_meters, ai_tools, data_tables, depends_on, synced_at
) VALUES (
  'mcp', 'AI assistants (MCP)',
  'Let the team connect Claude, ChatGPT, Codex or Cursor to this workspace at https://aidwar.in/mcp: read the workspace and draft campaigns and flows; sending or switching on always needs their confirmation.',
  'sparkles', null, null, null, 'mcp_access', '/app/settings',
  '[{"key":"mcp.use","name":"Use AiDwar from an AI assistant","description":"Connect Claude, ChatGPT, Codex or Cursor and use AiDwar through it, with the same permissions as in the app.","min_role":"agent"}]'::jsonb,
  '{"event_types":[],"metrics":[],"dashboard_section":false}'::jsonb,
  array['mcp_segment_created', 'mcp_campaign_drafted', 'mcp_campaign_sent', 'mcp_flow_drafted', 'mcp_flow_activated']::text[],
  '[]'::jsonb, '[]'::jsonb, '{}'::text[], array[]::text[], now()
)
ON CONFLICT (key) DO UPDATE SET
  name = excluded.name, description = excluded.description, icon = excluded.icon,
  flag_key = excluded.flag_key, settings_path = excluded.settings_path,
  permissions = excluded.permissions, analytics = excluded.analytics,
  activity_actions = excluded.activity_actions, depends_on = excluded.depends_on,
  synced_at = now();

-- The permission's category is its feature key; a category check that
-- doesn't know it yet is rebuilt with every category already stored.
DO $$
DECLARE
  def text;
  allowed text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conname = 'permissions_category_check' AND conrelid = 'public.permissions'::regclass;
  IF def IS NOT NULL AND position('''mcp''' IN def) = 0 THEN
    SELECT string_agg(quote_literal(c), ', ' ORDER BY c) INTO allowed
    FROM (
      SELECT DISTINCT category AS c FROM public.permissions WHERE category IS NOT NULL
      UNION SELECT key FROM public.feature_registry
      UNION SELECT 'mcp'
    ) s;
    ALTER TABLE public.permissions DROP CONSTRAINT permissions_category_check;
    EXECUTE format('ALTER TABLE public.permissions ADD CONSTRAINT permissions_category_check CHECK (category IN (%s))', allowed);
  END IF;
END $$;

INSERT INTO public.permissions (key, name, description, category, min_role)
VALUES (
  'mcp.use', 'Use AiDwar from an AI assistant',
  'Connect Claude, ChatGPT, Codex or Cursor and use AiDwar through it, with the same permissions as in the app.',
  'mcp', 'agent'
)
ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description,
  category = excluded.category, min_role = excluded.min_role;

INSERT INTO public.role_permissions (role, permission_key)
VALUES ('owner', 'mcp.use'), ('admin', 'mcp.use'), ('marketer', 'mcp.use'), ('agent', 'mcp.use')
ON CONFLICT DO NOTHING;
