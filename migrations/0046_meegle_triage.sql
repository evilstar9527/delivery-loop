-- Meegle normalization stores untrusted work-item bodies only in private R2.
-- D1 contains stable source/profile identities, fixed gap codes, and lineage.

CREATE TABLE IF NOT EXISTS meegle_triage_candidates (
  candidate_id             TEXT PRIMARY KEY,
  source_identity_digest   TEXT NOT NULL CHECK (length(source_identity_digest) = 71),
  tenant_key               TEXT NOT NULL,
  project_key              TEXT NOT NULL,
  work_item_type_key       TEXT NOT NULL,
  work_item_id             TEXT NOT NULL,
  external_revision       TEXT,
  status                   TEXT NOT NULL CHECK (status = 'triaging'),
  gaps_json                TEXT NOT NULL CHECK (json_valid(gaps_json)),
  mapping_snapshot_digest  TEXT NOT NULL CHECK (length(mapping_snapshot_digest) = 71),
  mapping_profile_version  INTEGER NOT NULL CHECK (mapping_profile_version > 0),
  mapping_profile_digest   TEXT NOT NULL CHECK (length(mapping_profile_digest) = 71),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (source_identity_digest, mapping_profile_digest)
);

CREATE TABLE IF NOT EXISTS meegle_triage_lineage (
  candidate_id          TEXT NOT NULL REFERENCES meegle_triage_candidates(candidate_id),
  ingress_outbox_id     TEXT NOT NULL UNIQUE REFERENCES feishu_ingress_outbox(outbox_id),
  event_id              TEXT NOT NULL,
  exact_snapshot_digest TEXT NOT NULL CHECK (length(exact_snapshot_digest) = 71),
  snapshot_ref          TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  PRIMARY KEY (candidate_id, ingress_outbox_id)
);

CREATE INDEX IF NOT EXISTS idx_meegle_triage_status
  ON meegle_triage_candidates(status, created_at, candidate_id);

CREATE TRIGGER IF NOT EXISTS trg_meegle_triage_candidate_immutable
BEFORE UPDATE ON meegle_triage_candidates
BEGIN SELECT RAISE(ABORT, 'meegle_triage_candidate_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_meegle_triage_lineage_immutable
BEFORE UPDATE ON meegle_triage_lineage
BEGIN SELECT RAISE(ABORT, 'meegle_triage_lineage_is_immutable'); END;
