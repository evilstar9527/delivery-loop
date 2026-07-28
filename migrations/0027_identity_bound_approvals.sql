-- Identity-bound high-risk approvals.
-- identity_mappings/channel_identities are copied from Watt commit 476e3cd
-- (packages/gateway migrations 0001_auth_core + 0002_channel_identities).

CREATE TABLE IF NOT EXISTS identity_mappings (
  principal  TEXT PRIMARY KEY,
  roles      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_identities (
  channel         TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  principal       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (channel, channel_user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_identities_principal
  ON channel_identities(principal);

ALTER TABLE github_merge_gate_observations
  ADD COLUMN pull_request_author_login TEXT;

CREATE TABLE IF NOT EXISTS approval_source_events (
  source_id          TEXT PRIMARY KEY,
  provider           TEXT NOT NULL CHECK (provider IN ('github', 'feishu')),
  tenant_key         TEXT NOT NULL,
  external_event_id  TEXT NOT NULL,
  event_digest       TEXT NOT NULL CHECK (length(event_digest) = 71),
  request_digest     TEXT NOT NULL CHECK (length(request_digest) = 71),
  channel            TEXT NOT NULL,
  channel_user_id    TEXT NOT NULL,
  occurred_at        TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  UNIQUE (provider, tenant_key, external_event_id)
);

CREATE TABLE IF NOT EXISTS identity_bound_approvals (
  approval_id                 TEXT PRIMARY KEY REFERENCES approvals(approval_id) ON DELETE CASCADE,
  source_id                   TEXT NOT NULL UNIQUE REFERENCES approval_source_events(source_id) ON DELETE CASCADE,
  approver_principal          TEXT NOT NULL,
  approver_channel            TEXT NOT NULL,
  approver_channel_user_id    TEXT NOT NULL,
  pull_request_author_principal TEXT NOT NULL,
  pull_request_author_channel TEXT NOT NULL,
  pull_request_author_login   TEXT NOT NULL,
  roles_digest                TEXT NOT NULL CHECK (length(roles_digest) = 71),
  separation_verified         INTEGER NOT NULL CHECK (separation_verified IN (0, 1)),
  created_at                  TEXT NOT NULL,
  CHECK (
    approver_principal <> pull_request_author_principal OR separation_verified = 0
  )
);

CREATE TABLE IF NOT EXISTS approval_identity_rejections (
  rejection_id       TEXT PRIMARY KEY,
  source_id          TEXT NOT NULL UNIQUE REFERENCES approval_source_events(source_id) ON DELETE CASCADE,
  run_id             TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  plan_id            TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version       INTEGER NOT NULL CHECK (plan_version > 0),
  effect             TEXT NOT NULL CHECK (effect IN ('merge', 'production_deploy')),
  approver_principal TEXT,
  author_principal   TEXT,
  reason             TEXT NOT NULL CHECK (
    reason IN (
      'identity_unresolved', 'actor_not_human', 'actor_not_authorized',
      'self_approval_denied', 'task_actor_self_approval'
    )
  ),
  rejected_at        TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE VIEW IF NOT EXISTS trusted_effect_approvals AS
SELECT approvals.*
FROM approvals
WHERE approvals.effect NOT IN ('merge', 'production_deploy')
UNION ALL
SELECT approvals.*
FROM approvals
JOIN identity_bound_approvals AS bindings
  ON bindings.approval_id = approvals.approval_id
JOIN channel_identities AS approver_identity
  ON approver_identity.channel = bindings.approver_channel
 AND approver_identity.channel_user_id = bindings.approver_channel_user_id
 AND approver_identity.principal = bindings.approver_principal
JOIN channel_identities AS author_identity
  ON author_identity.channel = bindings.pull_request_author_channel
 AND author_identity.channel_user_id = bindings.pull_request_author_login
 AND author_identity.principal = bindings.pull_request_author_principal
JOIN identity_mappings
  ON identity_mappings.principal = bindings.approver_principal
WHERE approvals.effect IN ('merge', 'production_deploy')
  AND bindings.separation_verified = 1
  AND bindings.approver_principal <> bindings.pull_request_author_principal
  AND json_valid(identity_mappings.roles)
  AND json_type(identity_mappings.roles) = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(identity_mappings.roles) WHERE value = 'human'
  )
  AND EXISTS (
    SELECT 1 FROM json_each(identity_mappings.roles)
    WHERE value = 'approve:' || approvals.effect
  );

CREATE TRIGGER IF NOT EXISTS trg_identity_mappings_shape
BEFORE INSERT ON identity_mappings
WHEN NOT json_valid(NEW.roles) OR json_type(NEW.roles) <> 'array'
BEGIN SELECT RAISE(ABORT, 'identity_roles_are_invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_identity_mappings_update_shape
BEFORE UPDATE OF roles ON identity_mappings
WHEN NOT json_valid(NEW.roles) OR json_type(NEW.roles) <> 'array'
BEGIN SELECT RAISE(ABORT, 'identity_roles_are_invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_channel_identity_snapshot_immutable
BEFORE UPDATE OF channel, channel_user_id, created_at ON channel_identities
BEGIN SELECT RAISE(ABORT, 'channel_identity_key_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_approval_source_events_immutable
BEFORE UPDATE ON approval_source_events
BEGIN SELECT RAISE(ABORT, 'approval_source_event_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_identity_bound_approvals_immutable
BEFORE UPDATE ON identity_bound_approvals
BEGIN SELECT RAISE(ABORT, 'identity_bound_approval_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_approval_identity_rejections_immutable
BEFORE UPDATE ON approval_identity_rejections
BEGIN SELECT RAISE(ABORT, 'approval_identity_rejection_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_identity_approval_cannot_follow_rejection
BEFORE INSERT ON identity_bound_approvals
WHEN EXISTS (
  SELECT 1 FROM approval_identity_rejections WHERE source_id = NEW.source_id
)
BEGIN SELECT RAISE(ABORT, 'approval_source_already_rejected'); END;

CREATE TRIGGER IF NOT EXISTS trg_identity_rejection_cannot_follow_approval
BEFORE INSERT ON approval_identity_rejections
WHEN EXISTS (
  SELECT 1 FROM identity_bound_approvals WHERE source_id = NEW.source_id
)
BEGIN SELECT RAISE(ABORT, 'approval_source_already_accepted'); END;
