-- Recover one initial implementation Attempt that was fenced after its GitHub
-- Action failed before any write credential, repository head, verification, or
-- Evidence existed. A fresh identity-bound repo_write approval is required.

CREATE TABLE implementation_pre_effect_recovery_approvals (
  recovery_approval_id TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  plan_id              TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version         INTEGER NOT NULL CHECK (plan_version > 0),
  plan_item_id         TEXT NOT NULL,
  failed_attempt_id    TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  approval_id          TEXT NOT NULL UNIQUE REFERENCES approvals(approval_id),
  created_at           TEXT NOT NULL,
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE TABLE implementation_pre_effect_recoveries (
  recovery_id           TEXT PRIMARY KEY,
  recovery_approval_id  TEXT NOT NULL UNIQUE
    REFERENCES implementation_pre_effect_recovery_approvals(recovery_approval_id)
    ON DELETE CASCADE,
  run_id                TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  plan_id               TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version          INTEGER NOT NULL CHECK (plan_version > 0),
  plan_item_id          TEXT NOT NULL,
  failed_attempt_id     TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  approval_id           TEXT NOT NULL UNIQUE REFERENCES approvals(approval_id),
  replacement_attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  created_at            TEXT NOT NULL,
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id),
  CHECK (failed_attempt_id <> replacement_attempt_id)
);

CREATE TRIGGER trg_implementation_pre_effect_recovery_approvals_immutable
BEFORE UPDATE ON implementation_pre_effect_recovery_approvals
BEGIN
  SELECT RAISE(ABORT, 'implementation_pre_effect_recovery_approval_is_immutable');
END;

CREATE TRIGGER trg_implementation_pre_effect_recoveries_immutable
BEFORE UPDATE ON implementation_pre_effect_recoveries
BEGIN
  SELECT RAISE(ABORT, 'implementation_pre_effect_recovery_is_immutable');
END;

CREATE VIEW implementation_lost_pre_effect_recovery_candidates AS
SELECT runs.run_id,
       runs.version AS run_version,
       plans.plan_id,
       plans.plan_version,
       plans.digest AS plan_digest,
       progress.item_id AS plan_item_id,
       progress.version AS progress_version,
       lost.attempt_id AS failed_attempt_id,
       lost.attempt_id AS root_review_attempt_id,
       runs.base_sha AS source_head_sha,
       NULL AS blocker_id,
       'implement_lost_pre_effect' AS source_kind
FROM runs
JOIN tasks ON tasks.task_id = runs.task_id
JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
JOIN plan_item_progress AS progress ON progress.plan_id = plans.plan_id
JOIN attempts AS lost ON lost.attempt_id = progress.active_attempt_id
WHERE runs.state = 'blocked'
  AND runs.active_plan_version = plans.plan_version
  AND runs.active_plan_digest = plans.digest
  AND plans.status = 'active'
  AND plans.base_sha = runs.base_sha
  AND tasks.allow_repository_write = 1
  AND progress.status = 'in_progress'
  AND progress.active_attempt_id = lost.attempt_id
  AND progress.protected_path_gate_id IS NULL
  AND lost.mode = 'implement'
  AND lost.status = 'lost'
  AND lost.result_event_id IS NULL
  AND lost.github_status = 'completed'
  AND lost.github_conclusion IS NOT NULL
  AND lost.github_conclusion <> 'success'
  AND lost.plan_id = plans.plan_id
  AND lost.plan_version = plans.plan_version
  AND lost.plan_item_id = progress.item_id
  AND lost.base_sha = runs.base_sha
  AND lost.repository = tasks.target_repository
  AND lost.workflow_ref IS NOT NULL
  AND lost.head_branch IS NULL
  AND lost.head_sha IS NULL
  AND EXISTS (
    SELECT 1 FROM plan_item_effects
    WHERE plan_item_effects.plan_id = plans.plan_id
      AND plan_item_effects.item_id = progress.item_id
      AND plan_item_effects.effect = 'repo_write'
  )
  AND EXISTS (
    SELECT 1 FROM run_stuck_incidents AS incident
    WHERE incident.run_id = runs.run_id
      AND incident.attempt_id = lost.attempt_id
      AND incident.state_kind = 'running'
      AND incident.observed_run_state = 'executing'
      AND incident.run_version + 1 = runs.version
      AND incident.action = 'fence_lost_attempt'
      AND incident.status = 'resolved'
      AND incident.resolution_code = 'attempt_fenced'
  )
  AND EXISTS (
    SELECT 1 FROM outbox AS cancel
    WHERE cancel.run_id = runs.run_id
      AND cancel.kind = 'workflow_cancel'
      AND cancel.delivery_state = 'settled'
  )
  AND NOT EXISTS (
    SELECT 1 FROM run_blockers
    WHERE run_blockers.run_id = runs.run_id AND run_blockers.resolved_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM github_write_credentials
    WHERE github_write_credentials.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM attempt_failures WHERE attempt_failures.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM attempt_head_updates WHERE attempt_head_updates.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM verification_suites WHERE verification_suites.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM evidence WHERE evidence.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM checkpoints WHERE checkpoints.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM attempts AS replacement
    WHERE replacement.recovered_from_attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM implementation_pre_effect_recovery_approvals AS recovery
    WHERE recovery.failed_attempt_id = lost.attempt_id
  );

CREATE VIEW repo_write_recovery_candidates_v3 AS
SELECT * FROM review_approval_recovery_candidates_v2
UNION ALL
SELECT * FROM implementation_lost_pre_effect_recovery_candidates;
