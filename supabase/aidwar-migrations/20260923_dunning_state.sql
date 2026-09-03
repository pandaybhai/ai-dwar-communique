-- Dunning state lives with the rest of a workspace's billing settings so the
-- ladder can be replayed, audited and undone in one place.
alter table public.organization_billing_settings
  add column if not exists dunning_stage text,
  add column if not exists dunning_last_at timestamptz,
  add column if not exists dunning_paused jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.organization_billing_settings'::regclass
      and conname = 'obs_dunning_stage_check'
  ) then
    alter table public.organization_billing_settings
      add constraint obs_dunning_stage_check
      check (dunning_stage is null or dunning_stage in
        ('due','reminder_1','reminder_2','paused','locked'));
  end if;
end $$;
