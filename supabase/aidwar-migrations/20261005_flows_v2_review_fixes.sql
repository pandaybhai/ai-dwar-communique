-- Flows v2 review fixes.
-- 1) Editing flows needs flows_v2.edit (not ai.configure).
DROP POLICY IF EXISTS "Configurers insert flow versions" ON public.flow_versions;
DROP POLICY IF EXISTS "Configurers update flow versions" ON public.flow_versions;
DROP POLICY IF EXISTS "Configurers delete draft versions" ON public.flow_versions;
CREATE POLICY "Configurers insert flow versions" ON public.flow_versions
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'flows_v2.edit'));
CREATE POLICY "Configurers update flow versions" ON public.flow_versions
  FOR UPDATE TO authenticated USING (public.has_permission(organization_id, 'flows_v2.edit'))
  WITH CHECK (public.has_permission(organization_id, 'flows_v2.edit'));
CREATE POLICY "Configurers delete draft versions" ON public.flow_versions
  FOR DELETE TO authenticated USING (public.has_permission(organization_id, 'flows_v2.edit') AND status = 'draft');

DROP POLICY IF EXISTS "Configurers insert flow triggers" ON public.flow_triggers;
DROP POLICY IF EXISTS "Configurers update flow triggers" ON public.flow_triggers;
DROP POLICY IF EXISTS "Configurers delete flow triggers" ON public.flow_triggers;
CREATE POLICY "Configurers insert flow triggers" ON public.flow_triggers
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'flows_v2.edit'));
CREATE POLICY "Configurers update flow triggers" ON public.flow_triggers
  FOR UPDATE TO authenticated USING (public.has_permission(organization_id, 'flows_v2.edit'))
  WITH CHECK (public.has_permission(organization_id, 'flows_v2.edit'));
CREATE POLICY "Configurers delete flow triggers" ON public.flow_triggers
  FOR DELETE TO authenticated USING (public.has_permission(organization_id, 'flows_v2.edit'));

-- 2) set_field merges one key in the database (service role only).
CREATE OR REPLACE FUNCTION public.flow_merge_contact_attribute(
  p_contact_id uuid, p_organization_id uuid, p_key text, p_value text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.contacts
     SET attributes = COALESCE(attributes, '{}'::jsonb) || jsonb_build_object(p_key, p_value),
         updated_at = now()
   WHERE id = p_contact_id AND organization_id = p_organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'contact_not_found'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.flow_merge_contact_attribute(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flow_merge_contact_attribute(uuid, uuid, text, text) TO service_role;

-- 3) Ai Dwar keeps flows_v2 through plan resyncs (hand-set flag), by id.
UPDATE public.organization_billing_settings
   SET limits_override = jsonb_set(
         COALESCE(limits_override, '{}'::jsonb), '{_manual_flags}',
         COALESCE(limits_override->'_manual_flags', '{}'::jsonb) || '{"flows_v2": true}'::jsonb, true)
 WHERE organization_id = '75aed2f5-4a6c-43be-bff0-bbfee37f3faf';
