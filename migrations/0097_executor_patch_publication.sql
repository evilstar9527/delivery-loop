CREATE TABLE executor_patch_artifacts (
  patch_id TEXT PRIMARY KEY,
  work_execution_id TEXT NOT NULL UNIQUE REFERENCES attempt_execution_instances(execution_id),
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  repository TEXT NOT NULL,
  base_sha TEXT NOT NULL CHECK (length(base_sha) = 40),
  checkout_sha TEXT NOT NULL CHECK (length(checkout_sha) = 40),
  patch_digest TEXT NOT NULL CHECK (
    patch_digest GLOB 'sha256:[0-9a-f]*' AND length(patch_digest) = 71
  ),
  changed_paths_digest TEXT NOT NULL CHECK (
    changed_paths_digest GLOB 'sha256:[0-9a-f]*' AND length(changed_paths_digest) = 71
  ),
  patch_ref TEXT NOT NULL UNIQUE CHECK (patch_ref GLOB 'r2://executor-patches/*'),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 1048576),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'published', 'rejected')),
  created_at TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE executor_patch_publications (
  publication_id TEXT PRIMARY KEY,
  patch_id TEXT NOT NULL UNIQUE REFERENCES executor_patch_artifacts(patch_id),
  publisher_execution_id TEXT NOT NULL UNIQUE
    REFERENCES attempt_execution_instances(execution_id),
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  repository TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  expected_patch_digest TEXT NOT NULL CHECK (length(expected_patch_digest) = 71),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'published', 'failed')),
  recomputed_patch_digest TEXT,
  head_sha TEXT CHECK (head_sha IS NULL OR length(head_sha) = 40),
  created_at TEXT NOT NULL,
  started_at TEXT,
  published_at TEXT,
  CHECK (
    (status = 'published') =
    (recomputed_patch_digest IS NOT NULL AND head_sha IS NOT NULL AND published_at IS NOT NULL)
  )
);

CREATE TRIGGER executor_patch_artifacts_immutable
BEFORE UPDATE OF patch_id, work_execution_id, attempt_id, lease_generation,
                 repository, base_sha, checkout_sha, patch_digest,
                 changed_paths_digest, patch_ref, byte_length, created_at
ON executor_patch_artifacts
BEGIN
  SELECT RAISE(ABORT, 'executor patch identity is immutable');
END;

CREATE TRIGGER executor_patch_publications_immutable
BEFORE UPDATE OF publication_id, patch_id, publisher_execution_id, attempt_id,
                 lease_generation, repository, target_branch, expected_patch_digest, created_at
ON executor_patch_publications
BEGIN
  SELECT RAISE(ABORT, 'executor publication identity is immutable');
END;

-- A work execution remains bound to the Attempt's frozen work route. A publisher
-- is a second, independently frozen role and may use a different active profile.
DROP TRIGGER attempt_execution_instances_profile_binding;

CREATE TRIGGER attempt_execution_instances_profile_binding
BEFORE INSERT ON attempt_execution_instances
WHEN NOT EXISTS (
  SELECT 1
  FROM executor_profiles AS profile
  WHERE profile.profile_id = NEW.executor_profile_id
    AND profile.provider_kind = NEW.provider_kind
    AND profile.plugin_schema_version = NEW.plugin_schema_version
    AND profile.release_digest = NEW.release_digest
    AND profile.status IN ('active', 'retired')
)
OR (
  NEW.execution_role = 'work'
  AND NOT EXISTS (
    SELECT 1
    FROM attempts AS attempt
    WHERE attempt.attempt_id = NEW.attempt_id
      AND attempt.executor_profile_id = NEW.executor_profile_id
      AND attempt.executor_route_version IS NEW.executor_route_version
  )
)
OR (
  NEW.execution_role = 'publisher'
  AND NOT EXISTS (
    SELECT 1
    FROM attempts AS attempt
    JOIN executor_routes AS route
      ON route.repository = attempt.repository
     AND route.attempt_mode = attempt.mode
     AND route.execution_role = 'publisher'
    WHERE attempt.attempt_id = NEW.attempt_id
      AND route.profile_id = NEW.executor_profile_id
      AND route.route_version IS NEW.executor_route_version
      AND route.status = 'active'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'execution instance binding mismatch');
END;
