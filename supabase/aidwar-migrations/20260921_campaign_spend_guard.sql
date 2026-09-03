begin;
alter table public.campaigns drop constraint if exists campaigns_status_check;
alter table public.campaigns add constraint campaigns_status_check check (status = any (array['draft','scheduled','awaiting_approval','sending','paused','completed','cancelled','failed']));
alter table public.campaigns
  add column if not exists estimated_cost numeric(12,2),
  add column if not exists held_amount numeric(12,2) not null default 0,
  add column if not exists charged_amount numeric(12,2) not null default 0,
  add column if not exists returned_amount numeric(12,2) not null default 0,
  add column if not exists approved_by uuid,
  add column if not exists approved_at timestamptz;
commit;
