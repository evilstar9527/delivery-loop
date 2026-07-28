-- Controlled Workflow replay: exact approval snapshot, reconciliation evidence, and fenced restart intent.

CREATE TABLE IF NOT EXISTS approvals (
  approval_id    TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  task_revision  TEXT NOT NULL,
  plan_id        TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version   INTEGER NOT NULL CHECK (plan_version > 0),
  plan_digest    TEXT NOT NULL CHECK (length(plan_digest) = 71),
  base_sha       TEXT NOT NULL CHECK (length(base_sha) = 40),
  effect         TEXT NOT NULL CHECK (
    effect IN ('repo_write', 'test_deploy', 'merge', 'production_deploy')
  ),
  actor_id       TEXT NOT NULL,
  decision       TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  nonce_digest   TEXT NOT NULL UNIQUE CHECK (length(nonce_digest) = 71),
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_replay_lookup
  ON approvals(run_id, plan_id, effect, expires_at);

CREATE TABLE IF NOT EXISTS workflow_replays (
  replay_id               TEXT PRIMARY KEY,
  run_id                   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  expected_run_version     INTEGER NOT NULL CHECK (expected_run_version >= 0),
  plan_id                  TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version             INTEGER NOT NULL CHECK (plan_version > 0),
  plan_item_id             TEXT,
  target_kind              TEXT NOT NULL CHECK (target_kind IN ('system_step', 'plan_item')),
  target_step_name         TEXT NOT NULL,
  target_step_type         TEXT NOT NULL CHECK (target_step_type IN ('do', 'sleep', 'waitForEvent')),
  target_step_count        INTEGER NOT NULL CHECK (target_step_count > 0),
  reason_digest            TEXT NOT NULL CHECK (length(reason_digest) = 71),
  effect_snapshot_digest   TEXT NOT NULL CHECK (length(effect_snapshot_digest) = 71),
  restart_observed_at      TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (run_id, expected_run_version),
  FOREIGN KEY (plan_id, plan_item_id)
    REFERENCES plan_items(plan_id, item_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_replay_effects (
  replay_id    TEXT NOT NULL REFERENCES workflow_replays(replay_id) ON DELETE CASCADE,
  effect       TEXT NOT NULL CHECK (
    effect IN (
      'repo_read', 'logs_read', 'database_diagnostic', 'repo_write',
      'test_deploy', 'merge', 'production_deploy'
    )
  ),
  approval_id  TEXT REFERENCES approvals(approval_id) ON DELETE SET NULL,
  PRIMARY KEY (replay_id, effect)
);

CREATE TABLE IF NOT EXISTS workflow_replay_reconciliations (
  replay_id      TEXT NOT NULL REFERENCES workflow_replays(replay_id) ON DELETE CASCADE,
  source_kind    TEXT NOT NULL CHECK (source_kind IN ('outbox', 'evidence')),
  source_ref     TEXT NOT NULL,
  source_digest  TEXT NOT NULL CHECK (length(source_digest) = 71),
  PRIMARY KEY (replay_id, source_kind, source_ref)
);

CREATE INDEX IF NOT EXISTS idx_workflow_replays_run_created
  ON workflow_replays(run_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_step_executions (
  run_id       TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  step_name    TEXT NOT NULL,
  run_version  INTEGER NOT NULL CHECK (run_version >= 0),
  executed_at  TEXT NOT NULL,
  PRIMARY KEY (run_id, step_name, run_version)
);
