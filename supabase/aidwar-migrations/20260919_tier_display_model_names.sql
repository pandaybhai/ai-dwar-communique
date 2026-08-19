-- Merchants asked to see the real model behind each tier, not a nickname.
-- Tier keys stay the same; only the label changes.

UPDATE public.ai_tiers SET display_name = 'GPT-5.6 Terra', updated_at = now() WHERE key = 'everyday';
UPDATE public.ai_tiers SET display_name = 'GPT-5.4', updated_at = now() WHERE key = 'careful';
