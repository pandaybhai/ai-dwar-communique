-- Batch 17 (6): one Aiden switch — REPORT ONLY, changes nothing.
-- Idempotent (read-only). Run by hand on the Mumbai project (hcsacmqzspnfqoftoifu).
--
-- ai_agents.mode (default agent) now decides whether Aiden replies, and every
-- save keeps organization_ai_settings.ai_enabled equal to it (on unless mode
-- is off): set_mode, the owner's "turn Aiden on" on WhatsApp, and switching
-- AI off (which also sets mode off). This lists every workspace where the two
-- still disagree, so they can be settled by hand; nothing is updated.
--
-- Live on 7 Oct: 'Ai Dwar' and 'Kaira Home Candles' had ai_enabled = true,
-- mode = 'off' (Aiden silent — mode decides). None had ai_enabled = false
-- with Aiden on (that one would be silent today and logged as
-- ai_switch_mismatch by the app).

SET lock_timeout = '5s';

DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT o.id, o.name, s.ai_enabled, COALESCE(a.mode, 'off') AS mode
    FROM public.organizations o
    LEFT JOIN public.organization_ai_settings s ON s.organization_id = o.id
    LEFT JOIN public.ai_agents a ON a.organization_id = o.id AND a.is_default
    WHERE COALESCE(s.ai_enabled, false) IS DISTINCT FROM (COALESCE(a.mode, 'off') <> 'off')
    ORDER BY o.name
  LOOP
    n := n + 1;
    RAISE NOTICE 'ai switch mismatch: % (%) ai_enabled=% mode=% — %', r.name, r.id, r.ai_enabled, r.mode,
      CASE WHEN r.mode = 'off' THEN 'Aiden is off (mode decides); ai_enabled follows on the next save'
           ELSE 'Aiden is on but AI is off: silent until a save' END;
  END LOOP;
  RAISE NOTICE 'ai switch mismatches: %', n;
END $$;

RESET lock_timeout;
