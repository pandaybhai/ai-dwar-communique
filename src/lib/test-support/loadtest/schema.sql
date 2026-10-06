-- Load-test database (Batch 12). A subset of the production schema with the
-- same indexes, triggers and functions on every table the campaign worker
-- and the status webhook touch. Function bodies are copied from production
-- (billing chain, send health, counters, claims); only lookups the test
-- doesn't exercise are stubbed (rate cards, feature flags, super admins).
-- Never applied anywhere but the throwaway local database.

create extension if not exists pg_stat_statements;
create extension if not exists pgcrypto;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'loadtest';
  end if;
end $$;
grant anon, authenticated, service_role to authenticator;

create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create or replace function public.update_updated_at_column() returns trigger language plpgsql set search_path to 'public' as $$
begin new.updated_at = now(); return new; end; $$;
create or replace function public.is_super_admin() returns boolean language sql stable as $$ select false $$;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  branding jsonb not null default '{}'::jsonb,
  plan_status text default 'active',
  funding_model text,
  billing_enabled_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.whatsapp_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  waba_id text,
  phone_number_id text unique,
  display_phone_number text,
  status text default 'active',
  is_default boolean default true,
  connected_at timestamptz default now(),
  health text default 'ok',
  health_changed_at timestamptz,
  health_notified_at timestamptz,
  last_health_error text,
  quality_rating text
);

create table public.whatsapp_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  waba_id text not null,
  access_token text not null,
  unique (organization_id, waba_id)
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  phone text not null,
  wa_id text,
  name text,
  opt_in_status text default 'opted_in',
  attributes jsonb default '{}'::jsonb,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, phone)
);
create index contacts_org_idx on public.contacts (organization_id);
create index contacts_org_optin_idx on public.contacts (organization_id, opt_in_status);
create index contacts_org_wa_idx on public.contacts (organization_id, wa_id);
create trigger contacts_updated_at before update on public.contacts for each row execute function public.update_updated_at_column();

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  whatsapp_account_id uuid references public.whatsapp_accounts(id),
  status text not null default 'open',
  last_message_at timestamptz,
  needs_human boolean default false,
  needs_human_at timestamptz,
  created_at timestamptz not null default now()
);
create index conversations_contact_idx on public.conversations (contact_id);
create unique index conversations_one_live_per_number_idx on public.conversations (organization_id, contact_id, whatsapp_account_id) where status <> 'closed';
create index conversations_org_last_msg_idx on public.conversations (organization_id, last_message_at desc);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  whatsapp_account_id uuid references public.whatsapp_accounts(id),
  name text not null,
  template_name text,
  template_language text not null default 'en_US',
  variable_mappings jsonb not null default '{}'::jsonb,
  send_settings jsonb not null default '{}'::jsonb,
  segment_id uuid,
  status text not null default 'draft',
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  total_recipients int not null default 0,
  sent_count int not null default 0,
  delivered_count int not null default 0,
  read_count int not null default 0,
  failed_count int not null default 0,
  replied_count int not null default 0,
  estimated_cost numeric(12,2),
  held_amount numeric(12,2) not null default 0,
  charged_amount numeric(12,2) not null default 0,
  returned_amount numeric(12,2) not null default 0,
  approved_by uuid,
  approved_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index campaigns_org_idx on public.campaigns (organization_id, created_at desc);
create index campaigns_status_idx on public.campaigns (status, scheduled_at);
create index campaigns_org_account_idx on public.campaigns (organization_id, whatsapp_account_id);
create trigger update_campaigns_updated_at before update on public.campaigns for each row execute function public.update_updated_at_column();

-- Production's guard (only the server may change status/money/counters).
create or replace function public.trg_guard_campaign_privileged_columns() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if current_user not in ('postgres', 'supabase_admin', 'service_role')
     and not public.is_super_admin() then
    if tg_op = 'UPDATE' then
      new.status := old.status; new.sent_count := old.sent_count; new.delivered_count := old.delivered_count;
      new.read_count := old.read_count; new.failed_count := old.failed_count; new.charged_amount := old.charged_amount;
    end if;
  end if;
  return new;
