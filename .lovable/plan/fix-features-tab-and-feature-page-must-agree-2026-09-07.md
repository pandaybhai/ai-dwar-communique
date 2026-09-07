# Fix: Features tab and feature page must agree

## What I found

- Both surfaces already render one shared component (`OrgFeatureControls`): the per-workspace feature list and the Features tab of the billing sheet. So the "Following the plan" wording no longer exists anywhere in the current code — the site you are looking at is running the older published build (the last publish never started).
- In the live database, Manish Company has no plan and no feature switched off: Shared Inbox, Templates, Automations, Analytics, Compliance, Settings, Team, AI employee, Shopify and Flows all resolve to ON.
- Two real defects remain in the current code:
  1. The shared component matches a plan's feature list against the feature's own name, while plans store the flag name. For AI employee the two differ (`ai` vs `ai_features`), so any workspace **with** a plan shows AI employee as "From plan — off" even though the plan includes it.
  2. The database resolver used by the app at runtime ignores the plan entirely (override, then global default). So a plan-driven feature can read ON in the admin screen and OFF inside the workspace.
- There is no dependency impact dialog on either surface today; the dependency data exists but is only used server-side.

## What I will do

1. Make the plan lookup use the flag name, so plan-assigned workspaces show the correct "From plan — on/off".
2. Make the database resolver plan-aware — override, then the assigned plan's list, then global default — so the admin screens and the workspace agree. Existing behaviour for workspaces without a plan is unchanged.
3. Add the dependency impact dialog to the shared component: switching a feature off warns which dependent features stop working (Automations needs Shared Inbox, Campaigns needs Templates and Contacts, Flows needs Templates and Contacts, Shopify flows need Shopify and Campaigns, and so on), with confirm/cancel. Because it lives in the shared component it applies to both places automatically.
4. Keep labels exactly: "Global default — on/off", "From plan — on/off" (only when a plan is assigned), "Set by hand — on/off", plus the existing Reset link.
5. Publish, then verify on Manish Company that both screens list the ten features as ON with the "Global default — on" label.

## Technical notes

- `src/components/admin/org-feature-controls.tsx`: compare `planFeatures.includes(feature.flag_key)`; add a confirm dialog driven by `FEATURES[].depends_on` before turning a feature off.
- New migration replacing `public.org_flag_enabled(uuid, text)` with override → `plan_versions.features` (via `organizations.plan_version_id`) → `feature_flags.default_enabled`, keeping `SECURITY DEFINER`, `STABLE` and `search_path`.
- No change to `organization_feature_overrides` writes; both surfaces already upsert the same row.
