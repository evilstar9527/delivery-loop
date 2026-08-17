-- Provider-neutral Agent executor authority. Historical GitHub columns and
-- github_actions outboxes remain valid during the compatibility rollout.

CREATE TABLE executor_profiles (
  profile_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK (schema_version = '1'),
  provider_kind TEXT NOT NULL CHECK (
    provider_kind GLOB '[A-Za-z0-9]*' AND length(provider_kind) BETWEEN 1 AND 64
  ),
  plugin_schema_version TEXT NOT NULL CHECK (length(plugin_schema_version) BETWEEN 1 AND 32),
  release_digest TEXT NOT NULL CHECK (
    release_digest GLOB 'sha256:[0-9a-f]*' AND length(release_digest) = 71
  ),
  configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  status TEXT NOT NULL CHECK (status IN ('staged', 'active', 'retired')),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  retired_at TEXT,
  CHECK (status <> 'active' OR activated_at IS NOT NULL),
  CHECK (status <> 'retired' OR retired_at IS NOT NULL)
);

CREATE TRIGGER executor_profiles_immutable_release
BEFORE UPDATE OF schema_version, provider_kind, plugin_schema_version,
                 release_digest, configuration_json, capabilities_json, created_at
ON executor_profiles
BEGIN
  SELECT RAISE(ABORT, 'executor profile release is immutable');
END;

CREATE TABLE executor_routes (
  route_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL CHECK (
    repository GLOB '*/*' AND length(repository) BETWEEN 3 AND 200
  ),
  attempt_mode TEXT NOT NULL CHECK (attempt_mode IN ('analysis', 'implement', 'review_fix')),
  execution_role TEXT NOT NULL CHECK (execution_role IN ('work', 'publisher')),
  profile_id TEXT NOT NULL REFERENCES executor_profiles(profile_id),
  route_version INTEGER NOT NULL CHECK (route_version > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'shadow', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repository, attempt_mode, execution_role, route_version)
);

CREATE UNIQUE INDEX executor_routes_one_active
ON executor_routes(repository, attempt_mode, execution_role)
WHERE status = 'active';

CREATE INDEX executor_routes_profile_status
ON executor_routes(profile_id, status);

INSERT INTO executor_profiles (
  profile_id, schema_version, provider_kind, plugin_schema_version,
  release_digest, configuration_json, capabilities_json, status,
  created_at, activated_at, retired_at
) VALUES (
  'legacy-github-actions-v1',
  '1',
  'github_actions',
  '1',
  'sha256:071a9c98264ad5059cd55a8bf4392c7804539df384e379e771b265607638e6cd',
  '{"compatibilityMode":"attempt_workflow_ref"}',
  '{"networkIsolation":"provider_managed","supportsCancellation":true,"supportsPublisherRole":false,"supportsReconciliation":true,"supportsSemanticResume":true,"workspaceIsolation":"ephemeral"}',
  'active',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL
);

ALTER TABLE attempts ADD COLUMN executor_profile_id TEXT
  REFERENCES executor_profiles(profile_id);
ALTER TABLE attempts ADD COLUMN executor_route_version INTEGER
  CHECK (executor_route_version IS NULL OR executor_route_version > 0);

UPDATE attempts
SET executor_profile_id = 'legacy-github-actions-v1'
WHERE workflow_ref IS NOT NULL;

CREATE TRIGGER attempts_executor_binding_immutable
BEFORE UPDATE OF executor_profile_id, executor_route_version ON attempts
WHEN OLD.executor_profile_id IS NOT NULL
  AND (
    NEW.executor_profile_id IS NOT OLD.executor_profile_id OR
    NEW.executor_route_version IS NOT OLD.executor_route_version
  )
BEGIN
  SELECT RAISE(ABORT, 'attempt executor binding is immutable');
END;

