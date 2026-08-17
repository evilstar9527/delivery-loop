import { canonicalSha256 } from '../domain/digest.js';
import { githubAgentExecutorBinding } from '../domain/github-agent-executor.js';
import {
  assertExecutorProfile,
  assertFrozenExecutionSpec,
} from '../executor/core/executor-registry.js';
import type {
  ExecutorMode,
  ExecutorProfile,
  FrozenExecutionSpec,
} from '../executor/core/executor-plugin.js';
import { ExecutorControlError } from './executor-control-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

interface ActiveRouteProfileRow {
  route_id: string;
  route_version: number;
  profile_id: string;
  schema_version: '1';
  provider_kind: string;
  plugin_schema_version: string;
  release_digest: string;
  configuration_json: string;
  profile_status: 'active';
}

export interface AttemptExecutionRoutingOptions {
  controlPlaneUrl: string;
  modelProfileId?: string;
}

export interface RouteAttemptExecutionInput {
  runId: string;
  attemptId: string;
  mode: ExecutorMode;
  taskDigest: string;
  repository: string;
  baseSha: string;
  checkoutSha: string;
  targetBaseBranch: string;
  planVersion?: number;
  planItemId?: string;
  dispatchGeneration?: 0 | 1;
  attemptVersion?: number;
  leaseGeneration?: number;
}

export interface RoutedAttemptExecution {
  routeId: string;
  routeVersion: number;
  profileId: string;
  executionId: string;
  outboxId: string;
  attemptVersion: number;
  attemptWorkflowRef: string | null;
  spec: FrozenExecutionSpec;
  specDigest: string;
  specJson: string;
}

function attemptWorkflowRef(profile: ExecutorProfile): string | null {
  if (profile.kind !== 'github_actions') return null;
  const repository = profile.configuration.executorRepository;
  const ref = profile.configuration.executorRef;
  if (typeof repository !== 'string' || typeof ref !== 'string') {
    throw new ExecutorControlError('profile_conflict');
  }
  try {
    return githubAgentExecutorBinding(repository, ref).workflowRef;
  } catch {
    throw new ExecutorControlError('profile_conflict');
  }
}

function profileFromRow(row: ActiveRouteProfileRow): ExecutorProfile {
  let configuration: unknown;
  try {
    configuration = JSON.parse(row.configuration_json) as unknown;
  } catch {
    throw new ExecutorControlError('profile_conflict');
  }
  if (
    typeof configuration !== 'object' ||
    configuration === null ||
    Array.isArray(configuration)
  ) {
    throw new ExecutorControlError('profile_conflict');
  }
  const profile: ExecutorProfile = {
    schemaVersion: row.schema_version,
    profileId: row.profile_id,
    kind: row.provider_kind,
    pluginSchemaVersion: row.plugin_schema_version,
    releaseDigest: row.release_digest,
    configuration: configuration as Record<string, string | number | boolean>,
  };
  try {
    assertExecutorProfile(profile);
  } catch {
    throw new ExecutorControlError('profile_conflict');
  }
  return profile;
}

function controlPlaneOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExecutorControlError('execution_conflict');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/'
  ) {
    throw new ExecutorControlError('execution_conflict');
  }
  return url.origin;
}

/** Resolves a new Attempt through the active provider-neutral work route. */
export class AttemptExecutionRouter {
  private readonly controlPlaneUrl: string;
  private readonly modelProfileId: string | undefined;

  constructor(
    private readonly db: D1Database,
    options: AttemptExecutionRoutingOptions,
  ) {
    this.controlPlaneUrl = controlPlaneOrigin(options.controlPlaneUrl);
    if (
      options.modelProfileId !== undefined &&
      !ID_PATTERN.test(options.modelProfileId)
    ) {
      throw new ExecutorControlError('execution_conflict');
    }
    this.modelProfileId = options.modelProfileId;
  }

  async route(input: RouteAttemptExecutionInput): Promise<RoutedAttemptExecution> {
    const row = await this.db.prepare(
      `SELECT routes.route_id, routes.route_version, profiles.profile_id,
              profiles.schema_version, profiles.provider_kind,
              profiles.plugin_schema_version, profiles.release_digest,
              profiles.configuration_json, profiles.status AS profile_status
       FROM executor_routes AS routes
       JOIN executor_profiles AS profiles ON profiles.profile_id = routes.profile_id
       WHERE routes.repository = ? AND routes.attempt_mode = ?
         AND routes.execution_role = 'work' AND routes.status = 'active'
         AND profiles.status = 'active'`,
    ).bind(input.repository, input.mode).first<ActiveRouteProfileRow>();
    if (row === null) throw new ExecutorControlError('route_not_found');

    return await this.routedFromRow(input, row);
  }

  async resumeFrozen(
    input: RouteAttemptExecutionInput,
    profileId: string,
    routeVersion: number,
  ): Promise<RoutedAttemptExecution> {
    const row = await this.db.prepare(
      `SELECT routes.route_id, routes.route_version, profiles.profile_id,
              profiles.schema_version, profiles.provider_kind,
              profiles.plugin_schema_version, profiles.release_digest,
              profiles.configuration_json, profiles.status AS profile_status
       FROM executor_routes AS routes
       JOIN executor_profiles AS profiles ON profiles.profile_id = routes.profile_id
       WHERE routes.repository = ? AND routes.attempt_mode = ?
         AND routes.execution_role = 'work' AND routes.profile_id = ?
         AND routes.route_version = ? AND routes.status IN ('active', 'disabled')
         AND profiles.status IN ('active', 'retired')`,
    ).bind(
      input.repository,
      input.mode,
      profileId,
      routeVersion,
    ).first<ActiveRouteProfileRow>();
    if (row === null) throw new ExecutorControlError('route_not_found');
    return await this.routedFromRow(input, row);
  }

