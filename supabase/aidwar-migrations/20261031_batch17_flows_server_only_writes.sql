-- Batch 17 (2): Flows v2 versions and triggers are written only by the server.
-- Idempotent. Apply by hand to the Mumbai project (hcsacmqzspnfqoftoifu); do not auto-apply.
-- Nothing here changes data.
--
-- Found (7 Oct health check, re-verified): authenticated members with
-- flows_v2.edit could INSERT/UPDATE flow_versions and flow_triggers straight
-- from the browser (20261001_flows_v2_engine.sql, 20261004_flows_v2_triggers.sql,
-- policies re-created in 20261005_flows_v2_review_fixes.sql), skipping every
-- publish check (validateGraph, approved templates, header sealing) and
-- publishFlowVersion. The RLS check is on the row's organization_id only, so a
-- row could even name another workspace's flow_id.
--
-- Who writes them: only /api/flows/v2 and /api/flows/triggers and the flow
-- engine, all with the service-role client. The browser only reads them
-- (chat-flows-list, flows.v2.$id, flow-run-history, flow-run-banner), so
-- members keep SELECT and lose every write; DELETE goes too since no browser
-- code deletes either (draft discard and trigger removal go through the API).

SET lock_timeout = '5s';

-- Live also carries Supabase's default ALL (incl. TRUNCATE, which ignores
-- RLS) for anon and authenticated on both tables; anon has no policy anyway.
REVOKE ALL ON public.flow_versions FROM anon;
REVOKE ALL ON public.flow_triggers FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.flow_versions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.flow_triggers FROM authenticated;

GRANT SELECT ON public.flow_versions TO authenticated;
GRANT SELECT ON public.flow_triggers TO authenticated;
GRANT ALL ON public.flow_versions TO service_role;
GRANT ALL ON public.flow_triggers TO service_role;

RESET lock_timeout;