CREATE TABLE attempt_execution_instances (
  execution_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  attempt_version INTEGER NOT NULL CHECK (attempt_version >= 0),
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  execution_role TEXT NOT NULL CHECK (execution_role IN ('work', 'publisher')),
  executor_profile_id TEXT NOT NULL REFERENCES executor_profiles(profile_id),
  executor_route_version INTEGER CHECK (
    executor_route_version IS NULL OR executor_route_version > 0
  ),
  spec_digest TEXT NOT NULL CHECK (
    spec_digest GLOB 'sha256:[0-9a-f]*' AND length(spec_digest) = 71
  ),
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json)),
  release_digest TEXT NOT NULL CHECK (
    release_digest GLOB 'sha256:[0-9a-f]*' AND length(release_digest) = 71
  ),
  provider_kind TEXT NOT NULL,
  plugin_schema_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'lost')
  ),
  provider_external_id TEXT,
  validated_handle_json TEXT CHECK (
    validated_handle_json IS NULL OR json_valid(validated_handle_json)
  ),
  observation_sequence INTEGER NOT NULL DEFAULT 0 CHECK (observation_sequence >= 0),
  external_updated_at TEXT,
  outbox_id TEXT NOT NULL UNIQUE REFERENCES outbox(outbox_id),
  created_at TEXT NOT NULL,
  started_at TEXT,
  terminal_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(attempt_id, lease_generation, execution_role),
  CHECK (
    (provider_external_id IS NULL AND validated_handle_json IS NULL) OR
    (provider_external_id IS NOT NULL AND validated_handle_json IS NOT NULL)
  ),
  CHECK ((observation_sequence = 0) = (external_updated_at IS NULL)),
  CHECK (
    (status IN ('succeeded', 'failed', 'cancelled', 'lost')) = (terminal_at IS NOT NULL)
  )
);

CREATE INDEX attempt_execution_instances_attempt_status
ON attempt_execution_instances(attempt_id, status, execution_role);

CREATE TABLE executor_observations (
  observation_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES attempt_execution_instances(execution_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  status TEXT NOT NULL CHECK (
    status IN ('requested', 'queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  fact_digest TEXT NOT NULL CHECK (
    fact_digest GLOB 'sha256:[0-9a-f]*' AND length(fact_digest) = 71
  ),
  external_updated_at TEXT NOT NULL,
  facts_json TEXT NOT NULL CHECK (json_valid(facts_json)),
  observed_at TEXT NOT NULL,
  UNIQUE(execution_id, sequence),
  UNIQUE(execution_id, fact_digest)
);

CREATE INDEX executor_observations_execution_time
ON executor_observations(execution_id, external_updated_at, sequence);

CREATE TRIGGER executor_observations_immutable
BEFORE UPDATE ON executor_observations
BEGIN
  SELECT RAISE(ABORT, 'executor observation is immutable');
END;

CREATE TRIGGER attempt_execution_instances_profile_binding
BEFORE INSERT ON attempt_execution_instances
BEGIN
  SELECT CASE WHEN
    NOT EXISTS (
      SELECT 1
      FROM executor_profiles AS profile
      WHERE profile.profile_id = NEW.executor_profile_id
        AND profile.provider_kind = NEW.provider_kind
        AND profile.plugin_schema_version = NEW.plugin_schema_version
        AND profile.release_digest = NEW.release_digest
        AND profile.status IN ('active', 'retired')
    )
    OR NOT EXISTS (
      SELECT 1
      FROM attempts AS attempt
      WHERE attempt.attempt_id = NEW.attempt_id
        AND attempt.executor_profile_id = NEW.executor_profile_id
        AND attempt.executor_route_version IS NEW.executor_route_version
    )
  THEN RAISE(ABORT, 'execution instance binding mismatch') END;
END;

CREATE TRIGGER attempt_execution_instances_identity_immutable
BEFORE UPDATE OF attempt_id, attempt_version, lease_generation, execution_role,
                 executor_profile_id, executor_route_version, spec_digest,
                 spec_json, release_digest, provider_kind, plugin_schema_version, outbox_id,
                 created_at
ON attempt_execution_instances
BEGIN
  SELECT RAISE(ABORT, 'execution instance identity is immutable');
END;

CREATE TRIGGER attempt_execution_instances_handle_immutable
BEFORE UPDATE OF provider_external_id, validated_handle_json
ON attempt_execution_instances
WHEN OLD.provider_external_id IS NOT NULL
  AND (
    NEW.provider_external_id IS NOT OLD.provider_external_id OR
    NEW.validated_handle_json IS NOT OLD.validated_handle_json
  )
BEGIN
  SELECT RAISE(ABORT, 'execution provider handle is immutable');
END;
