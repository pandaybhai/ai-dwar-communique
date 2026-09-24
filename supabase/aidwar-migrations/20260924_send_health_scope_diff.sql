-- Connection safety:
-- 1. whatsapp_accounts.health / last_health_error — send-health monitor
--    (+ health_changed_at to count recoveries, health_notified_at for once-per-incident alerts)
-- 2. whatsapp_credentials.removed_scopes — scopes the last reconnect dropped (service-role only table)

ALTER TABLE public.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS health text NOT NULL DEFAULT 'ok',
  ADD COLUMN IF NOT EXISTS last_health_error text,
  ADD COLUMN IF NOT EXISTS health_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS health_notified_at timestamptz;

DO $$ BEGIN
  ALTER TABLE public.whatsapp_accounts
    ADD CONSTRAINT whatsapp_accounts_health_check CHECK (health IN ('ok', 'needs_attention'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.whatsapp_credentials
  ADD COLUMN IF NOT EXISTS removed_scopes text[];

-- Meta auth/permission failure: codes 10, 100, 190, 200, 131031 or any OAuthException.
CREATE OR REPLACE FUNCTION public.is_auth_send_error(detail text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT detail IS NOT NULL AND (
    detail ~ '"code"\s*:\s*"?(10|100|190|200|131031)"?\s*[,}]'
    OR detail ILIKE '%OAuthException%'
  )
$$;

CREATE INDEX IF NOT EXISTS messages_outbound_failed_recent_idx
  ON public.messages (conversation_id, status_updated_at)
  WHERE direction = 'outbound' AND status = 'failed';

-- Runs on every outbound status change, so every sender is covered without
-- touching any sender.
CREATE OR REPLACE FUNCTION public.track_send_health()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  acct uuid;
  acct_health text;
  changed_at timestamptz;
  n int;
BEGIN
  IF NEW.direction IS DISTINCT FROM 'outbound' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  SELECT whatsapp_account_id INTO acct FROM conversations WHERE id = NEW.conversation_id;
  IF acct IS NULL THEN RETURN NEW; END IF;

  IF NEW.status = 'failed' THEN
    IF NOT public.is_auth_send_error(NEW.error_detail) THEN RETURN NEW; END IF;
    SELECT count(*) INTO n
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.whatsapp_account_id = acct
       AND m.direction = 'outbound' AND m.status = 'failed'
       AND coalesce(m.status_updated_at, m.created_at) > now() - interval '10 minutes'
       AND public.is_auth_send_error(m.error_detail);
    IF n >= 3 THEN
      UPDATE whatsapp_accounts
         SET last_health_error = left(NEW.error_detail, 500),
             health_changed_at = CASE WHEN health = 'needs_attention' THEN health_changed_at ELSE now() END,
             health_notified_at = CASE WHEN health = 'needs_attention' THEN health_notified_at ELSE NULL END,
             health = 'needs_attention'
       WHERE id = acct;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IN ('sent', 'delivered', 'read')
     AND (TG_OP = 'INSERT' OR OLD.status IS NULL OR OLD.status NOT IN ('sent', 'delivered', 'read')) THEN
    SELECT health, health_changed_at INTO acct_health, changed_at FROM whatsapp_accounts WHERE id = acct;
    IF acct_health = 'needs_attention' THEN
      SELECT count(*) INTO n
        FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.whatsapp_account_id = acct
         AND m.direction = 'outbound' AND m.status IN ('sent', 'delivered', 'read')
         AND coalesce(m.status_updated_at, m.created_at) >= coalesce(changed_at, now() - interval '10 minutes');
      IF n >= 3 THEN
        UPDATE whatsapp_accounts
           SET health = 'ok', last_health_error = NULL, health_changed_at = now()
         WHERE id = acct;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.track_send_health() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_track_send_health ON public.messages;
CREATE TRIGGER messages_track_send_health
  AFTER INSERT OR UPDATE OF status ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.track_send_health();