end; $$;
create trigger aaa_guard_campaign_privileged_columns before insert or update on public.campaigns for each row execute function public.trg_guard_campaign_privileged_columns();

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  meta_message_id text,
  direction text not null,
  type text,
  body text,
  template_name text,
  media_url text,
  media_mime text,
  metadata jsonb,
  status text,
  status_updated_at timestamptz,
  error_detail text,
  campaign_id uuid,
  flow_id uuid,
  flow_step_id uuid,
  scheduled_send_id uuid,
  billable boolean,
  pricing_model text,
  pricing_category text,
  cost_amount numeric(12,4),
  cost_currency text,
  created_at timestamptz not null default now()
);
-- Production's indexes on messages (including the two duplicates the
-- Batch 12 migration drops).
create unique index messages_meta_message_id_key on public.messages (meta_message_id);
create index messages_meta_id_idx on public.messages (meta_message_id);
create index messages_campaign_idx on public.messages (campaign_id) where campaign_id is not null;
create index messages_cost_idx on public.messages (organization_id, created_at desc) where direction = 'outbound';
create index messages_outbound_created_idx on public.messages (organization_id, created_at desc) where direction = 'outbound';
create index messages_flow_idx on public.messages (flow_id) where flow_id is not null;
create index messages_org_conv_created_idx on public.messages (organization_id, conversation_id, created_at desc);
create index messages_org_created_idx on public.messages (organization_id, created_at desc);
create index messages_org_direction_status_idx on public.messages (organization_id, direction, status);
create index messages_outbound_failed_recent_idx on public.messages (conversation_id, status_updated_at) where direction = 'outbound' and status = 'failed';

create table public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  phone text not null,
  resolved_variables jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued','sending','sent','delivered','read','failed','skipped')),
  message_id uuid references public.messages(id) on delete set null,
  error text,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, contact_id)
);
create index campaign_recipients_campaign_idx on public.campaign_recipients (campaign_id, status);
create index campaign_recipients_message_idx on public.campaign_recipients (message_id);
create index campaign_recipients_contact_idx on public.campaign_recipients (organization_id, contact_id, created_at desc);
create index campaign_recipients_org_status_idx on public.campaign_recipients (organization_id, status);
create trigger update_campaign_recipients_updated_at before update on public.campaign_recipients for each row execute function public.update_updated_at_column();

create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  waba_id text,
  name text not null,
  language text default 'en_US',
  category text default 'MARKETING',
  status text default 'APPROVED',
  components jsonb default '[]'::jsonb,
  meta_template_id text,
  rejection_reason text,
  updated_at timestamptz default now()
);

create table public.wa_forms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  meta_flow_id text,
  version int default 1
);

create table public.short_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  token text unique not null,
  target_url text not null,
  scheduled_send_id uuid,
  campaign_id uuid,
  contact_id uuid,
  expires_at timestamptz,
  created_at timestamptz default now()
);

create table public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  whatsapp_account_id uuid,
  event_type text not null,
  entity_type text,
  entity_id uuid,
  actor_user_id uuid,
  properties jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index analytics_events_org_type_time_idx on public.analytics_events (organization_id, event_type, occurred_at desc);

create table public.usage_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  meter_key text not null,
  quantity numeric not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index usage_records_metadata_idx on public.usage_records using gin (metadata);
create index usage_records_org_meter_time_idx on public.usage_records (organization_id, meter_key, occurred_at desc);
create index usage_records_org_time_idx on public.usage_records (organization_id, occurred_at desc);

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_event_id text,
  payload jsonb,
  signature_valid boolean,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  timing jsonb
);
create index webhook_events_received_idx on public.webhook_events (received_at desc);
create index webhook_events_unprocessed_idx on public.webhook_events (processed_at) where processed_at is null;

create table public.platform_settings (id int primary key default 1, onboarding_whatsapp_account_id uuid);
insert into public.platform_settings (id) values (1);

