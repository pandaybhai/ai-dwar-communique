-- Test-only rows for batch38-sql.test.ts, written before 20261160 is applied
-- (so they model conversations that already exist on live). Never applied anywhere else.
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000a1', 'A'), ('00000000-0000-0000-0000-0000000000b2', 'B');
insert into public.conversations (id, organization_id, status, last_message_at, created_at) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'open', '2026-10-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1', 'closed', '2026-10-02T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000a1', 'open', null, '2026-09-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-0000000000b2', 'open', '2026-10-01T00:00:00Z', '2026-09-01T00:00:00Z');
