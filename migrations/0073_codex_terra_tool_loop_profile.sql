-- Codex `turn.completed.usage.input_tokens` is cumulative across every
-- Responses/tool round in one `codex exec` invocation; it is not bounded by
-- the model's single-request context window. Production revision 20 measured
-- 312,964 input tokens after five command rounds from a 96,693-byte context,
-- so the historical 200,000-input profile could not settle already-incurred
-- usage. Keep that profile immutable for history and select a new bounded
-- cumulative tool-loop reservation profile for future attempts.

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
  'codex-gpt-5p6-terra-medium-tool-loop-20260811',
  'delivery_loop_relay',
  'gpt-5.6-terra',
  2000000,
  40000,
  2500000,
  250000,
  15000000,
  1,
  '2026-08-11T00:00:00.000Z',
  '2026-08-11T00:00:00.000Z'
);
