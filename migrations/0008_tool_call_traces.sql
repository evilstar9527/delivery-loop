-- Metadata-only tool-bridge traces. Arguments, results, headers and error text have no columns.
CREATE TABLE IF NOT EXISTS tool_call_traces (
  trace_id        TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  attempt_id      TEXT NOT NULL,
  tool_path       TEXT NOT NULL,
  action          TEXT NOT NULL,
  effect          TEXT NOT NULL CHECK (effect IN ('read', 'write', 'destructive', 'external')),
  duration_ms     INTEGER NOT NULL CHECK (duration_ms >= 0 AND duration_ms <= 60000),
  result_category TEXT NOT NULL CHECK (
    result_category IN (
      'success', 'policy_denied', 'upstream_error',
      'timeout', 'unavailable', 'invalid_response'
    )
  ),
  occurred_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_call_traces_attempt
  ON tool_call_traces(run_id, attempt_id, occurred_at);
