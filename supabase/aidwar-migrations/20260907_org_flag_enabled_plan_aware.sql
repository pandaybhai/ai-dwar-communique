CREATE OR REPLACE FUNCTION public.org_flag_enabled(p_org uuid, p_flag text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select coalesce(
    (select o.enabled from public.organization_feature_overrides o
      where o.organization_id = p_org and o.flag_key = p_flag),
    (select (p_flag = any(pv.features))
       from public.organizations org
       join public.plan_versions pv on pv.id = org.plan_version_id
      where org.id = p_org),
    (select f.default_enabled from public.feature_flags f where f.key = p_flag),
    false);
$function$;