-- ------------------------------------------------------------ billing
create table public.wallet_balances (
  organization_id uuid primary key,
  balance numeric(14,2) not null default 0,
  held numeric(14,2) not null default 0,
  currency text default 'INR',
  lifetime_purchased numeric(14,2) not null default 0,
  lifetime_consumed numeric(14,2) not null default 0,
  updated_at timestamptz default now()
);
create table public.organization_billing_settings (organization_id uuid primary key, overdraft_limit numeric default 0);
create table public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  entry_type text not null,
  amount numeric(14,2) not null,
  balance_after numeric(14,2),
  held_after numeric(14,2),
  currency text,
  reference_type text,
  reference_id uuid,
  description text,
  metadata jsonb default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index wallet_ledger_org_time on public.wallet_ledger (organization_id, created_at desc);
create index wallet_ledger_ref on public.wallet_ledger (reference_type, reference_id);

create table public.message_rates (dial_code text, country_code text, category text, rate numeric, currency text default 'INR', effective_from date default '2020-01-01', effective_to date);
insert into public.message_rates (dial_code, country_code, category, rate) values ('91', 'IN', 'marketing', 0.86), ('91', 'IN', 'utility', 0.12);

create or replace function public.org_flag_enabled(p_org uuid, p_flag text) returns boolean language sql stable as $$
  select p_flag = 'billing' and exists (select 1 from public.organizations o where o.id = p_org and o.billing_enabled_at is not null)
$$;

create or replace function public.client_rate_for(p_org uuid, p_country text, p_category text, p_at timestamptz default now())
returns table(rate numeric, currency text, meta_rate numeric, mode text) language plpgsql stable as $$
declare mr record;
begin
  select r.rate, r.currency into mr from public.message_rates r
   where r.country_code = coalesce(p_country,'IN') and r.category = p_category order by r.effective_from desc limit 1;
  return query select round(mr.rate, 2), mr.currency, mr.rate, 'passthrough'::text;
end $$;

-- Production bodies from here on.
create or replace function public.message_rate_for(p_phone text, p_category text, p_at timestamptz default now())
returns table(rate numeric, currency text, country_code text) language sql stable security definer set search_path to 'public' as $$
  SELECT r.rate, r.currency, r.country_code
  FROM public.message_rates r
  WHERE REGEXP_REPLACE(COALESCE(p_phone, ''), '\D', '', 'g') LIKE r.dial_code || '%'
    AND r.category = LOWER(COALESCE(p_category, ''))
    AND r.effective_from <= (p_at AT TIME ZONE 'UTC')::date
    AND (r.effective_to IS NULL OR r.effective_to > (p_at AT TIME ZONE 'UTC')::date)
  ORDER BY LENGTH(r.dial_code) DESC, r.effective_from DESC
  LIMIT 1;
$$;

create or replace function public.wallet_apply(p_org uuid, p_type text, p_amount numeric, p_ref_type text default null, p_ref_id uuid default null, p_description text default null, p_metadata jsonb default '{}'::jsonb, p_actor uuid default null)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare b record; new_bal numeric; new_held numeric; od numeric; entry_id uuid;
begin
  insert into public.wallet_balances(organization_id) values (p_org) on conflict do nothing;
  select * into b from public.wallet_balances where organization_id = p_org for update;
  select coalesce(overdraft_limit,0) into od from public.organization_billing_settings where organization_id = p_org;
  od := coalesce(od,0);
  new_bal := b.balance; new_held := b.held;
  case p_type
    when 'hold' then new_held := b.held + abs(p_amount);
    when 'hold_release' then new_held := greatest(0, b.held - abs(p_amount));
    when 'debit_message','debit_ai','debit_addon','expiry' then
      new_bal := b.balance - abs(p_amount);
      if p_metadata ? 'from_hold' and (p_metadata->>'from_hold')::boolean then new_held := greatest(0, b.held - abs(p_amount)); end if;
    else new_bal := b.balance + abs(p_amount);
  end case;
  if new_bal < -od then
    raise exception 'INSUFFICIENT_CREDITS: balance % would fall below overdraft limit %', new_bal, -od using errcode = 'P0001';
  end if;
  insert into public.wallet_ledger(organization_id, entry_type, amount, balance_after, held_after, currency, reference_type, reference_id, description, metadata, created_by)
  values (p_org, p_type, case when p_type in ('debit_message','debit_ai','debit_addon','expiry','hold') then -abs(p_amount) else abs(p_amount) end,
    new_bal, new_held, b.currency, p_ref_type, p_ref_id, p_description, p_metadata, p_actor)
  returning id into entry_id;
  update public.wallet_balances set balance = new_bal, held = new_held, updated_at = now(),
    lifetime_consumed = lifetime_consumed + case when p_type in ('debit_message','debit_ai','debit_addon') then abs(p_amount) else 0 end
  where organization_id = p_org;
  return entry_id;
