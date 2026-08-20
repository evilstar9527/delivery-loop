-- Operator-hidden runs for the operations board.
--
-- "Deleting" a task cannot remove business rows: 77 tables carry a foreign key
-- to runs(run_id) and ten of them (outbox, attempts, evidence, execution_plans,
-- workflow_signals, ...) are non-cascading, so a DELETE is rejected outright.
-- Correlation queries and pilot evidence verifiers are also anchored on the run
-- row. This table is therefore a board-level projection only: it records that an
-- operator dismissed a run from view. Lineage stays intact and auditable, and
-- removing the row restores the run to the board.

CREATE TABLE IF NOT EXISTS dashboard_dismissals (
  run_id       TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  dismissed_at TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN ('operator_delete'))
);
