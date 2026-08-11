-- Continue the bounded three-iteration automated-review loop after the Run's
-- lifetime attempt budget is full. Every extra Attempt requires an immutable
-- slot produced by the same D1 batch from an existing review lineage.

CREATE TABLE automated_review_loop_quota_slots (
  slot_id            TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  source_review_id   TEXT NOT NULL REFERENCES automated_reviews(review_id) ON DELETE CASCADE,
  attempt_id         TEXT NOT NULL UNIQUE,
  attempt_mode       TEXT NOT NULL CHECK (attempt_mode IN ('analysis', 'review_fix')),
  slot_kind          TEXT NOT NULL CHECK (slot_kind IN ('next_review', 'review_fix')),
  created_at         TEXT NOT NULL,
  UNIQUE (source_review_id, slot_kind),
  CHECK (
    (slot_kind = 'next_review' AND attempt_mode = 'analysis') OR
    (slot_kind = 'review_fix' AND attempt_mode = 'review_fix')
  )
);

CREATE TRIGGER trg_automated_review_loop_quota_slot_immutable
BEFORE UPDATE ON automated_review_loop_quota_slots
BEGIN
  SELECT RAISE(ABORT, 'automated_review_loop_quota_slot_is_immutable');
END;

CREATE TABLE automated_review_replacement_redispatches (
  redispatch_id          TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  review_id              TEXT NOT NULL UNIQUE REFERENCES automated_reviews(review_id) ON DELETE CASCADE,
  replacement_attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  outbox_id              TEXT NOT NULL UNIQUE,
  created_at             TEXT NOT NULL
);

CREATE TRIGGER trg_automated_review_replacement_redispatch_immutable
BEFORE UPDATE ON automated_review_replacement_redispatches
BEGIN
  SELECT RAISE(ABORT, 'automated_review_replacement_redispatch_is_immutable');
END;

DROP TRIGGER trg_attempt_quota_before_insert;

CREATE TRIGGER trg_attempt_quota_before_insert
BEFORE INSERT ON attempts
WHEN NOT EXISTS (SELECT 1 FROM attempts WHERE attempt_id = NEW.attempt_id)
 AND EXISTS (
   SELECT 1 FROM quota_effective_policies AS policy
   WHERE policy.run_id = NEW.run_id
     AND policy.resource_type = 'attempt'
     AND (
       SELECT COUNT(*)
       FROM attempts AS existing
       JOIN quota_run_scopes AS scope
         ON scope.run_id = existing.run_id
        AND scope.scope_type = policy.scope_type
        AND scope.scope_key = policy.scope_key
       WHERE policy.window_kind = 'run_lifetime'
          OR substr(existing.created_at, 1, 10) = substr(NEW.created_at, 1, 10)
     ) + 1 > policy.limit_value * CASE WHEN EXISTS (
       SELECT 1 FROM quota_overrides AS override
       WHERE override.run_id = NEW.run_id
         AND override.status = 'approved'
         AND override.expires_at > NEW.created_at
         AND EXISTS (
           SELECT 1 FROM json_each(override.resources_json)
           WHERE value = 'attempt'
         )
     ) THEN 2 ELSE 1 END
     AND NOT (
       policy.scope_type = 'run'
       AND (
         (NEW.mode = 'analysis' AND NEW.status = 'pending'
          AND NEW.recovered_from_attempt_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM automated_review_quota_recovery_slots AS slot
            WHERE slot.run_id = NEW.run_id
              AND slot.root_attempt_id = NEW.recovered_from_attempt_id
              AND slot.replacement_attempt_id = NEW.attempt_id
          ))
         OR
         EXISTS (
           SELECT 1 FROM automated_review_loop_quota_slots AS slot
           WHERE slot.run_id = NEW.run_id
             AND slot.attempt_id = NEW.attempt_id
             AND slot.attempt_mode = NEW.mode
         )
       )
     )
 )
BEGIN
  SELECT RAISE(ABORT, 'quota_attempt_exceeded');
END;
