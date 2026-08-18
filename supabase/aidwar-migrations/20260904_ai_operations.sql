-- Close the AI operations gaps: durable tool traces, discoverable navigation,
-- and an explicit platform provider registry.

-- Every configured provider has a platform row, even before its key is added.
INSERT INTO public.platform_ai_providers (provider, is_active)
VALUES
  ('lovable', true),
  ('openai', false),
  ('anthropic', false),
  ('google', false)
ON CONFLICT (provider) DO NOTHING;

-- The manifest is authoritative, but repair the live registry immediately too.
UPDATE public.feature_registry
SET name = 'AI employee',
    nav_path = '/app/employee',
    nav_order = 55,
    nav_permission = 'ai.use',
    synced_at = now()
WHERE key = 'ai';

-- A trace batch is written through one database function after the run exists.
-- If a trace cannot be stored the whole call fails; callers must not silently
-- claim a tool count without the corresponding rows.
CREATE OR REPLACE FUNCTION public.record_ai_tool_calls(
  p_run_id uuid,
  p_organization_id uuid,
  p_calls jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
  v_expected integer := COALESCE(jsonb_array_length(p_calls), 0);
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.ai_runs
    WHERE id = p_run_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'AI run does not belong to this organization';
  END IF;

  INSERT INTO public.ai_tool_calls (
    organization_id, run_id, tool_name, ok, error, latency_ms, activity_log_id
  )
  SELECT
    p_organization_id,
    p_run_id,
    call->>'tool_name',
    COALESCE((call->>'ok')::boolean, false),
    NULLIF(call->>'error', ''),
    NULLIF(call->>'latency_ms', '')::integer,
    NULLIF(call->>'activity_log_id', '')::uuid
  FROM jsonb_array_elements(COALESCE(p_calls, '[]'::jsonb)) AS call;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> v_expected THEN
    RAISE EXCEPTION 'Expected % AI tool traces, wrote %', v_expected, v_inserted;
  END IF;
  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_tool_calls(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_tool_calls(uuid, uuid, jsonb)
  TO service_role;

-- Repair historical runs that counted a tool but predated durable trace writes.
-- The broker activity is the original source of truth; match only the same
-- organization/user and the immediately preceding invocation.
INSERT INTO public.ai_tool_calls (
  organization_id, run_id, tool_name, ok, error, latency_ms, activity_log_id, created_at
)
SELECT
  r.organization_id,
  r.id,
  a.details->>'tool',
  COALESCE(a.details->>'status', 'error') = 'ok',
  NULLIF(a.details->>'detail', ''),
  NULL,
  a.id,
  a.created_at
FROM public.ai_runs r
CROSS JOIN LATERAL (
  SELECT l.id, l.details, l.created_at
  FROM public.activity_log l
  WHERE l.organization_id = r.organization_id
    AND l.action = 'ai_tool_invoked'
    AND (r.user_id IS NULL OR l.user_id = r.user_id)
    AND l.created_at <= r.created_at
    AND l.created_at >= r.created_at - interval '30 seconds'
  ORDER BY l.created_at DESC
  LIMIT 1
) a
WHERE r.tool_call_count > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.ai_tool_calls tc WHERE tc.run_id = r.id
  );