  private async routedFromRow(
    input: RouteAttemptExecutionInput,
    row: ActiveRouteProfileRow,
  ): Promise<RoutedAttemptExecution> {

    const profile = profileFromRow(row);
    const attemptVersion = input.attemptVersion ?? 0;
    const leaseGeneration = input.leaseGeneration ?? 1;
    if (
      !Number.isSafeInteger(attemptVersion) || attemptVersion < 0 ||
      !Number.isSafeInteger(leaseGeneration) || leaseGeneration <= 0
    ) {
      throw new ExecutorControlError('execution_conflict');
    }
    const suffix = leaseGeneration === 1 ? '' : `-g${leaseGeneration}`;
    const executionId = `execution-work-${input.attemptId}${suffix}`;
    const outboxId = `outbox-agent-${input.attemptId}${suffix}`;
    const spec: FrozenExecutionSpec = {
      schemaVersion: '1',
      executionId,
      runId: input.runId,
      attemptId: input.attemptId,
      leaseGeneration,
      role: 'work',
      mode: input.mode,
      profile,
      taskDigest: input.taskDigest,
      repository: input.repository,
      baseSha: input.baseSha,
      checkoutSha: input.checkoutSha,
      targetBaseBranch: input.targetBaseBranch,
      controlPlaneUrl: this.controlPlaneUrl,
      ...(input.planVersion === undefined ? {} : { planVersion: input.planVersion }),
      ...(input.planItemId === undefined ? {} : { planItemId: input.planItemId }),
      ...(this.modelProfileId === undefined
        ? {}
        : { modelProfileId: this.modelProfileId }),
      ...(input.dispatchGeneration === undefined
        ? { dispatchGeneration: 0 as const }
        : { dispatchGeneration: input.dispatchGeneration }),
    };
    try {
      assertFrozenExecutionSpec(spec);
    } catch {
      throw new ExecutorControlError('execution_conflict');
    }
    return {
      routeId: row.route_id,
      routeVersion: row.route_version,
      profileId: row.profile_id,
      executionId,
      outboxId,
      attemptVersion,
      attemptWorkflowRef: attemptWorkflowRef(profile),
      spec,
      specDigest: await canonicalSha256(spec),
      specJson: JSON.stringify(spec),
    };
  }

  persistenceStatements(
    routed: RoutedAttemptExecution,
    nowIso: string,
  ): [D1PreparedStatement, D1PreparedStatement] {
    const payloadRef = `d1://attempt-executions/${routed.executionId}`;
    return [
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, attempts.run_id, 'agent_execution_start', 'agent_executor', ?, ?,
                'pending', ?, ?
         FROM attempts
         WHERE attempts.attempt_id = ? AND attempts.run_id = ?
           AND attempts.status = 'pending' AND attempts.version = ?
           AND attempts.lease_generation + 1 = ?
           AND attempts.executor_profile_id = ?
           AND attempts.executor_route_version = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        routed.outboxId,
        payloadRef,
        `agent-executor:${routed.executionId}`,
        nowIso,
        nowIso,
        routed.spec.attemptId,
        routed.spec.runId,
        routed.attemptVersion,
        routed.spec.leaseGeneration,
        routed.profileId,
        routed.routeVersion,
      ),
      this.db.prepare(
        `INSERT INTO attempt_execution_instances (
           execution_id, attempt_id, attempt_version, lease_generation, execution_role,
           executor_profile_id, executor_route_version, spec_digest, spec_json,
           release_digest, provider_kind, plugin_schema_version, status,
           provider_external_id, validated_handle_json, outbox_id,
           created_at, started_at, terminal_at, updated_at
         )
         SELECT ?, attempts.attempt_id, attempts.version, ?, 'work',
                ?, ?, ?, ?, ?, ?, ?, 'pending',
                NULL, NULL, ?, ?, NULL, NULL, ?
         FROM attempts
         JOIN outbox ON outbox.outbox_id = ?
         WHERE attempts.attempt_id = ? AND attempts.run_id = ?
           AND attempts.status = 'pending' AND attempts.version = ?
           AND attempts.lease_generation + 1 = ?
           AND attempts.executor_profile_id = ?
           AND attempts.executor_route_version = ?
           AND outbox.run_id = attempts.run_id
           AND outbox.destination = 'agent_executor' AND outbox.payload_ref = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        routed.executionId,
        routed.spec.leaseGeneration,
        routed.profileId,
        routed.routeVersion,
        routed.specDigest,
        routed.specJson,
        routed.spec.profile.releaseDigest,
        routed.spec.profile.kind,
        routed.spec.profile.pluginSchemaVersion,
        routed.outboxId,
        nowIso,
        nowIso,
        routed.outboxId,
        routed.spec.attemptId,
        routed.spec.runId,
        routed.attemptVersion,
        routed.spec.leaseGeneration,
        routed.profileId,
        routed.routeVersion,
        payloadRef,
      ),
    ];
  }
}
