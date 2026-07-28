-- Operations access ledger for the one-query Case 8 audit proof. The report
-- itself is derived from authoritative domain tables and is never duplicated
-- as JSON; only its canonical digest, timing, actor and Run identity are kept.

CREATE TABLE IF NOT EXISTS case8_audit_report_accesses (
  access_id       TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  principal       TEXT NOT NULL CHECK (principal = 'service:operations'),
  report_digest   TEXT NOT NULL CHECK (length(report_digest) = 71),
  answer_count    INTEGER NOT NULL CHECK (answer_count = 8),
  duration_ms     INTEGER NOT NULL CHECK (duration_ms >= 0 AND duration_ms < 300000),
  requested_at    TEXT NOT NULL,
  completed_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_case8_audit_access_run
  ON case8_audit_report_accesses(run_id, completed_at, access_id);

CREATE TRIGGER IF NOT EXISTS trg_case8_audit_report_access_immutable
BEFORE UPDATE ON case8_audit_report_accesses
BEGIN SELECT RAISE(ABORT, 'case8_audit_report_access_is_immutable'); END;
