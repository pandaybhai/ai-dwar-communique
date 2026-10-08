-- Applied to aidwar-mumbai via psql: reading abuse limits.
alter table public.platform_settings
  add column if not exists link_reread_days integer not null default 7 check (link_reread_days >= 0),
  add column if not exists trial_links_per_day integer not null default 3 check (trial_links_per_day >= 0),
  add column if not exists trial_links_total integer not null default 10 check (trial_links_total >= 0);
