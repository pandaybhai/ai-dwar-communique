-- Batch 29: reply speed. Idempotent. NOT applied: apply by hand to the Mumbai
-- project (hcsacmqzspnfqoftoifu). The code works before it is applied (the
-- defaults below are in code too; /admin/ai says the card needs this file).
--
-- (1) The adaptive burst wait (whatsapp-webhook.server.ts, burstSettings /
--     coalesceBurst): Aiden answers once the customer has been quiet for
--     ai_burst_quiet_ms since their latest text, and never later than
--     ai_burst_cap_ms after the first text of the burst. Edited on Super
--     Admin → AI. Until applied: 1500 / 3000 from code. The old fixed window
--     (ai_burst_wait_ms, 20261020) is no longer read and is left in place.
--
-- (2) public.reply_speed_stats(p_now, p_slow_ms, p_slow_limit): the /admin/ai
--     "Reply speed" card in one aggregate over public.ai_runs (Aiden's
--     customer replies, task 'agent_reply', that carry
--     metadata.reply_speed.received_to_send_ms — written by runAgentOnInbound
--     once WhatsApp accepted the first message): per workspace, p50 / p90 /
--     slowest for the last 24 hours and the last 7 days, and the replies over
--     p_slow_ms (default 30 s) with their reason (metadata.reply_speed.reason:
--     the safety-net pickup, else the stage that took longest). Service role
--     only: anon and authenticated never get EXECUTE. STABLE: one snapshot.

SET lock_timeout = '5s';

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS ai_burst_quiet_ms integer NOT NULL DEFAULT 1500;
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS ai_burst_cap_ms integer NOT NULL DEFAULT 3000;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_settings_ai_burst_quiet_ms_check'
      AND conrelid = 'public.platform_settings'::regclass
  ) THEN
    ALTER TABLE public.platform_settings
      ADD CONSTRAINT platform_settings_ai_burst_quiet_ms_check
      CHECK (ai_burst_quiet_ms BETWEEN 0 AND 10000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_settings_ai_burst_cap_ms_check'
      AND conrelid = 'public.platform_settings'::regclass
  ) THEN
    ALTER TABLE public.platform_settings
      ADD CONSTRAINT platform_settings_ai_burst_cap_ms_check
      CHECK (ai_burst_cap_ms BETWEEN 0 AND 10000);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.reply_speed_stats(
  p_now timestamptz DEFAULT now(),
  p_slow_ms integer DEFAULT 30000,
  p_slow_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH r AS (
    SELECT ar.id,
           ar.organization_id,
           ar.conversation_id,
           ar.created_at,
           (ar.metadata -> 'reply_speed' ->> 'received_to_send_ms')::numeric AS ms,
           ar.metadata -> 'reply_speed' ->> 'reason' AS reason,
           ar.metadata -> 'reply_speed' ->> 'pickup' AS pickup,
           ar.metadata -> 'reply_speed' -> 'parts' AS parts
      FROM public.ai_runs ar
     WHERE ar.task = 'agent_reply'
       AND ar.created_at >= p_now - interval '7 days'
       AND ar.created_at < p_now
       AND jsonb_typeof(ar.metadata -> 'reply_speed' -> 'received_to_send_ms') = 'number'
  ),
  windows AS (
    SELECT 'last_24h'::text AS win, r.* FROM r WHERE r.created_at >= p_now - interval '24 hours'
    UNION ALL
    SELECT 'last_7d'::text AS win, r.* FROM r
  ),
  agg AS (
    SELECT w.organization_id,
           w.win,
           jsonb_build_object(
             'replies', count(*),
             'p50_ms', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY w.ms)),
             'p90_ms', round(percentile_cont(0.9) WITHIN GROUP (ORDER BY w.ms)),
             'slowest_ms', max(w.ms),
             'over_slow', count(*) FILTER (WHERE w.ms > p_slow_ms)
           ) AS stats
      FROM windows w
     GROUP BY w.organization_id, w.win
  ),
  per_org AS (
    SELECT a.organization_id,
           jsonb_object_agg(a.win, a.stats) AS stats
      FROM agg a
     GROUP BY a.organization_id
  ),
  slow AS (
    SELECT r.*
      FROM r
     WHERE r.ms > p_slow_ms
     ORDER BY r.created_at DESC
     LIMIT GREATEST(p_slow_limit, 0)
  )
  SELECT jsonb_build_object(
    'from', p_now - interval '7 days',
    'to', p_now,
    'slow_ms', p_slow_ms,
    'workspaces', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'organization_id', p.organization_id,
                 'name', o.name,
                 'last_24h', COALESCE(p.stats -> 'last_24h', jsonb_build_object('replies', 0)),
                 'last_7d', p.stats -> 'last_7d'
               )
               ORDER BY (p.stats -> 'last_7d' ->> 'replies')::int DESC, o.name
             )
        FROM per_org p
        LEFT JOIN public.organizations o ON o.id = p.organization_id
    ), '[]'::jsonb),
    'slow', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'run_id', s.id,
                 'organization_id', s.organization_id,
                 'name', o.name,
                 'conversation_id', s.conversation_id,
                 'at', s.created_at,
                 'ms', s.ms,
                 'reason', s.reason,
                 'pickup', s.pickup,
                 'parts', s.parts
               )
               ORDER BY s.created_at DESC
             )
        FROM slow s
        LEFT JOIN public.organizations o ON o.id = s.organization_id
    ), '[]'::jsonb)
  )
$$;

REVOKE ALL ON FUNCTION public.reply_speed_stats(timestamptz, integer, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reply_speed_stats(timestamptz, integer, integer) TO service_role;

RESET lock_timeout;

-- Read-only checks once applied:
--   select column_name, column_default from information_schema.columns
--    where table_schema = 'public' and table_name = 'platform_settings'
--      and column_name in ('ai_burst_quiet_ms', 'ai_burst_cap_ms');
--   -- ai_burst_cap_ms | 3000, ai_burst_quiet_ms | 1500
--   select has_function_privilege('anon', 'public.reply_speed_stats(timestamptz, integer, integer)', 'execute'),
--          has_function_privilege('authenticated', 'public.reply_speed_stats(timestamptz, integer, integer)', 'execute');
--   -- false | false
--   select jsonb_pretty(public.reply_speed_stats());
--   -- per workspace p50/p90/slowest (24 h, 7 d) once replies carry reply_speed
--   -- (after this branch is deployed); slow = replies over 30 s with their reason.
