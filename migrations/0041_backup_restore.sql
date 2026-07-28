-- Private D1/R2 backup ledger and restore fencing. A restore is not serviceable
-- until every internal token is revoked, every external write credential is
-- reconciled, all active work is fenced, and the restored R2 references match.

CREATE TABLE IF NOT EXISTS backup_snapshots (
  backup_id                 TEXT PRIMARY KEY,
  manifest_digest           TEXT NOT NULL UNIQUE CHECK (length(manifest_digest) = 71),
  manifest_key              TEXT NOT NULL UNIQUE,
  d1_bookmark               TEXT NOT NULL,
  d1_export_key             TEXT NOT NULL UNIQUE,
  d1_export_digest          TEXT NOT NULL CHECK (length(d1_export_digest) = 71),
  d1_export_size            INTEGER NOT NULL CHECK (d1_export_size > 0),
  r2_descriptor_prefix      TEXT NOT NULL UNIQUE,
  r2_descriptor_set_digest  TEXT NOT NULL CHECK (length(r2_descriptor_set_digest) = 71),
  r2_object_count           INTEGER NOT NULL CHECK (r2_object_count >= 0),
  r2_total_bytes            INTEGER NOT NULL CHECK (r2_total_bytes >= 0),
  status                    TEXT NOT NULL CHECK (status = 'sealed'),
  created_at                TEXT NOT NULL,
  sealed_at                 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane_recovery_state (
  singleton           INTEGER PRIMARY KEY CHECK (singleton = 1),
  restore_generation  INTEGER NOT NULL CHECK (restore_generation >= 0),
  serving_state       TEXT NOT NULL CHECK (serving_state IN ('active', 'restoring')),
  current_restore_id  TEXT,
  updated_at          TEXT NOT NULL,
  CHECK (
    (serving_state = 'active' AND current_restore_id IS NULL) OR
    (serving_state = 'restoring' AND current_restore_id IS NOT NULL)
  )
);

INSERT OR IGNORE INTO control_plane_recovery_state (
  singleton, restore_generation, serving_state, current_restore_id, updated_at
) VALUES (1, 0, 'active', NULL, '2026-07-26T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS restore_drills (
  restore_id          TEXT PRIMARY KEY,
  backup_id           TEXT NOT NULL REFERENCES backup_snapshots(backup_id),
  manifest_digest     TEXT NOT NULL CHECK (length(manifest_digest) = 71),
  restore_generation  INTEGER NOT NULL CHECK (restore_generation > 0),
  status              TEXT NOT NULL CHECK (status IN ('fencing', 'restoring', 'ready')),
  requested_at        TEXT NOT NULL,
  fenced_at           TEXT,
  completed_at        TEXT,
  CHECK (
    (status = 'fencing' AND fenced_at IS NULL AND completed_at IS NULL) OR
    (status = 'restoring' AND fenced_at IS NOT NULL AND completed_at IS NULL) OR
    (status = 'ready' AND fenced_at IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_restore_drills_one_open
  ON restore_drills((1)) WHERE status IN ('fencing', 'restoring');

CREATE TABLE IF NOT EXISTS restore_run_fences (
  restore_id       TEXT NOT NULL REFERENCES restore_drills(restore_id) ON DELETE CASCADE,
  run_id           TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  from_state       TEXT NOT NULL,
  from_version     INTEGER NOT NULL CHECK (from_version >= 0),
  fenced_version   INTEGER NOT NULL CHECK (fenced_version = from_version + 1),
  fenced_at        TEXT NOT NULL,
  PRIMARY KEY (restore_id, run_id)
);

CREATE TABLE IF NOT EXISTS restore_token_revocations (
  restore_id        TEXT NOT NULL REFERENCES restore_drills(restore_id) ON DELETE CASCADE,
  token_id          TEXT NOT NULL REFERENCES attempt_tokens(token_id) ON DELETE CASCADE,
  attempt_id        TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  lease_generation  INTEGER NOT NULL CHECK (lease_generation > 0),
  revoked_at        TEXT NOT NULL,
  PRIMARY KEY (restore_id, token_id)
);

CREATE TABLE IF NOT EXISTS restore_consistency_checks (
  restore_id     TEXT NOT NULL REFERENCES restore_drills(restore_id) ON DELETE CASCADE,
  category       TEXT NOT NULL CHECK (
    category IN (
      'task', 'run', 'plan', 'approval', 'evidence', 'audit',
      'foreign_keys', 'r2', 'token'
    )
  ),
  passed         INTEGER NOT NULL CHECK (passed = 1),
  checked_count  INTEGER NOT NULL CHECK (checked_count >= 0),
  checked_at     TEXT NOT NULL,
  PRIMARY KEY (restore_id, category)
);

-- The view is the authoritative D1-to-R2 inventory. It stores no object body and
-- makes every supported reference expose its expected immutable metadata digest.
CREATE VIEW IF NOT EXISTS backup_r2_references AS
SELECT 'task:' || task_id AS reference_id,
       'task' AS bucket,
       substr(payload_ref, 6) AS object_key,
       task_digest AS expected_digest,
       'taskDigest' AS metadata_key
FROM tasks WHERE payload_ref LIKE 'r2://%'
UNION ALL
SELECT 'checkpoint:' || checkpoint_id,
       'checkpoint', substr(payload_ref, 6), payload_digest, 'checkpointDigest'
FROM checkpoints WHERE payload_ref LIKE 'r2://%'
UNION ALL
SELECT 'review:' || feedback_id,
       'task', substr(body_ref, 6), body_digest, 'bodyDigest'
FROM github_review_feedbacks WHERE body_ref LIKE 'r2://%'
UNION ALL
SELECT 'context:' || context_id,
       'task', substr(context_ref, 6), context_digest, 'contextDigest'
FROM supplemental_context_revisions WHERE context_ref LIKE 'r2://%';

CREATE TRIGGER IF NOT EXISTS trg_backup_snapshot_immutable
BEFORE UPDATE ON backup_snapshots
BEGIN SELECT RAISE(ABORT, 'backup_snapshot_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_restore_drill_identity_immutable
BEFORE UPDATE OF
  restore_id, backup_id, manifest_digest, restore_generation, requested_at
ON restore_drills
BEGIN SELECT RAISE(ABORT, 'restore_drill_identity_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_restore_drill_transition_guard
BEFORE UPDATE OF status, completed_at ON restore_drills
WHEN NOT (
  (OLD.status = 'fencing' AND NEW.status = 'restoring' AND NEW.completed_at IS NULL) OR
  (OLD.status = 'restoring' AND NEW.status = 'ready' AND NEW.completed_at IS NOT NULL) OR
  (OLD.status = NEW.status AND OLD.completed_at IS NEW.completed_at)
)
BEGIN SELECT RAISE(ABORT, 'restore_drill_transition_is_invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_restore_drill_fenced_at_guard
BEFORE UPDATE OF fenced_at ON restore_drills
WHEN NOT (
  OLD.status = 'fencing' AND NEW.status = 'restoring' AND
  OLD.fenced_at IS NULL AND NEW.fenced_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'restore_drill_fenced_at_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_restore_run_fence_immutable
BEFORE UPDATE ON restore_run_fences
BEGIN SELECT RAISE(ABORT, 'restore_run_fence_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_restore_token_revocation_immutable
BEFORE UPDATE ON restore_token_revocations
BEGIN SELECT RAISE(ABORT, 'restore_token_revocation_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_restore_consistency_check_immutable
BEFORE UPDATE ON restore_consistency_checks
BEGIN SELECT RAISE(ABORT, 'restore_consistency_check_is_immutable'); END;
