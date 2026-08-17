import { canonicalSha256 } from '../domain/digest.js';
import {
  assertExecutorProfile,
  assertFrozenExecutionSpec,
} from '../executor/core/executor-registry.js';
import type { ExecutorPluginRegistry } from '../executor/core/executor-registry.js';
import type {
  ExecutorCapabilities,
  ExecutorProfile,
  FrozenExecutionSpec,
} from '../executor/core/executor-plugin.js';

export class ExecutorControlError extends Error {
  constructor(
    readonly code:
      | 'profile_conflict'
      | 'route_conflict'
      | 'route_not_found'
      | 'attempt_binding_conflict'
      | 'execution_conflict',
  ) {
    super(`Executor control operation failed: ${code}`);
    this.name = 'ExecutorControlError';
  }
}

interface ExecutorProfileRow {
  profile_id: string;
  schema_version: '1';
  provider_kind: string;
  plugin_schema_version: string;
  release_digest: string;
  configuration_json: string;
  capabilities_json: string;
  status: 'staged' | 'active' | 'retired';
}

interface ExecutorRouteRow {
  route_id: string;
  profile_id: string;
  route_version: number;
}

export interface InstallExecutorRouteInput {
  routeId: string;
  repository: string;
  attemptMode: 'analysis' | 'implement' | 'review_fix';
  executionRole: 'work' | 'publisher';
  profileId: string;
  routeVersion: number;
}

export interface FreezeExecutionInput {
  spec: FrozenExecutionSpec;
  expectedAttemptVersion: number;
  outboxId: string;
  now?: Date;
}

export interface FrozenExecutionInstance {
  executionId: string;
  attemptId: string;
  leaseGeneration: number;
  executionRole: 'work' | 'publisher';
  profileId: string;
  routeVersion: number;
  specDigest: string;
  status: string;
  outboxId: string;
  created: boolean;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function parseJsonRecord(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ExecutorControlError('profile_conflict');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ExecutorControlError('profile_conflict');
  }
  return value as Record<string, unknown>;
}

function profileFromRow(row: ExecutorProfileRow): ExecutorProfile {
  return {
    schemaVersion: row.schema_version,
    profileId: row.profile_id,
    kind: row.provider_kind,
    pluginSchemaVersion: row.plugin_schema_version,
    releaseDigest: row.release_digest,
    configuration: parseJsonRecord(row.configuration_json) as Record<
      string,
      string | number | boolean
    >,
  };
}

/** D1 authority for immutable profiles/routes and provider-neutral execution instances. */
export class ExecutorControlStore {
  constructor(
    private readonly db: D1Database,
    private readonly plugins: ExecutorPluginRegistry,
  ) {}

  async registerProfile(
    profile: ExecutorProfile,
    status: 'staged' | 'active' = 'staged',
    now = new Date(),
  ): Promise<{ created: boolean; capabilities: ExecutorCapabilities }> {
    assertExecutorProfile(profile);
    const capabilities = this.plugins.resolve(profile).capabilities(profile);
    const nowIso = now.toISOString();
    const inserted = await this.db.prepare(
      `INSERT INTO executor_profiles (
         profile_id, schema_version, provider_kind, plugin_schema_version,
         release_digest, configuration_json, capabilities_json, status,
         created_at, activated_at, retired_at
       ) VALUES (?, '1', ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT DO NOTHING`,
    ).bind(
      profile.profileId,
      profile.kind,
      profile.pluginSchemaVersion,
      profile.releaseDigest,
      JSON.stringify(profile.configuration),
      JSON.stringify(capabilities),
      status,
      nowIso,
      status === 'active' ? nowIso : null,
    ).run();
    const persisted = await this.profileRow(profile.profileId);
    const [expectedDigest, actualDigest, expectedCapabilitiesDigest, actualCapabilitiesDigest] =
      await Promise.all([
        canonicalSha256(profile),
        canonicalSha256(profileFromRow(persisted)),
        canonicalSha256(capabilities),
        canonicalSha256(parseJsonRecord(persisted.capabilities_json)),
      ]);
    if (
      expectedDigest !== actualDigest ||
      expectedCapabilitiesDigest !== actualCapabilitiesDigest ||
      persisted.status !== status
    ) {
      throw new ExecutorControlError('profile_conflict');
    }
    return { created: inserted.meta.changes === 1, capabilities };
  }

