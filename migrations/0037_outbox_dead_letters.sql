-- Queue retry exhaustion is projected into D1 before the platform DLQ message
-- is acknowledged. The original outbox row remains the sole effect intent;
-- replay only re-arms that row and never copies its payload or authority.

CREATE TABLE IF NOT EXISTS outbox_dead_letters (
  dead_letter_id        TEXT PRIMARY KEY,
  outbox_id             TEXT NOT NULL REFERENCES outbox(outbox_id) ON DELETE CASCADE,
  run_id                TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  source_queue          TEXT NOT NULL CHECK (
    source_queue = 'delivery-loop-workflow-outbox'
  ),
  source_message_id     TEXT NOT NULL CHECK (
    length(source_message_id) BETWEEN 1 AND 256
  ),
  source_attempts       INTEGER NOT NULL CHECK (source_attempts >= 1),
  outbox_kind           TEXT NOT NULL,
  destination           TEXT NOT NULL,
  outbox_attempt_count  INTEGER NOT NULL CHECK (outbox_attempt_count >= 0),
  last_error_code       TEXT CHECK (
    last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 64
  ),
  status                TEXT NOT NULL CHECK (
    status IN ('open', 'replay_requested', 'resolved')
  ),
  captured_at           TEXT NOT NULL,
  replay_requested_at   TEXT,
  resolved_at           TEXT,
  resolution_code       TEXT CHECK (
    resolution_code IS NULL OR resolution_code = 'outbox_settled'
  ),
  UNIQUE (source_queue, source_message_id),
  CHECK (
    (status = 'open' AND replay_requested_at IS NULL
      AND resolved_at IS NULL AND resolution_code IS NULL) OR
    (status = 'replay_requested' AND replay_requested_at IS NOT NULL
      AND resolved_at IS NULL AND resolution_code IS NULL) OR
    (status = 'resolved' AND resolved_at IS NOT NULL
      AND resolution_code = 'outbox_settled')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dead_letters_one_open
  ON outbox_dead_letters(outbox_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_outbox_dead_letters_status
  ON outbox_dead_letters(status, captured_at, dead_letter_id);

CREATE TABLE IF NOT EXISTS outbox_dead_letter_replays (
  replay_id                     TEXT PRIMARY KEY,
  dead_letter_id                TEXT NOT NULL UNIQUE
    REFERENCES outbox_dead_letters(dead_letter_id) ON DELETE CASCADE,
  outbox_id                     TEXT NOT NULL REFERENCES outbox(outbox_id) ON DELETE CASCADE,
  expected_outbox_attempt_count INTEGER NOT NULL CHECK (
    expected_outbox_attempt_count >= 0
  ),
  requested_by                  TEXT NOT NULL CHECK (requested_by = 'service:operations'),
  reason_code                   TEXT NOT NULL CHECK (
    reason_code IN ('operator_retry', 'upstream_recovered', 'configuration_fixed')
  ),
  created_at                    TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_outbox_dead_letter_identity_immutable
BEFORE UPDATE ON outbox_dead_letters
FOR EACH ROW
WHEN NEW.dead_letter_id <> OLD.dead_letter_id
  OR NEW.outbox_id <> OLD.outbox_id
  OR NEW.run_id <> OLD.run_id
  OR NEW.source_queue <> OLD.source_queue
  OR NEW.source_message_id <> OLD.source_message_id
  OR NEW.source_attempts <> OLD.source_attempts
  OR NEW.outbox_kind <> OLD.outbox_kind
  OR NEW.destination <> OLD.destination
  OR NEW.outbox_attempt_count <> OLD.outbox_attempt_count
  OR NEW.last_error_code IS NOT OLD.last_error_code
  OR NEW.captured_at <> OLD.captured_at
BEGIN
  SELECT RAISE(ABORT, 'outbox dead letter identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_outbox_dead_letter_transition_guard
BEFORE UPDATE ON outbox_dead_letters
FOR EACH ROW
WHEN (OLD.status = 'open' AND NEW.status NOT IN ('open', 'replay_requested', 'resolved'))
  OR (OLD.status = 'replay_requested' AND NEW.status NOT IN ('replay_requested', 'resolved'))
  OR (OLD.status = 'resolved' AND (
    NEW.status <> OLD.status
    OR NEW.replay_requested_at IS NOT OLD.replay_requested_at
    OR NEW.resolved_at IS NOT OLD.resolved_at
    OR NEW.resolution_code IS NOT OLD.resolution_code
  ))
BEGIN
  SELECT RAISE(ABORT, 'outbox dead letter transition is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_outbox_dead_letter_replay_immutable
BEFORE UPDATE ON outbox_dead_letter_replays
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'outbox dead letter replay is immutable');
END;
