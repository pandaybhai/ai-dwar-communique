-- Customer cards: branded picture cards in campaigns, flows and AI answers.
-- Off by default; Super Admin enables per workspace or globally.
insert into public.feature_flags (key, name, description, default_enabled)
values (
  'cards',
  'Customer cards',
  'Branded picture cards attached to campaign, flow and AI messages.',
  false
)
on conflict (key) do nothing;