  async installRoute(input: InstallExecutorRouteInput, now = new Date()): Promise<void> {
    if (
      !ID_PATTERN.test(input.routeId) ||
      !REPOSITORY_PATTERN.test(input.repository) ||
      !ID_PATTERN.test(input.profileId) ||
      !Number.isSafeInteger(input.routeVersion) ||
      input.routeVersion <= 0
    ) {
      throw new ExecutorControlError('route_conflict');
    }
    const nowIso = now.toISOString();
    await this.db.batch([
      this.db.prepare(
        `UPDATE executor_routes
         SET status = 'disabled', updated_at = ?
         WHERE repository = ? AND attempt_mode = ? AND execution_role = ?
           AND status = 'active' AND route_version < ?`,
      ).bind(
        nowIso,
        input.repository,
        input.attemptMode,
        input.executionRole,
        input.routeVersion,
      ),
      this.db.prepare(
        `INSERT INTO executor_routes (
           route_id, repository, attempt_mode, execution_role, profile_id,
           route_version, status, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, 'active', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM executor_profiles
           WHERE profile_id = ? AND status = 'active'
         )
         ON CONFLICT DO NOTHING`,
      ).bind(
        input.routeId,
        input.repository,
        input.attemptMode,
        input.executionRole,
        input.profileId,
        input.routeVersion,
        nowIso,
        nowIso,
        input.profileId,
      ),
    ]);
    const route = await this.activeRoute(
      input.repository,
      input.attemptMode,
      input.executionRole,
    );
    if (
      route.route_id !== input.routeId ||
      route.profile_id !== input.profileId ||
      route.route_version !== input.routeVersion
    ) {
      throw new ExecutorControlError('route_conflict');
    }
  }

