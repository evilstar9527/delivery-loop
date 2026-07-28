-- Immutable Meegle snapshot/profile -> triage or Task/Run lineage.
-- D1 keeps only identities, digests, configured keys, counts, and fixed outcomes;
-- untrusted work-item bodies and principals remain in the private R2 snapshot.

CREATE TABLE IF NOT EXISTS meegle_mapping_lineage (
  ingress_outbox_id                TEXT PRIMARY KEY
    REFERENCES feishu_ingress_outbox(outbox_id),
  event_id                         TEXT NOT NULL,
  tenant_key                       TEXT NOT NULL,
  project_key                      TEXT NOT NULL,
  work_item_type_key               TEXT NOT NULL,
  work_item_id                     TEXT NOT NULL,
  external_revision               TEXT,
  outcome                          TEXT NOT NULL
    CHECK (outcome IN ('mapped', 'triaging')),
  exact_snapshot_digest            TEXT NOT NULL
    CHECK (length(exact_snapshot_digest) = 71),
  mapping_snapshot_digest          TEXT NOT NULL
    CHECK (length(mapping_snapshot_digest) = 71),
  mapping_profile_version          INTEGER NOT NULL
    CHECK (mapping_profile_version > 0),
  mapping_profile_digest           TEXT NOT NULL
    CHECK (length(mapping_profile_digest) = 71),
  acceptance_criteria_field_key    TEXT NOT NULL,
  owner_role_key                   TEXT NOT NULL,
  target_repository_field_key      TEXT NOT NULL,
  snapshot_ref                     TEXT NOT NULL,
  fields_complete                  INTEGER NOT NULL
    CHECK (fields_complete IN (0, 1)),
  has_next_page_token              INTEGER NOT NULL
    CHECK (has_next_page_token IN (0, 1)),
  field_count                      INTEGER NOT NULL
    CHECK (field_count >= 0),
  role_count                       INTEGER NOT NULL
    CHECK (role_count >= 0),
  owner_count                      INTEGER NOT NULL
    CHECK (owner_count >= 0),
  target_repository_status         TEXT NOT NULL
    CHECK (target_repository_status IN ('allowed', 'missing', 'invalid')),
  gaps_json                        TEXT NOT NULL
    CHECK (json_valid(gaps_json)),
  candidate_id                     TEXT
    REFERENCES meegle_triage_candidates(candidate_id),
  task_id                          TEXT REFERENCES tasks(task_id),
  run_id                           TEXT REFERENCES runs(run_id),
  created_at                       TEXT NOT NULL,
  UNIQUE (tenant_key, event_id),
  CHECK (
    (outcome = 'mapped' AND candidate_id IS NULL AND task_id IS NOT NULL
      AND run_id IS NOT NULL AND gaps_json = '[]')
    OR
    (outcome = 'triaging' AND candidate_id IS NOT NULL AND task_id IS NULL
      AND run_id IS NULL AND gaps_json <> '[]')
  )
);

CREATE INDEX IF NOT EXISTS idx_meegle_mapping_source
  ON meegle_mapping_lineage(
    tenant_key, project_key, work_item_type_key, work_item_id, external_revision
  );

CREATE TRIGGER IF NOT EXISTS trg_meegle_mapping_lineage_immutable
BEFORE UPDATE ON meegle_mapping_lineage
BEGIN SELECT RAISE(ABORT, 'meegle_mapping_lineage_is_immutable'); END;
