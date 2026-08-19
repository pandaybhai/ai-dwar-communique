-- The AI employee had no tools in real customer conversations.
--
-- Autonomous runs passed no user, so permission resolution produced an empty
-- set, ai.use was never held, and the broker handed the model zero tools.
-- Give the agent its own principal: an organisation-level role it acts as.

-- 1. The role the agent acts as, per workspace.
ALTER TABLE public.organization_ai_settings
  ADD COLUMN IF NOT EXISTS agent_role text NOT NULL DEFAULT 'ai_agent';

-- 2. Write tools are opt-in per workspace. Default: read only.
ALTER TABLE public.organization_ai_settings
  ADD COLUMN IF NOT EXISTS agent_can_write boolean NOT NULL DEFAULT false;

-- 3. 'ai_agent' becomes a valid role for permission presets only. It is NOT
--    added to organization_members: no human can ever hold it.
ALTER TABLE public.role_permissions
  DROP CONSTRAINT IF EXISTS role_permissions_role_check;
ALTER TABLE public.role_permissions
  ADD CONSTRAINT role_permissions_role_check
  CHECK (role = ANY (ARRAY['owner','admin','marketer','agent','ai_agent']));

-- 4. Least privilege: the read-only permissions the agent's tools need.
INSERT INTO public.role_permissions (role, permission_key)
SELECT 'ai_agent', k
FROM (VALUES
  ('ai.use'),
  ('catalog.view'),
  ('contacts.view'),
  ('inbox.view'),
  ('integrations.view')
) AS t(k)
WHERE EXISTS (SELECT 1 FROM public.permissions p WHERE p.key = t.k)
ON CONFLICT DO NOTHING;
