-- Batch 8 — Flows v2 Responses tab. NOT applied yet; idempotent, safe to re-run.
-- The tab reads one flow's runs newest first, 50 at a time (plus counts for the
-- summary). Without this index those reads scan every run of the workspace.
-- The tab works without it; this only keeps it fast as runs grow.
CREATE INDEX IF NOT EXISTS flow_runs_flow_started
  ON public.flow_runs (flow_id, started_at DESC);
