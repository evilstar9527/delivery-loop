-- Multi-dimensional quota control. Limits are selected by exact scope key first,
-- then the wildcard policy for tenant/repository/user/run. Runtime content,
-- model output, tool arguments/results, credentials, and raw errors have no column.

CREATE TABLE IF NOT EXISTS quota_policies (
  policy_id      TEXT PRIMARY KEY,
  scope_type     TEXT NOT NULL CHECK (scope_type IN ('tenant', 'repository', 'user', 'run')),
  scope_key      TEXT NOT NULL,
  resource_type  TEXT NOT NULL CHECK (
    resource_type IN (
      'concurrency', 'attempt', 'model_tokens',
      'model_cost_microusd', 'tool_call'
    )
  ),
  limit_value    INTEGER NOT NULL CHECK (limit_value > 0),
  window_kind    TEXT NOT NULL CHECK (window_kind IN ('instant', 'utc_day', 'run_lifetime')),
  enabled        INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (scope_type, scope_key, resource_type),
  CHECK (
    (resource_type = 'concurrency' AND window_kind = 'instant') OR
    (resource_type <> 'concurrency' AND scope_type = 'run' AND window_kind = 'run_lifetime') OR
    (resource_type <> 'concurrency' AND scope_type <> 'run' AND window_kind = 'utc_day')
  )
);

CREATE INDEX IF NOT EXISTS idx_quota_policies_lookup
  ON quota_policies(scope_type, resource_type, scope_key, enabled);

-- Safe dimension projection shared by every quota path. actor_id is the durable
-- task principal key even when the source actor is a bot/system identity.
CREATE VIEW IF NOT EXISTS quota_run_scopes AS
SELECT runs.run_id, 'tenant' AS scope_type, tasks.tenant_key AS scope_key
FROM runs JOIN tasks ON tasks.task_id = runs.task_id
UNION ALL
SELECT runs.run_id, 'repository', tasks.target_repository
FROM runs JOIN tasks ON tasks.task_id = runs.task_id
UNION ALL
SELECT runs.run_id, 'user', tasks.actor_id
FROM runs JOIN tasks ON tasks.task_id = runs.task_id
UNION ALL
SELECT runs.run_id, 'run', runs.run_id
FROM runs;

-- Exact policy wins; wildcard is used only when no exact policy exists.
CREATE VIEW IF NOT EXISTS quota_effective_policies AS
SELECT scopes.run_id, scopes.scope_type, scopes.scope_key,
       policies.policy_id, policies.resource_type, policies.limit_value,
       policies.window_kind
FROM quota_run_scopes AS scopes
JOIN quota_policies AS policies
  ON policies.scope_type = scopes.scope_type
 AND policies.enabled = 1
 AND policies.scope_key IN (scopes.scope_key, '*')
WHERE policies.scope_key = scopes.scope_key
   OR NOT EXISTS (
        SELECT 1 FROM quota_policies AS exact
        WHERE exact.scope_type = policies.scope_type
          AND exact.scope_key = scopes.scope_key
          AND exact.resource_type = policies.resource_type
          AND exact.enabled = 1
      );

CREATE TABLE IF NOT EXISTS quota_override_source_events (
  source_id          TEXT PRIMARY KEY,
  provider           TEXT NOT NULL CHECK (provider IN ('github', 'feishu')),
  tenant_key         TEXT NOT NULL,
  external_event_id  TEXT NOT NULL,
  external_subject   TEXT NOT NULL,
  event_digest       TEXT NOT NULL CHECK (length(event_digest) = 71),
  request_digest     TEXT NOT NULL CHECK (length(request_digest) = 71),
  occurred_at        TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  UNIQUE (provider, tenant_key, external_event_id)
);