end $$;

create or replace function public.billing_debit_message(p_message_id uuid) returns boolean language plpgsql security definer set search_path to 'public' as $$
declare m record; phone text; cc text; r record; already boolean; enabled_at timestamptz;
begin
  select id, organization_id, conversation_id, pricing_category, cost_amount, status, campaign_id, flow_id, created_at
    into m from public.messages where id = p_message_id;
  if m.id is null or coalesce(m.cost_amount,0) <= 0 then return false; end if;
  if not public.org_flag_enabled(m.organization_id, 'billing') then return false; end if;
  select billing_enabled_at into enabled_at from public.organizations where id = m.organization_id;
  if enabled_at is null or m.created_at < enabled_at then return false; end if;
  select exists(select 1 from public.wallet_ledger where reference_type='message' and reference_id=m.id and entry_type='debit_message') into already;
  if already then return false; end if;
  select c2.phone into phone from public.conversations cv join public.contacts c2 on c2.id = cv.contact_id where cv.id = m.conversation_id;
  select mr.country_code into cc from public.message_rates mr
    where regexp_replace(coalesce(phone,''),'\D','','g') like mr.dial_code || '%' order by length(mr.dial_code) desc limit 1;
  select * into r from public.client_rate_for(m.organization_id, coalesce(cc,'IN'), m.pricing_category);
  perform public.wallet_apply(m.organization_id, 'debit_message', coalesce(r.rate, m.cost_amount), 'message', m.id,
    'Message ' || m.pricing_category, jsonb_build_object('meta_cost', m.cost_amount, 'client_rate', r.rate,
      'campaign_id', m.campaign_id, 'flow_id', m.flow_id, 'from_hold', (m.campaign_id is not null)));
  return true;
end $$;

create or replace function public.trg_messages_billing() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.direction = 'outbound' and coalesce(new.cost_amount,0) > 0 and (old.cost_amount is distinct from new.cost_amount) then
    begin
      perform public.billing_debit_message(new.id);
    exception when others then
      insert into public.usage_records(organization_id, meter_key, quantity, metadata)
      values (new.organization_id, 'billing_debit_failed', 1, jsonb_build_object('message_id', new.id, 'error', sqlerrm));
    end;
  end if;
  return new;
end $$;
create trigger messages_billing_debit after update of cost_amount on public.messages for each row execute function public.trg_messages_billing();

create or replace function public.price_message(p_message_id uuid) returns boolean language plpgsql security definer set search_path to 'public' as $$
DECLARE m record; phone text; found record;
BEGIN
  SELECT id, conversation_id, billable, pricing_category, status, created_at, cost_amount INTO m FROM public.messages WHERE id = p_message_id;
  IF m.id IS NULL THEN RETURN false; END IF;
  IF COALESCE(m.billable, false) = false THEN
    UPDATE public.messages SET cost_amount = 0, cost_currency = COALESCE(cost_currency, 'INR') WHERE id = m.id AND cost_amount IS DISTINCT FROM 0;
    RETURN true;
  END IF;
  IF m.status NOT IN ('delivered','read') THEN RETURN true; END IF;
  SELECT c2.phone INTO phone FROM public.conversations cv JOIN public.contacts c2 ON c2.id = cv.contact_id WHERE cv.id = m.conversation_id;
  SELECT * INTO found FROM public.message_rate_for(phone, m.pricing_category, m.created_at);
  IF found.rate IS NULL THEN RETURN false; END IF;
  UPDATE public.messages SET cost_amount = found.rate, cost_currency = found.currency WHERE id = m.id;
  RETURN true;
