-- WhatsApp Forms (static Meta Flows). Phase A.
-- Tenant tables with organization_id NOT NULL, RLS via helper functions only.

create table if not exists public.wa_forms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  whatsapp_account_id uuid references public.whatsapp_accounts(id) on delete set null,
  parent_id uuid references public.wa_forms(id) on delete set null,
  version int not null default 1,
  name text not null,
  purpose text,
  cta text not null default 'Open form',
  intro text,
  fields jsonb not null default '[]'::jsonb,
  flow_json jsonb,
  meta_flow_id text,
  status text not null default 'draft'
    check (status in ('draft', 'published', 'deprecated', 'error')),
  last_error text,
  published_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wa_forms_org_idx on public.wa_forms (organization_id, created_at desc);

create table if not exists public.wa_form_responses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  form_id uuid references public.wa_forms(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  meta_message_id text unique,
  flow_token text,
  answers jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);
create index if not exists wa_form_responses_org_idx on public.wa_form_responses (organization_id, received_at desc);
create index if not exists wa_form_responses_contact_idx on public.wa_form_responses (contact_id);

grant select, insert, update, delete on public.wa_forms to authenticated;
grant select on public.wa_form_responses to authenticated;
grant all on public.wa_forms to service_role;
grant all on public.wa_form_responses to service_role;

alter table public.wa_forms enable row level security;
alter table public.wa_form_responses enable row level security;

drop policy if exists "wa_forms_select" on public.wa_forms;
create policy "wa_forms_select" on public.wa_forms for select to authenticated
  using (public.is_org_member(organization_id) or public.is_super_admin());
drop policy if exists "wa_forms_write" on public.wa_forms;
create policy "wa_forms_write" on public.wa_forms for all to authenticated
  using (public.has_permission(organization_id, 'ai.configure'))
  with check (public.has_permission(organization_id, 'ai.configure'));

-- Responses are written by the webhook (service role) only.
drop policy if exists "wa_form_responses_select" on public.wa_form_responses;
create policy "wa_form_responses_select" on public.wa_form_responses for select to authenticated
  using (public.is_org_member(organization_id) or public.is_super_admin());

drop trigger if exists update_wa_forms_updated_at on public.wa_forms;
create trigger update_wa_forms_updated_at before update on public.wa_forms
  for each row execute function public.update_updated_at_column();

-- Flag: off for everyone, on for the Ai Dwar workspace only (testing).
insert into public.feature_flags (key, name, description, default_enabled)
values ('wa_forms', 'WhatsApp Forms', 'Tap-to-fill forms inside WhatsApp: build, publish, send and receive answers.', false)
on conflict (key) do update set name = excluded.name, description = excluded.description;

insert into public.organization_feature_overrides (organization_id, flag_key, enabled)
select id, 'wa_forms', true from public.organizations where name = 'Ai Dwar'
on conflict (organization_id, flag_key) do update set enabled = true;

-- "After a form is filled in" flow, seeded only where forms are switched on.
insert into public.flows (organization_id, key, name, is_enabled, config)
select id, 'form_followup', 'After a form is filled in', false, '{"message_class":"transactional"}'::jsonb
from public.organizations where name = 'Ai Dwar'
on conflict (organization_id, key) do nothing;

insert into public.flow_steps (flow_id, step_order, delay_minutes, condition)
select f.id, 1, 0, '{"event":"form_submitted"}'::jsonb
from public.flows f where f.key = 'form_followup'
on conflict (flow_id, step_order) do nothing;
