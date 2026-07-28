-- Phase 1 control-plane projection. Workflow history is not the business state store.
-- Task/Run/Plan/Item/Attempt/outbox are normalized so replay never depends on mutable JSON arrays.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  task_id            TEXT PRIMARY KEY,
  source_system      TEXT NOT NULL,
  tenant_key         TEXT NOT NULL,
  source_task_key    TEXT NOT NULL,
  task_revision      TEXT NOT NULL,
  source_url         TEXT,
  task_digest        TEXT NOT NULL CHECK (length(task_digest) = 71),
  payload_ref        TEXT NOT NULL,
  actor_type         TEXT NOT NULL CHECK (actor_type IN ('user', 'bot', 'system')),
  actor_id           TEXT NOT NULL,
  target_repository  TEXT NOT NULL,
  target_base_branch TEXT NOT NULL,
  target_environment TEXT NOT NULL CHECK (target_environment IN ('none', 'test', 'production')),
  intent_kind        TEXT NOT NULL CHECK (intent_kind IN ('requirement', 'bug')),
  title              TEXT NOT NULL,
  priority           TEXT NOT NULL CHECK (priority IN ('p0', 'p1', 'p2', 'p3')),
  acceptance_criteria_count INTEGER NOT NULL CHECK (acceptance_criteria_count > 0),
  allow_repository_write    INTEGER NOT NULL CHECK (allow_repository_write IN (0, 1)),
  allow_test_deploy         INTEGER NOT NULL CHECK (allow_test_deploy IN (0, 1)),
  allow_production_deploy   INTEGER NOT NULL CHECK (allow_production_deploy IN (0, 1)),
  require_human_approval    INTEGER NOT NULL CHECK (require_human_approval IN (0, 1)),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (source_system, tenant_key, source_task_key, task_revision)
);

CREATE TABLE IF NOT EXISTS runs (
  run_id                TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES tasks(task_id),
  task_revision         TEXT NOT NULL,
  task_digest           TEXT NOT NULL,
  base_sha              TEXT CHECK (length(base_sha) = 40),
  workflow_instance_id  TEXT NOT NULL UNIQUE CHECK (workflow_instance_id = run_id),
  state                 TEXT NOT NULL CHECK (
    state IN (
      'received', 'triaging', 'awaiting_approval', 'queued', 'planning', 'executing',
      'verifying', 'pull_request_open', 'awaiting_review', 'ready_to_merge', 'merging',
      'deploying', 'succeeded', 'blocked', 'failed', 'cancelled'
    )
  ),
  version                INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  active_plan_id         TEXT,
  active_plan_version    INTEGER,
  active_plan_digest     TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (task_id)
);

CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope            TEXT NOT NULL,
  key_digest       TEXT NOT NULL CHECK (length(key_digest) = 71),
  request_digest   TEXT NOT NULL CHECK (length(request_digest) = 71),
  task_id          TEXT NOT NULL,
  run_id           TEXT NOT NULL,
  outbox_id        TEXT NOT NULL,
  response_status  INTEGER NOT NULL CHECK (response_status = 202),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (scope, key_digest)
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id        TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs(run_id),
  ordinal           INTEGER NOT NULL CHECK (ordinal > 0),
  mode              TEXT NOT NULL CHECK (mode IN ('analysis', 'implement', 'review_fix', 'deploy')),
  status            TEXT NOT NULL CHECK (
    status IN ('pending', 'starting', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled', 'lost')
  ),
  base_sha          TEXT NOT NULL CHECK (length(base_sha) = 40),
  repository        TEXT,
  workflow_ref      TEXT,
  github_run_id     TEXT,
  github_status     TEXT CHECK (
    github_status IS NULL OR github_status IN (
      'requested', 'queued', 'waiting', 'in_progress', 'completed'
    )
  ),
  github_conclusion TEXT,
  github_observed_at TEXT,
  result_event_id    TEXT,
  result_sequence    INTEGER CHECK (result_sequence IS NULL OR result_sequence > 0),
  result_payload_ref TEXT,
  result_digest      TEXT CHECK (result_digest IS NULL OR length(result_digest) = 71),
  result_reported_at TEXT,
  plan_id           TEXT,
  plan_version      INTEGER,
  plan_item_id      TEXT,
  version           INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  lease_generation  INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_token_digest TEXT CHECK (
    lease_token_digest IS NULL OR length(lease_token_digest) = 71
  ),
  lease_expires_at  TEXT,
  heartbeat_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (run_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_attempts_run_status ON attempts(run_id, status);

CREATE INDEX IF NOT EXISTS idx_attempts_active_write_lease
  ON attempts(run_id, lease_expires_at)
  WHERE mode IN ('implement', 'review_fix', 'deploy')
    AND status IN ('starting', 'running')
    AND lease_token_digest IS NOT NULL;

CREATE TABLE IF NOT EXISTS attempt_tokens (
  token_id          TEXT PRIMARY KEY,
  attempt_id        TEXT NOT NULL REFERENCES attempts(attempt_id),
  oidc_token_digest TEXT NOT NULL UNIQUE CHECK (length(oidc_token_digest) = 71),
  token_digest      TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 71),
  lease_generation  INTEGER NOT NULL CHECK (lease_generation > 0),
  scopes_json       TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  revoked_at        TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (attempt_id, lease_generation)
);

CREATE INDEX IF NOT EXISTS idx_attempt_tokens_active
  ON attempt_tokens(attempt_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS execution_plans (
  plan_id                TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL REFERENCES runs(run_id),
  plan_version           INTEGER NOT NULL CHECK (plan_version > 0),
  task_revision          TEXT NOT NULL,
  base_sha               TEXT NOT NULL,
  digest                 TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (
    status IN ('proposed', 'validated', 'approved', 'active', 'superseded', 'completed', 'blocked')
  ),
  created_by_attempt_id  TEXT NOT NULL REFERENCES attempts(attempt_id),
  objective              TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (run_id, plan_version),
  UNIQUE (run_id, digest)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_plans_one_active
  ON execution_plans(run_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS execution_plan_assumptions (
  plan_id     TEXT NOT NULL REFERENCES execution_plans(plan_id),
  position    INTEGER NOT NULL CHECK (position >= 0),
  assumption  TEXT NOT NULL,
  PRIMARY KEY (plan_id, position)
);

CREATE TABLE IF NOT EXISTS execution_plan_evidence_refs (
  plan_id       TEXT NOT NULL REFERENCES execution_plans(plan_id),
  position      INTEGER NOT NULL CHECK (position >= 0),
  evidence_ref  TEXT NOT NULL,
  PRIMARY KEY (plan_id, position),
  UNIQUE (plan_id, evidence_ref)
);

CREATE TABLE IF NOT EXISTS plan_items (
  plan_id       TEXT NOT NULL REFERENCES execution_plans(plan_id),
  item_id       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('investigation', 'change', 'verification', 'delivery')),
  title         TEXT NOT NULL,
  objective     TEXT NOT NULL,
  required      INTEGER NOT NULL CHECK (required IN (0, 1)),
  position      INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (plan_id, item_id),
  UNIQUE (plan_id, position)
);

CREATE TABLE IF NOT EXISTS plan_item_acceptance_criteria (
  plan_id                    TEXT NOT NULL,
  item_id                    TEXT NOT NULL,
  acceptance_criterion_index INTEGER NOT NULL CHECK (acceptance_criterion_index >= 0),
  PRIMARY KEY (plan_id, item_id, acceptance_criterion_index),
  FOREIGN KEY (plan_id, item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE TABLE IF NOT EXISTS plan_item_done_when (
  plan_id    TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  position   INTEGER NOT NULL CHECK (position >= 0),
  condition  TEXT NOT NULL,
  PRIMARY KEY (plan_id, item_id, position),
  FOREIGN KEY (plan_id, item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE TABLE IF NOT EXISTS plan_item_dependencies (
  plan_id            TEXT NOT NULL,
  item_id            TEXT NOT NULL,
  depends_on_item_id TEXT NOT NULL,
  PRIMARY KEY (plan_id, item_id, depends_on_item_id),
  FOREIGN KEY (plan_id, item_id) REFERENCES plan_items(plan_id, item_id),
  FOREIGN KEY (plan_id, depends_on_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE TABLE IF NOT EXISTS plan_item_effects (
  plan_id  TEXT NOT NULL,
  item_id  TEXT NOT NULL,
  effect   TEXT NOT NULL CHECK (
    effect IN (
      'repo_read', 'logs_read', 'database_diagnostic', 'repo_write',
      'test_deploy', 'merge', 'production_deploy'
    )
  ),
  PRIMARY KEY (plan_id, item_id, effect),
  FOREIGN KEY (plan_id, item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE TABLE IF NOT EXISTS plan_item_command_refs (
  plan_id      TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  command_ref  TEXT NOT NULL,
  PRIMARY KEY (plan_id, item_id, command_ref),
  FOREIGN KEY (plan_id, item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE TABLE IF NOT EXISTS plan_item_evidence_kinds (
  plan_id       TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  PRIMARY KEY (plan_id, item_id, evidence_kind),
  FOREIGN KEY (plan_id, item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE TABLE IF NOT EXISTS plan_item_external_facts (
  plan_id       TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  external_fact TEXT NOT NULL CHECK (external_fact IN ('github_pr', 'github_check', 'deployment')),
  PRIMARY KEY (plan_id, item_id, external_fact),
  FOREIGN KEY (plan_id, item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE TABLE IF NOT EXISTS plan_item_progress (
  plan_id           TEXT NOT NULL,
  item_id           TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (
    status IN ('pending', 'ready', 'in_progress', 'passed', 'failed', 'blocked', 'skipped')
  ),
  active_attempt_id TEXT REFERENCES attempts(attempt_id),
  version           INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (plan_id, item_id),
  FOREIGN KEY (plan_id, item_id) REFERENCES plan_items(plan_id, item_id)
);

-- Full checkpoint payloads live in private R2. D1 keeps only recovery/query metadata.
CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id  TEXT PRIMARY KEY,
  attempt_id     TEXT NOT NULL REFERENCES attempts(attempt_id),
  sequence       INTEGER NOT NULL CHECK (sequence > 0),
  plan_id        TEXT REFERENCES execution_plans(plan_id),
  plan_version   INTEGER CHECK (plan_version IS NULL OR plan_version > 0),
  plan_item_id   TEXT,
  head_sha       TEXT CHECK (head_sha IS NULL OR length(head_sha) = 40),
  payload_ref    TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 71),
  summary        TEXT NOT NULL,
  next_step      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (attempt_id, sequence),
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_attempt_sequence
  ON checkpoints(attempt_id, sequence DESC);

-- Evidence content/artifacts remain referenced; this table is the normalized safe projection.
CREATE TABLE IF NOT EXISTS evidence (
  evidence_id         TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(run_id),
  attempt_id          TEXT REFERENCES attempts(attempt_id),
  plan_id             TEXT REFERENCES execution_plans(plan_id),
  plan_version        INTEGER CHECK (plan_version IS NULL OR plan_version > 0),
  plan_item_id        TEXT,
  kind                TEXT NOT NULL CHECK (
    kind IN (
      'diagnostic', 'plan', 'test', 'lint', 'build', 'commit',
      'pull_request', 'check', 'deployment', 'approval'
    )
  ),
  status              TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
  command_ref         TEXT,
  exit_code           INTEGER,
  sha                 TEXT,
  external_url        TEXT,
  artifact_ref        TEXT,
  artifact_digest     TEXT CHECK (
    artifact_digest IS NULL OR length(artifact_digest) = 71
  ),
  summary             TEXT NOT NULL,
  verification_status TEXT NOT NULL CHECK (
    verification_status IN ('unverified', 'verified', 'rejected')
  ),
  observed_at         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_run_plan_item
  ON evidence(run_id, plan_id, plan_item_id, observed_at);

CREATE TABLE IF NOT EXISTS workflow_signals (
  signal_id            TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES runs(run_id),
  event_id             TEXT NOT NULL,
  workflow_event_type  TEXT NOT NULL,
  signal_type          TEXT NOT NULL CHECK (signal_type = 'attempt_completed'),
  attempt_id           TEXT NOT NULL,
  sequence             INTEGER NOT NULL CHECK (sequence > 0),
  payload_ref          TEXT NOT NULL,
  digest               TEXT NOT NULL CHECK (length(digest) = 71),
  occurred_at          TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  UNIQUE (run_id, event_id),
  UNIQUE (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS outbox (
  outbox_id       TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(run_id),
  kind            TEXT NOT NULL,
  destination     TEXT NOT NULL,
  payload_ref     TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL UNIQUE,
  delivery_state  TEXT NOT NULL CHECK (delivery_state IN ('pending', 'delivering', 'settled')),
  attempt_count   INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token     TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_delivery ON outbox(delivery_state, created_at);
