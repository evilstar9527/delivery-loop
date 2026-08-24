-- Durable record of runs auto-cancelled because their dispatch was dead-lettered.
--
-- A dispatch that exhausts its retries lands in outbox_dead_letters with
-- status='open', and the outbox claim statement excludes open dead letters by
-- design (see fenced-outbox.ts). That is deliberate backpressure, but it leaves
-- the run permanently stalled with nothing watching it: seven runs sat in
-- 'planning' for 36-44 hours before an operator noticed.
--
-- Auto-cancellation makes the stall self-clearing. This table is what keeps it
-- from being silent: it records which outbox row and dead letter caused the
-- cancellation and which error code was last observed, so the disappearance of
-- a task stays explainable after the fact.
--
-- Kept separate from run_stuck_incidents on purpose. That table's CHECK forbids
-- attempt_id for non-running kinds and has no column for an outbox or dead
-- letter id, and widening its enums would mean rebuilding a table that four
-- views and two triggers depend on. The diagnostic value here is precisely the
-- dispatch identifiers, so a dedicated table is both safer and more truthful.
--
-- Rows hold only identifiers, fixed enums and timestamps. Raw provider errors
-- and task bodies are deliberately absent.

CREATE TABLE IF NOT EXISTS dispatch_stall_incidents (
  incident_id        TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  outbox_id          TEXT NOT NULL,
  dead_letter_id     TEXT NOT NULL,
  -- The last error code the outbox observed. Bounded to the codes the dispatch
  -- lane can emit; 'executor_unavailable' is the fenced processor's fallback
  -- for any non-OutboxEffectError throw, so it means "unknown effect failure"
  -- rather than a proven upstream outage.
  last_error_code    TEXT NOT NULL,
  observed_run_state TEXT NOT NULL CHECK (
    observed_run_state IN (
      'received', 'triaging', 'awaiting_approval', 'queued', 'planning',
      'executing', 'verifying', 'pull_request_open', 'awaiting_review',
      'ready_to_merge', 'merging', 'deploying'
    )
  ),
  run_version        INTEGER NOT NULL CHECK (run_version >= 0),
  threshold_seconds  INTEGER NOT NULL CHECK (
    threshold_seconds BETWEEN 60 AND 604800
  ),
  -- 'cancelled' is the success path. 'cancel_conflicted' records that the run
  -- moved on or refused cancellation between detection and the write, which
  -- must stay visible rather than being retried into a loop.
  disposition        TEXT NOT NULL CHECK (
    disposition IN ('cancelled', 'cancel_conflicted')
  ),
  detected_at        TEXT NOT NULL,
  resolved_at        TEXT NOT NULL,

  -- One incident per dead letter, so a repeated scan cannot cancel twice or
  -- accumulate duplicate history for the same stall.
  UNIQUE (dead_letter_id)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_stall_incidents_run
  ON dispatch_stall_incidents(run_id, detected_at, incident_id);

CREATE INDEX IF NOT EXISTS idx_dispatch_stall_incidents_detected
  ON dispatch_stall_incidents(detected_at, incident_id);

-- Supports the detector's join from open dead letters back to their outbox row.
CREATE INDEX IF NOT EXISTS idx_outbox_dead_letters_open_outbox
  ON outbox_dead_letters(status, outbox_id);

-- An incident is an immutable historical fact once written.
CREATE TRIGGER IF NOT EXISTS trg_dispatch_stall_incident_immutable
BEFORE UPDATE ON dispatch_stall_incidents
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'dispatch stall incident is immutable');
END;
