-- Immutable relay profile selected after two bounded Sol/high analysis attempts
-- failed without a settled model usage record. The existing profiles remain
-- immutable so in-flight and historical reservations keep their exact pricing.

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
  'codex-gpt-5p6-terra-medium-20260804',
  'delivery_loop_relay',
  'gpt-5.6-terra',
  200000,
  40000,
  2500000,
  250000,
  15000000,
  1,
  '2026-08-04T00:00:00.000Z',
  '2026-08-04T00:00:00.000Z'
);