CREATE TABLE IF NOT EXISTS quota_overrides (
  override_id           TEXT PRIMARY KEY,
  source_id             TEXT NOT NULL UNIQUE REFERENCES quota_override_source_events(source_id) ON DELETE CASCADE,
  run_id                TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  expected_run_version  INTEGER NOT NULL CHECK (expected_run_version >= 0),
  priority_snapshot     TEXT NOT NULL CHECK (priority_snapshot = 'p0'),
  resources_json        TEXT NOT NULL CHECK (
    json_valid(resources_json) AND json_type(resources_json) = 'array'
  ),
  reason_digest         TEXT NOT NULL CHECK (length(reason_digest) = 71),
  approver_principal    TEXT,
  multiplier            INTEGER NOT NULL CHECK (multiplier = 2),
  decision              TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  status                TEXT NOT NULL CHECK (status IN ('approved', 'rejected', 'identity_rejected')),
  rejection_reason      TEXT CHECK (
    rejection_reason IS NULL OR rejection_reason IN (
      'identity_unresolved', 'actor_not_human', 'actor_not_authorized',
      'task_actor_self_approval', 'source_tenant_mismatch'
    )
  ),
  expires_at            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  CHECK (
    (status = 'approved' AND decision = 'approve' AND approver_principal IS NOT NULL
      AND rejection_reason IS NULL) OR
    (status = 'rejected' AND decision = 'reject' AND approver_principal IS NOT NULL
      AND rejection_reason IS NULL) OR
    (status = 'identity_rejected' AND rejection_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_quota_overrides_active
  ON quota_overrides(run_id, expires_at)
  WHERE status = 'approved';

CREATE TABLE IF NOT EXISTS quota_concurrency_reservations (
  reservation_id  TEXT PRIMARY KEY,
  attempt_id       TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  run_id           TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  override_id      TEXT REFERENCES quota_overrides(override_id) ON DELETE SET NULL,
  expires_at       TEXT NOT NULL,
  released_at      TEXT,
  release_reason   TEXT CHECK (
    release_reason IS NULL OR release_reason IN ('attempt_terminal', 'effect_failed', 'expired')
  ),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quota_concurrency_active
  ON quota_concurrency_reservations(run_id, expires_at)
  WHERE released_at IS NULL;

-- Model profile is trusted control-plane configuration. A reservation uses the
-- worst-case uncached input price, so settling actual cached usage can only
-- release budget, never increase it.
CREATE TABLE IF NOT EXISTS quota_model_profiles (
  profile_id                         TEXT PRIMARY KEY,
  provider                           TEXT NOT NULL,
  model                              TEXT NOT NULL,
  max_input_tokens                   INTEGER NOT NULL CHECK (max_input_tokens > 0),
  max_output_tokens                  INTEGER NOT NULL CHECK (max_output_tokens > 0),
  input_microusd_per_million         INTEGER NOT NULL CHECK (input_microusd_per_million >= 0),
  cached_input_microusd_per_million  INTEGER NOT NULL CHECK (cached_input_microusd_per_million >= 0),
  output_microusd_per_million        INTEGER NOT NULL CHECK (output_microusd_per_million >= 0),
  enabled                            INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at                         TEXT NOT NULL,
  updated_at                         TEXT NOT NULL,
  CHECK (cached_input_microusd_per_million <= input_microusd_per_million)
);

CREATE TABLE IF NOT EXISTS quota_model_reservations (
  reservation_id          TEXT PRIMARY KEY,
  attempt_id               TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  run_id                   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  profile_id               TEXT NOT NULL REFERENCES quota_model_profiles(profile_id),
  reserved_tokens          INTEGER NOT NULL CHECK (reserved_tokens > 0),
  reserved_cost_microusd   INTEGER NOT NULL CHECK (reserved_cost_microusd >= 0),
  override_id              TEXT REFERENCES quota_overrides(override_id) ON DELETE SET NULL,
  status                   TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released', 'expired')),
  expires_at               TEXT NOT NULL,
  usage_id                 TEXT UNIQUE,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quota_model_reservations_active
  ON quota_model_reservations(run_id, expires_at)
  WHERE status = 'reserved';

-- Adapted from Watt@476e3cd packages/gateway/migrations-audit/0001_audit_records.sql:
-- one row per real model invocation. Delivery Loop adds exact control-plane
-- lineage, cached/reasoning token metadata, integer micro-USD, and source digest.
CREATE TABLE IF NOT EXISTS model_usage (
  usage_id                 TEXT PRIMARY KEY,
  at                       TEXT NOT NULL,
  provider                 TEXT NOT NULL,
  model                    TEXT NOT NULL,
  run_id                   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id               TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  tenant_key               TEXT NOT NULL,
  repository               TEXT NOT NULL,
  principal                TEXT NOT NULL,
  input_tokens             INTEGER NOT NULL CHECK (input_tokens >= 0),
  cached_input_tokens      INTEGER NOT NULL CHECK (
    cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens
  ),
  output_tokens            INTEGER NOT NULL CHECK (output_tokens >= 0),
  reasoning_output_tokens  INTEGER NOT NULL CHECK (
    reasoning_output_tokens >= 0 AND reasoning_output_tokens <= output_tokens
  ),
  cost_microusd            INTEGER NOT NULL CHECK (cost_microusd >= 0),
  source_digest            TEXT NOT NULL CHECK (length(source_digest) = 71),
  created_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_usage_at ON model_usage(at);
CREATE INDEX IF NOT EXISTS idx_model_usage_run ON model_usage(run_id, at);
CREATE INDEX IF NOT EXISTS idx_model_usage_attempt ON model_usage(attempt_id, at);
CREATE INDEX IF NOT EXISTS idx_model_usage_provider_model ON model_usage(provider, model, at);

CREATE TABLE IF NOT EXISTS quota_tool_call_admissions (
  trace_id      TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id    TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  override_id   TEXT REFERENCES quota_overrides(override_id) ON DELETE SET NULL,
  occurred_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quota_tool_admissions_run
  ON quota_tool_call_admissions(run_id, occurred_at);

CREATE TABLE IF NOT EXISTS quota_denials (
  denial_id       TEXT PRIMARY KEY,
  request_id      TEXT NOT NULL,
  run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id      TEXT REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  resource_type   TEXT NOT NULL CHECK (
    resource_type IN (
      'concurrency', 'attempt', 'model_tokens',
      'model_cost_microusd', 'tool_call'
    )
  ),
  scope_type      TEXT NOT NULL CHECK (scope_type IN ('tenant', 'repository', 'user', 'run')),
  scope_key_digest TEXT NOT NULL CHECK (length(scope_key_digest) = 71),
  limit_value     INTEGER NOT NULL CHECK (limit_value > 0),
  requested_units INTEGER NOT NULL CHECK (requested_units > 0),
  reason_digest   TEXT NOT NULL CHECK (length(reason_digest) = 71),
  occurred_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (request_id, resource_type)
);

-- Safe, finite defaults. Tenant/repository/user windows reset at UTC day;
-- Run budgets are lifetime. Exact policies can tighten these values.
INSERT OR IGNORE INTO quota_policies VALUES
  ('quota_default_tenant_concurrency', 'tenant', '*', 'concurrency', 50, 'instant', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_tenant_attempt', 'tenant', '*', 'attempt', 1000, 'utc_day', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_tenant_model_tokens', 'tenant', '*', 'model_tokens', 100000000, 'utc_day', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_tenant_model_cost', 'tenant', '*', 'model_cost_microusd', 1000000000, 'utc_day', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_tenant_tool_call', 'tenant', '*', 'tool_call', 100000, 'utc_day', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_repository_concurrency', 'repository', '*', 'concurrency', 20, 'instant', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_repository_attempt', 'repository', '*', 'attempt', 500, 'utc_day', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_repository_model_tokens', 'repository', '*', 'model_tokens', 50000000, 'utc_day', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_repository_model_cost', 'repository', '*', 'model_cost_microusd', 500000000, 'utc_day', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_repository_tool_call', 'repository', '*', 'tool_call', 50000, 'utc_day', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_user_concurrency', 'user', '*', 'concurrency', 5, 'instant', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_user_attempt', 'user', '*', 'attempt', 100, 'utc_day', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_user_model_tokens', 'user', '*', 'model_tokens', 10000000, 'utc_day', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_user_model_cost', 'user', '*', 'model_cost_microusd', 100000000, 'utc_day', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_user_tool_call', 'user', '*', 'tool_call', 10000, 'utc_day', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_run_concurrency', 'run', '*', 'concurrency', 2, 'instant', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_run_attempt', 'run', '*', 'attempt', 20, 'run_lifetime', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_run_model_tokens', 'run', '*', 'model_tokens', 5000000, 'run_lifetime', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_run_model_cost', 'run', '*', 'model_cost_microusd', 50000000, 'run_lifetime', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('quota_default_run_tool_call', 'run', '*', 'tool_call', 2000, 'run_lifetime', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z');

-- A trigger covers every current and future Attempt producer. Existing stable
-- attempt_id retries are excluded so ON CONFLICT idempotency remains valid.
CREATE TRIGGER IF NOT EXISTS trg_attempt_quota_before_insert
BEFORE INSERT ON attempts
WHEN NOT EXISTS (SELECT 1 FROM attempts WHERE attempt_id = NEW.attempt_id)
 AND EXISTS (
   SELECT 1 FROM quota_effective_policies AS policy
   WHERE policy.run_id = NEW.run_id
     AND policy.resource_type = 'attempt'
     AND (
       SELECT COUNT(*)
       FROM attempts AS existing
       JOIN quota_run_scopes AS scope
         ON scope.run_id = existing.run_id
        AND scope.scope_type = policy.scope_type
        AND scope.scope_key = policy.scope_key
       WHERE policy.window_kind = 'run_lifetime'
          OR substr(existing.created_at, 1, 10) = substr(NEW.created_at, 1, 10)
     ) + 1 > policy.limit_value * CASE WHEN EXISTS (
       SELECT 1 FROM quota_overrides AS override
       WHERE override.run_id = NEW.run_id
         AND override.status = 'approved'
         AND override.expires_at > NEW.created_at
         AND EXISTS (
           SELECT 1 FROM json_each(override.resources_json)
           WHERE value = 'attempt'
         )
     ) THEN 2 ELSE 1 END
 )
BEGIN
  SELECT RAISE(ABORT, 'quota_attempt_exceeded');
END;

CREATE TRIGGER IF NOT EXISTS trg_quota_override_source_immutable
BEFORE UPDATE ON quota_override_source_events
BEGIN SELECT RAISE(ABORT, 'quota_override_source_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_quota_override_immutable
BEFORE UPDATE ON quota_overrides
BEGIN SELECT RAISE(ABORT, 'quota_override_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_model_usage_immutable
BEFORE UPDATE ON model_usage
BEGIN SELECT RAISE(ABORT, 'model_usage_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_quota_tool_admission_immutable
BEFORE UPDATE ON quota_tool_call_admissions
BEGIN SELECT RAISE(ABORT, 'quota_tool_admission_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_quota_denial_immutable
BEFORE UPDATE ON quota_denials
BEGIN SELECT RAISE(ABORT, 'quota_denial_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_quota_concurrency_identity_immutable
BEFORE UPDATE OF reservation_id, attempt_id, run_id, created_at
ON quota_concurrency_reservations
BEGIN SELECT RAISE(ABORT, 'quota_concurrency_identity_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_quota_model_reservation_identity_immutable
BEFORE UPDATE OF reservation_id, attempt_id, run_id, profile_id,
  reserved_tokens, reserved_cost_microusd, override_id, expires_at, created_at
ON quota_model_reservations
BEGIN SELECT RAISE(ABORT, 'quota_model_reservation_identity_is_immutable'); END;

-- A profile ID is a versioned pricing snapshot. Operators insert a new ID to
-- change model bounds or rates so an in-flight reservation cannot be repriced.
CREATE TRIGGER IF NOT EXISTS trg_quota_model_profile_immutable
BEFORE UPDATE OF profile_id, provider, model, max_input_tokens, max_output_tokens,
  input_microusd_per_million, cached_input_microusd_per_million,
  output_microusd_per_million, created_at
ON quota_model_profiles
BEGIN SELECT RAISE(ABORT, 'quota_model_profile_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_quota_model_profile_delete_immutable
BEFORE DELETE ON quota_model_profiles
BEGIN SELECT RAISE(ABORT, 'quota_model_profile_is_immutable'); END;