END; $$;

create or replace function public.is_auth_send_error(detail text) returns boolean language sql immutable set search_path to 'public' as $$
  SELECT detail IS NOT NULL AND (detail ~ '"code"\s*:\s*"?(10|100|190|200|131031)"?\s*[,}]' OR detail ILIKE '%OAuthException%')
$$;

create or replace function public.track_send_health() returns trigger language plpgsql security definer set search_path to 'public' as $$
DECLARE acct uuid; acct_health text; changed_at timestamptz; n int;
BEGIN
  IF NEW.direction IS DISTINCT FROM 'outbound' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  SELECT whatsapp_account_id INTO acct FROM conversations WHERE id = NEW.conversation_id;
  IF acct IS NULL THEN RETURN NEW; END IF;
  IF NEW.status = 'failed' THEN
    IF NOT public.is_auth_send_error(NEW.error_detail) THEN RETURN NEW; END IF;
    SELECT count(*) INTO n FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.whatsapp_account_id = acct AND m.direction = 'outbound' AND m.status = 'failed'
       AND coalesce(m.status_updated_at, m.created_at) > now() - interval '10 minutes' AND public.is_auth_send_error(m.error_detail);
    IF n >= 3 THEN
      UPDATE whatsapp_accounts SET last_health_error = left(NEW.error_detail, 500), health = 'needs_attention' WHERE id = acct;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IN ('sent', 'delivered', 'read') AND (TG_OP = 'INSERT' OR OLD.status IS NULL OR OLD.status NOT IN ('sent', 'delivered', 'read')) THEN
    SELECT health, health_changed_at INTO acct_health, changed_at FROM whatsapp_accounts WHERE id = acct;
    IF acct_health = 'needs_attention' THEN
      SELECT count(*) INTO n FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.whatsapp_account_id = acct AND m.direction = 'outbound' AND m.status IN ('sent', 'delivered', 'read')
         AND coalesce(m.status_updated_at, m.created_at) >= coalesce(changed_at, now() - interval '10 minutes');
      IF n >= 3 THEN UPDATE whatsapp_accounts SET health = 'ok', last_health_error = NULL, health_changed_at = now() WHERE id = acct; END IF;
    END IF;
  END IF;
  RETURN NEW;
END; $$;
create trigger messages_track_send_health after insert or update of status on public.messages for each row execute function public.track_send_health();

-- ------------------------------------------------------------ campaigns (production)
create or replace function public.claim_campaign_recipients(p_campaign_id uuid, p_limit int)
returns table (id uuid, contact_id uuid, phone text, resolved_variables jsonb)
language plpgsql security definer set search_path = public as $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT r.id FROM public.campaign_recipients r
    WHERE r.campaign_id = p_campaign_id AND r.status = 'queued'
    ORDER BY r.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.campaign_recipients r SET status = 'sending', updated_at = now()
  FROM claimed WHERE r.id = claimed.id
  RETURNING r.id, r.contact_id, r.phone, r.resolved_variables;
END; $$;

create or replace function public.bump_campaign_counters(p_campaign_id uuid, p_sent int default 0, p_delivered int default 0, p_read int default 0, p_failed int default 0, p_replied int default 0)
returns void language sql security definer set search_path = public as $$
  UPDATE public.campaigns
  SET sent_count = sent_count + p_sent, delivered_count = delivered_count + p_delivered, read_count = read_count + p_read,
      failed_count = failed_count + p_failed, replied_count = replied_count + p_replied, updated_at = now()
  WHERE id = p_campaign_id;
$$;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant execute on functions to service_role;
