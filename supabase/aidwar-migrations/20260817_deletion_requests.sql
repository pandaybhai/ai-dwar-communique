-- Self-serve workspace deletion requests (DPDP / Meta data deletion compliance).
CREATE TABLE IF NOT EXISTS public.deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requester_email text,
  reason text,
  status text NOT NULL DEFAULT 'pending',
  acknowledged_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS deletion_requests_open_per_org
  ON public.deletion_requests (organization_id)
  WHERE status IN ('pending', 'acknowledged');

GRANT SELECT, INSERT ON public.deletion_requests TO authenticated;
GRANT ALL ON public.deletion_requests TO service_role;

ALTER TABLE public.deletion_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org owners read deletion requests" ON public.deletion_requests;
CREATE POLICY "org owners read deletion requests"
ON public.deletion_requests FOR SELECT TO authenticated
USING (public.has_org_role(organization_id, 'owner') OR public.is_super_admin());

DROP POLICY IF EXISTS "org owners create deletion requests" ON public.deletion_requests;
CREATE POLICY "org owners create deletion requests"
ON public.deletion_requests FOR INSERT TO authenticated
WITH CHECK (
  public.has_org_role(organization_id, 'owner')
  AND requested_by = auth.uid()
  AND status = 'pending'
);
