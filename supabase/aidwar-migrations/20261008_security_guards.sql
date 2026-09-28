-- Security guards. RECORD ONLY: every statement here is already applied on
-- the live database; this file keeps the repo in step with it. Idempotent and
-- a no-op on live (same function bodies, triggers created only if missing).
--
-- (1) protect_profile_privileges runs as the caller (SECURITY INVOKER), so
--     current_user is the real role. The server roles and super admins are
--     exempt; anyone else keeps OLD is_super_admin / id / created_at.
-- (2) match_knowledge_chunks and default_whatsapp_account (SECURITY DEFINER)
--     only answer for a workspace the caller belongs to. auth.uid() IS NULL is
--     the server (service role), which keeps working unchanged.
-- (3) organizations: plan, trial, billing and status fields can only be
--     changed by the server or a super admin (aaa_ = runs before other
--     BEFORE UPDATE triggers).
-- (4) campaigns: status, money, approval, timestamps and counters can only be
--     changed by the server or a super admin. A client INSERT always starts
--     as a draft with no money attached.

-- ------------------------------------------------------------ (1) profiles
CREATE OR REPLACE FUNCTION public.protect_profile_privileges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
begin
  -- Runs as the caller (not SECURITY DEFINER), so current_user is the real role.
  if current_user not in ('postgres', 'supabase_admin', 'service_role')
     and not public.is_super_admin() then
    new.is_super_admin := old.is_super_admin;
    new.id := old.id;
    new.created_at := old.created_at;
  end if;
  return new;
end; $function$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'protect_profile_privileges' AND tgrelid = 'public.profiles'::regclass
  ) THEN
    CREATE TRIGGER protect_profile_privileges
      BEFORE UPDATE ON public.profiles
      FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privileges();
  END IF;
END $$;

-- ------------------------------------------------- (2) member-only readers
CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
  p_org uuid,
  p_embedding vector,
  p_embedding_model text,
  p_agent uuid DEFAULT NULL::uuid,
  p_limit integer DEFAULT 6,
  p_min_similarity numeric DEFAULT 0.35
)
RETURNS TABLE(chunk_id uuid, document_id uuid, source_id uuid, source_type text, source_name text, source_ref text, title text, text text, similarity numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT c.id, c.document_id, c.source_id, s.type, s.name, c.source_ref,
         d.title, c.text,
         (1 - (c.embedding <=> p_embedding))::numeric AS similarity
  FROM public.knowledge_chunks c
  JOIN public.knowledge_sources s ON s.id = c.source_id
  JOIN public.knowledge_documents d ON d.id = c.document_id
  WHERE c.organization_id = p_org
    AND (auth.uid() IS NULL OR public.is_org_member(p_org) OR public.is_super_admin())
    AND c.embedding IS NOT NULL
    AND c.embedding_model = p_embedding_model
    AND s.status <> 'disabled'
    AND (s.agent_id IS NULL OR p_agent IS NULL OR s.agent_id = p_agent)
    AND (1 - (c.embedding <=> p_embedding)) >= p_min_similarity
  ORDER BY c.embedding <=> p_embedding
  LIMIT GREATEST(p_limit, 1);
$function$;

CREATE OR REPLACE FUNCTION public.default_whatsapp_account(p_organization_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT id FROM public.whatsapp_accounts
  WHERE organization_id = p_organization_id AND is_default
    AND (auth.uid() IS NULL OR public.is_org_member(p_organization_id) OR public.is_super_admin())
  LIMIT 1;
$function$;

-- ------------------------------------------------------- (3) organizations
CREATE OR REPLACE FUNCTION public.trg_guard_org_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
begin
  -- Runs as the caller: only the server (service role / db owner) and super
  -- admins may change plan, trial, billing and status fields. Owners keep
  -- name, branding and timezone.
  if current_user not in ('postgres', 'supabase_admin', 'service_role')
     and not public.is_super_admin() then
    new.status             := old.status;
    new.funding_model      := old.funding_model;
    new.plan_status        := old.plan_status;
    new.trial_ends_at      := old.trial_ends_at;
    new.billing_day        := old.billing_day;
    new.plan_version_id    := old.plan_version_id;
    new.billing_enabled_at := old.billing_enabled_at;
    new.billing_account_id := old.billing_account_id;
    new.partner_id         := old.partner_id;
    new.slug               := old.slug;
    new.id                 := old.id;
    new.created_at         := old.created_at;
  end if;
  return new;
end; $function$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'aaa_guard_org_privileged_columns' AND tgrelid = 'public.organizations'::regclass
  ) THEN
    CREATE TRIGGER aaa_guard_org_privileged_columns
      BEFORE UPDATE ON public.organizations
      FOR EACH ROW EXECUTE FUNCTION public.trg_guard_org_privileged_columns();
  END IF;
END $$;

-- ----------------------------------------------------------- (4) campaigns
CREATE OR REPLACE FUNCTION public.trg_guard_campaign_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
begin
  -- Only the server (which enforces approval, holds and billing) may change
  -- status, money, approval and counter fields. Direct client writes keep
  -- the old values.
  if current_user not in ('postgres', 'supabase_admin', 'service_role')
     and not public.is_super_admin() then
    if tg_op = 'UPDATE' then
      new.status := old.status;
      new.estimated_cost := old.estimated_cost;
      new.held_amount := old.held_amount;
      new.charged_amount := old.charged_amount;
      new.returned_amount := old.returned_amount;
      new.approved_by := old.approved_by;
      new.approved_at := old.approved_at;
      new.started_at := old.started_at;
      new.completed_at := old.completed_at;
      new.total_recipients := old.total_recipients;
      new.sent_count := old.sent_count;
      new.delivered_count := old.delivered_count;
      new.read_count := old.read_count;
      new.failed_count := old.failed_count;
      new.replied_count := old.replied_count;
      new.organization_id := old.organization_id;
    else
      new.status := 'draft';
      new.estimated_cost := null;
      new.held_amount := 0;
      new.charged_amount := 0;
      new.returned_amount := 0;
      new.approved_by := null;
      new.approved_at := null;
      new.started_at := null;
      new.completed_at := null;
    end if;
  end if;
  return new;
end; $function$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'aaa_guard_campaign_privileged_columns' AND tgrelid = 'public.campaigns'::regclass
  ) THEN
    CREATE TRIGGER aaa_guard_campaign_privileged_columns
      BEFORE INSERT OR UPDATE ON public.campaigns
      FOR EACH ROW EXECUTE FUNCTION public.trg_guard_campaign_privileged_columns();
  END IF;
END $$;
