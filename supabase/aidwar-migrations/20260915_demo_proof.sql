-- Landing-page proof + lead follow-up readiness.
--
-- demo_proof_runs stores the sanitized, allowlisted record of AI answers
-- captured from an ISOLATED internal fixture organization that holds only
-- fictional business data. Platform-owned: RLS on, no policies, service role
-- only. The public /demo page reads a fixed allowlist of columns through a
-- server function using the service client — never the table directly.
begin;

-- follow-up readiness on the existing pipeline (additive, backward compatible)
alter table public.demo_leads
  add column if not exists next_follow_up_at timestamptz,
  add column if not exists demo_attended_at timestamptz;

create index if not exists demo_leads_followup_idx
  on public.demo_leads(next_follow_up_at)
  where next_follow_up_at is not null;

create table if not exists public.demo_proof_runs (
  id uuid primary key default gen_random_uuid(),

  -- which captured case this is; one published row per scenario
  scenario text not null check (scenario in ('grounded', 'handoff')),

  -- what actually happened (captured from a real run, never written by hand)
  question text not null,
  answer text not null default '',
  status text not null,
  escalation_signal text,
  workflow_state text not null default '',

  -- provenance
  run_id uuid,
  provider text,
  model text,
  model_display text,
  tier text,
  latency_ms integer,
  source_facts jsonb not null default '[]'::jsonb,
  fixture_note text not null default '',
  captured_at timestamptz not null default now(),

  -- only an explicitly published row may reach the public page
  is_published boolean not null default false,

  created_at timestamptz not null default now()
);

create index if not exists demo_proof_runs_published_idx
  on public.demo_proof_runs(scenario, captured_at desc)
  where is_published;

grant all on public.demo_proof_runs to service_role;
alter table public.demo_proof_runs enable row level security;

commit;
