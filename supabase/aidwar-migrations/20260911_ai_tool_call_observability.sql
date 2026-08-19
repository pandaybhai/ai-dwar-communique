-- Debugging visibility for tool behaviour: what the model asked for, and a
-- compact fingerprint of what came back. Never a copy of customer data.

ALTER TABLE public.ai_tool_calls
  ADD COLUMN IF NOT EXISTS arguments jsonb,
  ADD COLUMN IF NOT EXISTS result_summary jsonb;

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
    organization_id, run_id, tool_name, ok, error, latency_ms, activity_log_id,
    arguments, result_summary
  )
  SELECT
    p_organization_id,
    p_run_id,
    call->>'tool_name',
    COALESCE((call->>'ok')::boolean, false),
    NULLIF(call->>'error', ''),
    NULLIF(call->>'latency_ms', '')::integer,
    NULLIF(call->>'activity_log_id', '')::uuid,
    call->'arguments',
    call->'result_summary'
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