  async freezeExecution(input: FreezeExecutionInput): Promise<FrozenExecutionInstance> {
    assertFrozenExecutionSpec(input.spec);
    if (
      !Number.isSafeInteger(input.expectedAttemptVersion) ||
      input.expectedAttemptVersion < 0 ||
      !ID_PATTERN.test(input.outboxId)
    ) {
      throw new ExecutorControlError('execution_conflict');
    }
    const route = await this.activeRoute(
      input.spec.repository,
      input.spec.mode,
      input.spec.role,
    );
    if (route.profile_id !== input.spec.profile.profileId) {
      throw new ExecutorControlError('route_conflict');
    }
    const persistedProfile = await this.profileRow(route.profile_id);
    if (persistedProfile.status !== 'active') {
      throw new ExecutorControlError('route_conflict');
    }
    const [expectedProfileDigest, persistedProfileDigest] = await Promise.all([
      canonicalSha256(input.spec.profile),
      canonicalSha256(profileFromRow(persistedProfile)),
    ]);
    if (expectedProfileDigest !== persistedProfileDigest) {
      throw new ExecutorControlError('profile_conflict');
    }
    const specDigest = await canonicalSha256(input.spec);
    const specJson = JSON.stringify(input.spec);
    const nowIso = (input.now ?? new Date()).toISOString();
    const batchResults = await this.db.batch([
      this.db.prepare(
        `UPDATE attempts
         SET executor_profile_id = ?, executor_route_version = ?, updated_at = ?
         WHERE attempt_id = ? AND repository = ? AND mode = ?
           AND status = 'pending' AND version = ?
           AND lease_generation + 1 = ?
           AND executor_profile_id IS NULL AND executor_route_version IS NULL
           AND EXISTS (
             SELECT 1 FROM executor_routes
             WHERE route_id = ? AND profile_id = ? AND route_version = ?
               AND repository = ? AND attempt_mode = ? AND execution_role = ?
               AND status = 'active'
           )`,
      ).bind(
        route.profile_id,
        route.route_version,
        nowIso,
        input.spec.attemptId,
        input.spec.repository,
        input.spec.mode,
        input.expectedAttemptVersion,
        input.spec.leaseGeneration,
        route.route_id,
        route.profile_id,
        route.route_version,
        input.spec.repository,
        input.spec.mode,
        input.spec.role,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, ?, 'agent_execution_start', 'agent_executor', ?, ?,
                'pending', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM attempts
           WHERE attempt_id = ? AND run_id = ?
             AND executor_profile_id = ? AND executor_route_version = ?
         )
         ON CONFLICT DO NOTHING`,
      ).bind(
        input.outboxId,
        input.spec.runId,
        `d1://attempt-executions/${input.spec.executionId}`,
        `agent-executor:${input.spec.executionId}`,
        nowIso,
        nowIso,
        input.spec.attemptId,
        input.spec.runId,
        route.profile_id,
        route.route_version,
      ),
      this.db.prepare(
        `INSERT INTO attempt_execution_instances (
           execution_id, attempt_id, attempt_version, lease_generation, execution_role,
           executor_profile_id, executor_route_version, spec_digest, spec_json,
           release_digest, provider_kind, plugin_schema_version, status,
           provider_external_id, validated_handle_json, outbox_id,
           created_at, started_at, terminal_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
                NULL, NULL, ?, ?, NULL, NULL, ?
         WHERE EXISTS (
           SELECT 1 FROM outbox
           WHERE outbox_id = ? AND run_id = ? AND destination = 'agent_executor'
             AND payload_ref = ?
         )
         ON CONFLICT DO NOTHING`,
      ).bind(
        input.spec.executionId,
        input.spec.attemptId,
        input.expectedAttemptVersion,
        input.spec.leaseGeneration,
        input.spec.role,
        route.profile_id,
        route.route_version,
        specDigest,
        specJson,
        input.spec.profile.releaseDigest,
        input.spec.profile.kind,
        input.spec.profile.pluginSchemaVersion,
        input.outboxId,
        nowIso,
        nowIso,
        input.outboxId,
        input.spec.runId,
        `d1://attempt-executions/${input.spec.executionId}`,
      ),
    ]);
    const persisted = await this.db.prepare(
      `SELECT execution_id, attempt_id, lease_generation, execution_role,
              executor_profile_id, executor_route_version, spec_digest,
              status, outbox_id
       FROM attempt_execution_instances WHERE execution_id = ?`,
    ).bind(input.spec.executionId).first<{
      execution_id: string;
      attempt_id: string;
      lease_generation: number;
      execution_role: 'work' | 'publisher';
      executor_profile_id: string;
      executor_route_version: number;
      spec_digest: string;
      status: string;
      outbox_id: string;
    }>();
    if (persisted === null) throw new ExecutorControlError('attempt_binding_conflict');
    const matches =
      persisted.attempt_id === input.spec.attemptId &&
      persisted.lease_generation === input.spec.leaseGeneration &&
      persisted.execution_role === input.spec.role &&
      persisted.executor_profile_id === route.profile_id &&
      persisted.executor_route_version === route.route_version &&
      persisted.spec_digest === specDigest &&
      persisted.outbox_id === input.outboxId;
    if (!matches) throw new ExecutorControlError('execution_conflict');
    return {
      executionId: persisted.execution_id,
      attemptId: persisted.attempt_id,
      leaseGeneration: persisted.lease_generation,
      executionRole: persisted.execution_role,
      profileId: persisted.executor_profile_id,
      routeVersion: persisted.executor_route_version,
      specDigest: persisted.spec_digest,
      status: persisted.status,
      outboxId: persisted.outbox_id,
      created: batchResults[2]?.meta.changes === 1,
    };
  }

  private async profileRow(profileId: string): Promise<ExecutorProfileRow> {
    const row = await this.db.prepare(
      `SELECT profile_id, schema_version, provider_kind, plugin_schema_version,
              release_digest, configuration_json, capabilities_json, status
       FROM executor_profiles WHERE profile_id = ?`,
    ).bind(profileId).first<ExecutorProfileRow>();
    if (row === null) throw new ExecutorControlError('profile_conflict');
    return row;
  }

  private async activeRoute(
    repository: string,
    attemptMode: 'analysis' | 'implement' | 'review_fix',
    executionRole: 'work' | 'publisher',
  ): Promise<ExecutorRouteRow> {
    const row = await this.db.prepare(
      `SELECT route_id, profile_id, route_version
       FROM executor_routes
       WHERE repository = ? AND attempt_mode = ? AND execution_role = ?
         AND status = 'active'`,
    ).bind(repository, attemptMode, executionRole).first<ExecutorRouteRow>();
    if (row === null) throw new ExecutorControlError('route_not_found');
    return row;
  }
}
