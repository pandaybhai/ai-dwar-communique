-- Test-only plan rows for batch34-sql.test.ts (never applied anywhere else):
-- two versions of Scale (one already listing templates), one Enterprise, one Growth.
insert into public.plans (id, key, name) values
  ('00000000-0000-0000-0000-00000000f001', 'scale', 'Scale'),
  ('00000000-0000-0000-0000-00000000f002', 'enterprise', 'Enterprise'),
  ('00000000-0000-0000-0000-00000000f003', 'growth', 'Growth');
insert into public.plan_versions (id, plan_id, features) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000f003', array['inbox']),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-00000000f001', array['inbox', 'templates']),
  ('00000000-0000-0000-0000-00000000e003', '00000000-0000-0000-0000-00000000f001', array['inbox']),
  ('00000000-0000-0000-0000-00000000e004', '00000000-0000-0000-0000-00000000f002', array['inbox']);
