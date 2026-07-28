-- Immutable quota snapshot for the owner-verified Codex relay profile.
-- Prices use the OpenAI standard short-context rates published on 2026-07-29;
-- the lower 200k/40k bounds are Delivery Loop per-call safety limits.
INSERT INTO quota_model_profiles (
  profile_id,
  provider,
  model,
  max_input_tokens,
  max_output_tokens,
  input_microusd_per_million,
  cached_input_microusd_per_million,
  output_microusd_per_million,
  enabled,
  created_at,
  updated_at
) VALUES (
  'codex-gpt-5p6-sol-high-20260729',
  'delivery_loop_relay',
  'gpt-5.6-sol',
  200000,
  40000,
  5000000,
  500000,
  30000000,
  1,
  '2026-07-29T00:00:00.000Z',
  '2026-07-29T00:00:00.000Z'
);
