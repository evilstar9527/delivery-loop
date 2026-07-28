-- Content-bound approval pause for high-risk repository paths.
-- Only path metadata and digests enter D1; raw patches and file contents never do.

CREATE TABLE IF NOT EXISTS protected_path_change_gates (
  gate_id                 TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id              TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  plan_id                 TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version            INTEGER NOT NULL CHECK (plan_version > 0),
  plan_item_id            TEXT NOT NULL,
  lease_generation        INTEGER NOT NULL CHECK (lease_generation > 0),
  base_sha                TEXT NOT NULL CHECK (length(base_sha) = 40),
  staged_tree_sha         TEXT NOT NULL CHECK (length(staged_tree_sha) = 40),
  delivery_policy_digest  TEXT NOT NULL CHECK (length(delivery_policy_digest) = 71),
  diff_digest             TEXT NOT NULL CHECK (length(diff_digest) = 71),
  total_changed_files     INTEGER NOT NULL CHECK (total_changed_files > 0),
  protected_change_count  INTEGER NOT NULL CHECK (protected_change_count > 0),
  status                  TEXT NOT NULL CHECK (
    status IN ('awaiting_approval', 'approved', 'rejected', 'superseded')
  ),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (attempt_id, lease_generation),
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_protected_path_gates_run_status
  ON protected_path_change_gates(run_id, status, created_at);

CREATE TABLE IF NOT EXISTS protected_path_change_entries (
  gate_id        TEXT NOT NULL REFERENCES protected_path_change_gates(gate_id) ON DELETE CASCADE,
  position       INTEGER NOT NULL CHECK (position >= 0),
  path           TEXT NOT NULL,
  previous_path  TEXT,
  change_type    TEXT NOT NULL CHECK (
    change_type IN ('added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed', 'unmerged')
  ),
  additions      INTEGER CHECK (additions IS NULL OR additions >= 0),
  deletions      INTEGER CHECK (deletions IS NULL OR deletions >= 0),
  PRIMARY KEY (gate_id, position)
);

ALTER TABLE plan_item_progress
  ADD COLUMN protected_path_gate_id TEXT REFERENCES protected_path_change_gates(gate_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_item_progress_protected_path_gate
  ON plan_item_progress(protected_path_gate_id)
  WHERE protected_path_gate_id IS NOT NULL;
