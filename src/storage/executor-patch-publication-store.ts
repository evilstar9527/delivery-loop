import { canonicalSha256 } from '../domain/digest.js';
import {
  assertFrozenExecutionSpec,
  type ExecutorPluginRegistry,
} from '../executor/core/executor-registry.js';
import type {
  ExecutorProfile,
  FrozenExecutionSpec,
} from '../executor/core/executor-plugin.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class ExecutorPatchPublicationError extends Error {
  constructor(readonly code:
    | 'patch_invalid'
    | 'work_binding_conflict'
    | 'publisher_route_unavailable'
    | 'publication_conflict') {
    super(`Executor patch publication failed: ${code}`);
    this.name = 'ExecutorPatchPublicationError';
  }
}

export interface RecordExecutorPatchInput {
  patchId: string;
  workExecutionId: string;
  attemptId: string;
  leaseGeneration: number;
  repository: string;
  baseSha: string;
  checkoutSha: string;
  patchDigest: string;
  changedPathsDigest: string;
  patchRef: string;
  byteLength: number;
  now?: Date;
}

export interface SchedulePublisherInput {
  publicationId: string;
  spec: FrozenExecutionSpec;
  expectedAttemptVersion: number;
  targetBranch: string;
  outboxId: string;
  now?: Date;
}

export interface RecordAndScheduleExecutorPatchResult {
  created: boolean;
  publicationId: string;
  publisherExecutionId: string;
  publisherOutboxId: string;
  targetBranch: string;
}

interface PatchRow {
  patch_id: string;
  work_execution_id: string;
  attempt_id: string;
  lease_generation: number;
  repository: string;
  base_sha: string;
  checkout_sha: string;
  patch_digest: string;
  changed_paths_digest: string;
  patch_ref: string;
  byte_length: number;
  status: string;
}

interface WorkBindingRow {
  execution_role: string;
  execution_status: string;
  spec_json: string;
  attempt_status: string;
  attempt_lease_generation: number;
  attempt_version: number;
  attempt_mode: 'implement' | 'review_fix';
  task_id: string;
  human_review_branch: string | null;
  automated_review_branch: string | null;
}

interface PublisherRouteRow {
  route_id: string;
  profile_id: string;
  route_version: number;
  schema_version: '1';
  provider_kind: string;
  plugin_schema_version: string;
  release_digest: string;
  configuration_json: string;
}

interface ScheduledPublicationRow {
  publication_id: string;
  patch_id: string;
  publisher_execution_id: string;
  publication_attempt_id: string;
  publication_lease_generation: number;
  publication_repository: string;
  target_branch: string;
  expected_patch_digest: string;
  patch_attempt_id: string;
  patch_lease_generation: number;
  patch_repository: string;
  patch_base_sha: string;
  patch_checkout_sha: string;
  patch_digest: string;
  patch_work_execution_id: string;
  patch_changed_paths_digest: string;
  patch_ref: string;
  patch_byte_length: number;
  execution_attempt_id: string;
  attempt_version: number;
  execution_lease_generation: number;
  execution_role: string;
  executor_profile_id: string;
  spec_digest: string;
  release_digest: string;
  provider_kind: string;
  plugin_schema_version: string;
  outbox_id: string;
  outbox_run_id: string;
  outbox_kind: string;
  destination: string;
  payload_ref: string;
  dedupe_key: string;
}

function profileFromRoute(route: PublisherRouteRow): ExecutorProfile {
  let configuration: unknown;
  try {
    configuration = JSON.parse(route.configuration_json) as unknown;
  } catch {
    throw new ExecutorPatchPublicationError('publication_conflict');
  }
  if (typeof configuration !== 'object' || configuration === null || Array.isArray(configuration)) {
    throw new ExecutorPatchPublicationError('publication_conflict');
  }
  return {
    schemaVersion: route.schema_version,
    profileId: route.profile_id,
    kind: route.provider_kind,
    pluginSchemaVersion: route.plugin_schema_version,
    releaseDigest: route.release_digest,
    configuration: configuration as Record<string, string | number | boolean>,
  };
}

function safeBranch(value: string): boolean {
  if (
    value.length < 1 || value.length > 240 || value.startsWith('/') ||
    value.endsWith('/') || value.startsWith('.') || value.endsWith('.') ||
    value.includes('..') || value.includes('@{') || value.includes('\\') ||
    value.includes('[') || /[\0-\x20~^:?*]/.test(value)
  ) return false;
  return value.split('/').every(
    (segment) => segment.length > 0 && segment !== '.' && segment !== '..' &&
      !segment.endsWith('.lock'),
  );
}

/** Immutable patch handoff between credential-free work and clean publisher roles. */
export class ExecutorPatchPublicationStore {
  constructor(
    private readonly db: D1Database,
    private readonly registry: ExecutorPluginRegistry,
  ) {}

  async recordWorkPatchAndSchedulePublisher(
    input: RecordExecutorPatchInput,
  ): Promise<RecordAndScheduleExecutorPatchResult> {
    const binding = await this.authorizedWorkBinding(input);
    const workSpec = this.workSpec(binding);
    const targetBranch = this.targetBranch(binding, input.attemptId);
    const identity = await canonicalSha256({
      schemaVersion: '1',
      patchId: input.patchId,
      role: 'publisher',
    });
    const suffix = identity.slice('sha256:'.length, 'sha256:'.length + 40);
    const publicationId = `patch-publication-${suffix}`;
    const publisherExecutionId = `execution-publisher-${suffix}`;
    const publisherOutboxId = `outbox-publisher-${suffix}`;
    const existing = await this.automaticPublicationResult({
      input,
      publicationId,
      publisherExecutionId,
      publisherOutboxId,
      targetBranch,
    });
    if (existing !== null) return existing;

    const route = await this.publisherRoute(
      workSpec.repository,
      binding.attempt_mode,
      input.attemptId,
      binding.attempt_version,
      input.leaseGeneration,
    );
    const profile = profileFromRoute(route);
    let supportsPublisherRole = false;
    try {
      supportsPublisherRole = this.registry.resolve(profile).capabilities(profile)
        .supportsPublisherRole;
    } catch {
      throw new ExecutorPatchPublicationError('publication_conflict');
    }
    if (!supportsPublisherRole) {
      throw new ExecutorPatchPublicationError('publisher_route_unavailable');
    }
    const publisherSpec: FrozenExecutionSpec = {
      ...workSpec,
      executionId: publisherExecutionId,
      role: 'publisher',
      profile,
      patchArtifactId: input.patchId,
    };
    try {
      assertFrozenExecutionSpec(publisherSpec);
    } catch {
      throw new ExecutorPatchPublicationError('publication_conflict');
    }
    const specDigest = await canonicalSha256(publisherSpec);
    const nowIso = (input.now ?? new Date()).toISOString();
    try {
      await this.db.batch([
        this.patchInsert(input, nowIso),
        this.db.prepare(
          `INSERT INTO outbox (
             outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
             delivery_state, created_at, updated_at
           ) VALUES (?, ?, 'agent_execution_start', 'agent_executor', ?, ?, 'pending', ?, ?)`,
        ).bind(
          publisherOutboxId,
          publisherSpec.runId,
          `d1://attempt-executions/${publisherExecutionId}`,
          `agent-executor:${publisherExecutionId}`,
          nowIso,
          nowIso,
        ),
        this.db.prepare(
          `INSERT INTO attempt_execution_instances (
             execution_id, attempt_id, attempt_version, lease_generation, execution_role,
             executor_profile_id, executor_route_version, spec_digest, spec_json,
             release_digest, provider_kind, plugin_schema_version, status,
             provider_external_id, validated_handle_json, outbox_id,
             created_at, started_at, terminal_at, updated_at
           ) VALUES (?, ?, ?, ?, 'publisher', ?, ?, ?, ?, ?, ?, ?, 'pending',
                     NULL, NULL, ?, ?, NULL, NULL, ?)`,
        ).bind(
          publisherExecutionId,
          publisherSpec.attemptId,
          binding.attempt_version,
          publisherSpec.leaseGeneration,
          profile.profileId,
          route.route_version,
          specDigest,
          JSON.stringify(publisherSpec),
          profile.releaseDigest,
          profile.kind,
          profile.pluginSchemaVersion,
          publisherOutboxId,
          nowIso,
          nowIso,
        ),
        this.db.prepare(
          `INSERT INTO executor_patch_publications (
             publication_id, patch_id, publisher_execution_id, attempt_id,
             lease_generation, repository, target_branch, expected_patch_digest,
             status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        ).bind(
          publicationId,
          input.patchId,
          publisherExecutionId,
          input.attemptId,
          input.leaseGeneration,
          input.repository,
          targetBranch,
          input.patchDigest,
          nowIso,
        ),
      ]);
    } catch {
      const converged = await this.automaticPublicationResult({
        input,
        publicationId,
        publisherExecutionId,
        publisherOutboxId,
        targetBranch,
      });
      if (converged !== null) return converged;
      throw new ExecutorPatchPublicationError('publication_conflict');
    }
    const created = await this.automaticPublicationResult({
      input,
      publicationId,
      publisherExecutionId,
      publisherOutboxId,
      targetBranch,
    });
    if (created === null) throw new ExecutorPatchPublicationError('publication_conflict');
    return { ...created, created: true };
  }

  async recordWorkPatch(input: RecordExecutorPatchInput): Promise<{ created: boolean }> {
    await this.authorizedWorkBinding(input);
    const nowIso = (input.now ?? new Date()).toISOString();
    const inserted = await this.patchInsert(input, nowIso, true).run();
    const persisted = await this.patch(input.patchId);
    if (await canonicalSha256({
      patch_id: persisted.patch_id,
      work_execution_id: persisted.work_execution_id,
      attempt_id: persisted.attempt_id,
      lease_generation: persisted.lease_generation,
      repository: persisted.repository,
      base_sha: persisted.base_sha,
      checkout_sha: persisted.checkout_sha,
      patch_digest: persisted.patch_digest,
      changed_paths_digest: persisted.changed_paths_digest,
      patch_ref: persisted.patch_ref,
      byte_length: persisted.byte_length,
    }) !== await canonicalSha256({
      patch_id: input.patchId,
      work_execution_id: input.workExecutionId,
      attempt_id: input.attemptId,
      lease_generation: input.leaseGeneration,
      repository: input.repository,
      base_sha: input.baseSha,
      checkout_sha: input.checkoutSha,
      patch_digest: input.patchDigest,
      changed_paths_digest: input.changedPathsDigest,
      patch_ref: input.patchRef,
      byte_length: input.byteLength,
    })) throw new ExecutorPatchPublicationError('patch_invalid');
    return { created: inserted.meta.changes === 1 };
  }

  private patchInsert(
    input: RecordExecutorPatchInput,
    nowIso: string,
    ignoreConflict = false,
  ): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO executor_patch_artifacts (
         patch_id, work_execution_id, attempt_id, lease_generation, repository,
         base_sha, checkout_sha, patch_digest, changed_paths_digest, patch_ref,
         byte_length, status, created_at, published_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, NULL)
       ${ignoreConflict ? 'ON CONFLICT DO NOTHING' : ''}`,
    ).bind(
      input.patchId,
      input.workExecutionId,
      input.attemptId,
      input.leaseGeneration,
      input.repository,
      input.baseSha,
      input.checkoutSha,
      input.patchDigest,
      input.changedPathsDigest,
      input.patchRef,
      input.byteLength,
      nowIso,
    );
  }

  private async authorizedWorkBinding(input: RecordExecutorPatchInput): Promise<WorkBindingRow> {
    if (
      !ID_PATTERN.test(input.patchId) || !ID_PATTERN.test(input.workExecutionId) ||
      !ID_PATTERN.test(input.attemptId) || !Number.isSafeInteger(input.leaseGeneration) ||
      input.leaseGeneration <= 0 || !REPOSITORY_PATTERN.test(input.repository) ||
      !SHA_PATTERN.test(input.baseSha) || !SHA_PATTERN.test(input.checkoutSha) ||
      !DIGEST_PATTERN.test(input.patchDigest) || !DIGEST_PATTERN.test(input.changedPathsDigest) ||
      input.patchRef !== `r2://executor-patches/${input.patchId}` ||
      !Number.isSafeInteger(input.byteLength) || input.byteLength < 1 ||
      input.byteLength > 1024 * 1024
    ) throw new ExecutorPatchPublicationError('patch_invalid');
    const binding = await this.db.prepare(
      `SELECT execution.execution_role, execution.status AS execution_status,
              execution.spec_json, attempts.status AS attempt_status,
              attempts.lease_generation AS attempt_lease_generation,
              attempts.version AS attempt_version, attempts.mode AS attempt_mode,
              tasks.task_id,
              (
                SELECT feedback.branch
                FROM review_feedback_attempts AS lineage
                JOIN github_review_feedbacks AS feedback
                  ON feedback.feedback_id = lineage.feedback_id
                WHERE lineage.review_attempt_id =
                      COALESCE(attempts.recovered_from_attempt_id, attempts.attempt_id)
                  AND feedback.run_id = attempts.run_id
                  AND feedback.plan_id = attempts.plan_id
                  AND feedback.plan_version = attempts.plan_version
                  AND feedback.plan_item_id = attempts.plan_item_id
                  AND lineage.source_head_sha = feedback.source_head_sha
                  AND lineage.branch = feedback.branch
                LIMIT 1
              ) AS human_review_branch,
              (
                SELECT reviews.branch
                FROM automated_review_fix_attempts AS fixes
                JOIN automated_reviews AS reviews ON reviews.review_id = fixes.review_id
                WHERE fixes.fix_attempt_id =
                      COALESCE(attempts.recovered_from_attempt_id, attempts.attempt_id)
                  AND reviews.run_id = attempts.run_id
                  AND reviews.plan_id = attempts.plan_id
                  AND reviews.plan_version = attempts.plan_version
                  AND reviews.plan_item_id = attempts.plan_item_id
                  AND reviews.status = 'changes_requested'
                LIMIT 1
              ) AS automated_review_branch
       FROM attempt_execution_instances AS execution
       JOIN attempts ON attempts.attempt_id = execution.attempt_id
       JOIN runs ON runs.run_id = attempts.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       WHERE execution.execution_id = ? AND execution.attempt_id = ?
         AND execution.lease_generation = ?`,
    ).bind(
      input.workExecutionId,
      input.attemptId,
      input.leaseGeneration,
    ).first<WorkBindingRow>();
    if (binding === null) throw new ExecutorPatchPublicationError('work_binding_conflict');
    const spec = this.workSpec(binding);
    if (
      binding.execution_role !== 'work' ||
      !['starting', 'running'].includes(binding.execution_status) ||
      binding.attempt_status !== 'running' ||
      binding.attempt_lease_generation !== input.leaseGeneration ||
      spec.executionId !== input.workExecutionId || spec.attemptId !== input.attemptId ||
      spec.role !== 'work' || spec.repository !== input.repository ||
      spec.baseSha !== input.baseSha || spec.checkoutSha !== input.checkoutSha ||
      spec.mode !== binding.attempt_mode
    ) throw new ExecutorPatchPublicationError('work_binding_conflict');
    this.targetBranch(binding, input.attemptId);
    return binding;
  }

  private workSpec(binding: WorkBindingRow | null): FrozenExecutionSpec {
    let spec: FrozenExecutionSpec;
    try {
      spec = JSON.parse(binding?.spec_json ?? '') as FrozenExecutionSpec;
      assertFrozenExecutionSpec(spec);
    } catch {
      throw new ExecutorPatchPublicationError('work_binding_conflict');
    }
    return spec;
  }

  private targetBranch(binding: WorkBindingRow, attemptId: string): string {
    if (
      binding.human_review_branch !== null && binding.automated_review_branch !== null
    ) throw new ExecutorPatchPublicationError('work_binding_conflict');
    const reviewBranch = binding.human_review_branch ?? binding.automated_review_branch;
    const targetBranch = reviewBranch ?? `agent/${binding.task_id}/${attemptId}`;
    if (!safeBranch(targetBranch)) {
      throw new ExecutorPatchPublicationError('work_binding_conflict');
    }
    return targetBranch;
  }

  private async publisherRoute(
    repository: string,
    mode: 'implement' | 'review_fix',
    attemptId: string,
    expectedAttemptVersion: number,
    leaseGeneration: number,
  ): Promise<PublisherRouteRow> {
    const route = await this.db.prepare(
      `SELECT routes.route_id, routes.profile_id, routes.route_version,
              profiles.schema_version, profiles.provider_kind,
              profiles.plugin_schema_version, profiles.release_digest,
              profiles.configuration_json
       FROM executor_routes AS routes
       JOIN executor_profiles AS profiles ON profiles.profile_id = routes.profile_id
       JOIN attempts ON attempts.attempt_id = ?
       WHERE routes.repository = ? AND routes.attempt_mode = ?
         AND routes.execution_role = 'publisher' AND routes.status = 'active'
         AND profiles.status = 'active'
         AND attempts.repository = routes.repository AND attempts.mode = routes.attempt_mode
         AND attempts.status = 'running' AND attempts.version = ?
         AND attempts.lease_generation = ?`,
    ).bind(
      attemptId,
      repository,
      mode,
      expectedAttemptVersion,
      leaseGeneration,
    ).first<PublisherRouteRow>();
    if (route === null) {
      throw new ExecutorPatchPublicationError('publisher_route_unavailable');
    }
    return route;
  }

  private async automaticPublicationResult(input: {
    input: RecordExecutorPatchInput;
    publicationId: string;
    publisherExecutionId: string;
    publisherOutboxId: string;
    targetBranch: string;
  }): Promise<RecordAndScheduleExecutorPatchResult | null> {
    const row = await this.db.prepare(
      `SELECT patch.patch_id, patch.work_execution_id, patch.attempt_id,
              patch.lease_generation, patch.repository, patch.base_sha,
              patch.checkout_sha, patch.patch_digest, patch.changed_paths_digest,
              patch.patch_ref, patch.byte_length,
              publication.publication_id, publication.publisher_execution_id,
              publication.target_branch, publication.expected_patch_digest,
              execution.execution_role, execution.attempt_id AS execution_attempt_id,
              execution.lease_generation AS execution_lease_generation,
              execution.spec_digest, execution.spec_json, execution.outbox_id,
              outbox.run_id, outbox.kind, outbox.destination,
              outbox.payload_ref, outbox.dedupe_key
       FROM executor_patch_artifacts AS patch
       JOIN executor_patch_publications AS publication ON publication.patch_id = patch.patch_id
       JOIN attempt_execution_instances AS execution
         ON execution.execution_id = publication.publisher_execution_id
       JOIN outbox ON outbox.outbox_id = execution.outbox_id
       WHERE patch.patch_id = ?`,
    ).bind(input.input.patchId).first<{
      patch_id: string;
      work_execution_id: string;
      attempt_id: string;
      lease_generation: number;
      repository: string;
      base_sha: string;
      checkout_sha: string;
      patch_digest: string;
      changed_paths_digest: string;
      patch_ref: string;
      byte_length: number;
      publication_id: string;
      publisher_execution_id: string;
      target_branch: string;
      expected_patch_digest: string;
      execution_role: string;
      execution_attempt_id: string;
      execution_lease_generation: number;
      spec_digest: string;
      spec_json: string;
      outbox_id: string;
      run_id: string;
      kind: string;
      destination: string;
      payload_ref: string;
      dedupe_key: string;
    }>();
    if (row === null) return null;
    const expected = input.input;
    let publisherSpec: FrozenExecutionSpec;
    try {
      publisherSpec = JSON.parse(row.spec_json) as FrozenExecutionSpec;
      assertFrozenExecutionSpec(publisherSpec);
    } catch {
      throw new ExecutorPatchPublicationError('publication_conflict');
    }
    if (
      row.work_execution_id !== expected.workExecutionId ||
      row.attempt_id !== expected.attemptId || row.lease_generation !== expected.leaseGeneration ||
      row.repository !== expected.repository || row.base_sha !== expected.baseSha ||
      row.checkout_sha !== expected.checkoutSha || row.patch_digest !== expected.patchDigest ||
      row.changed_paths_digest !== expected.changedPathsDigest || row.patch_ref !== expected.patchRef ||
      row.byte_length !== expected.byteLength || row.publication_id !== input.publicationId ||
      row.publisher_execution_id !== input.publisherExecutionId ||
      row.target_branch !== input.targetBranch || row.expected_patch_digest !== expected.patchDigest ||
      row.execution_role !== 'publisher' || row.outbox_id !== input.publisherOutboxId ||
      row.execution_attempt_id !== expected.attemptId ||
      row.execution_lease_generation !== expected.leaseGeneration ||
      publisherSpec.executionId !== input.publisherExecutionId ||
      publisherSpec.attemptId !== expected.attemptId ||
      publisherSpec.leaseGeneration !== expected.leaseGeneration ||
      publisherSpec.role !== 'publisher' || publisherSpec.patchArtifactId !== expected.patchId ||
      publisherSpec.repository !== expected.repository || publisherSpec.baseSha !== expected.baseSha ||
      publisherSpec.checkoutSha !== expected.checkoutSha ||
      row.spec_digest !== await canonicalSha256(publisherSpec) || row.run_id !== publisherSpec.runId ||
      row.kind !== 'agent_execution_start' || row.destination !== 'agent_executor' ||
      row.payload_ref !== `d1://attempt-executions/${input.publisherExecutionId}` ||
      row.dedupe_key !== `agent-executor:${input.publisherExecutionId}`
    ) throw new ExecutorPatchPublicationError('publication_conflict');
    return {
      created: false,
      publicationId: input.publicationId,
      publisherExecutionId: input.publisherExecutionId,
      publisherOutboxId: input.publisherOutboxId,
      targetBranch: input.targetBranch,
    };
  }

  async schedulePublisher(input: SchedulePublisherInput): Promise<{ created: boolean }> {
    try {
      assertFrozenExecutionSpec(input.spec);
    } catch {
      throw new ExecutorPatchPublicationError('publication_conflict');
    }
    if (
      input.spec.role !== 'publisher' || input.spec.patchArtifactId === undefined ||
      !ID_PATTERN.test(input.publicationId) || !ID_PATTERN.test(input.outboxId) ||
      !Number.isSafeInteger(input.expectedAttemptVersion) ||
      input.expectedAttemptVersion < 0 || !safeBranch(input.targetBranch)
    ) throw new ExecutorPatchPublicationError('publication_conflict');
    const specDigest = await canonicalSha256(input.spec);
    const existingMatches = await this.scheduledPublicationMatches(input, specDigest);
    if (existingMatches !== null) {
      if (!existingMatches) throw new ExecutorPatchPublicationError('publication_conflict');
      return { created: false };
    }
    const patch = await this.patch(input.spec.patchArtifactId);
    const route = await this.db.prepare(
      `SELECT routes.profile_id, routes.route_version, profiles.schema_version,
              profiles.provider_kind, profiles.plugin_schema_version,
              profiles.release_digest, profiles.configuration_json
       FROM executor_routes AS routes
       JOIN executor_profiles AS profiles ON profiles.profile_id = routes.profile_id
       JOIN attempts ON attempts.attempt_id = ?
       WHERE routes.repository = ? AND routes.attempt_mode = ?
         AND routes.execution_role = 'publisher' AND routes.status = 'active'
         AND profiles.status = 'active'
         AND attempts.run_id = ? AND attempts.repository = ? AND attempts.mode = ?
         AND attempts.status = 'running' AND attempts.version = ?
         AND attempts.lease_generation = ?`,
    ).bind(
      input.spec.attemptId,
      input.spec.repository,
      input.spec.mode,
      input.spec.runId,
      input.spec.repository,
      input.spec.mode,
      input.expectedAttemptVersion,
      input.spec.leaseGeneration,
    ).first<{
      profile_id: string;
      route_version: number;
      schema_version: '1';
      provider_kind: string;
      plugin_schema_version: string;
      release_digest: string;
      configuration_json: string;
    }>();
    if (route === null) throw new ExecutorPatchPublicationError('publisher_route_unavailable');
    let routeConfiguration: unknown;
    try {
      routeConfiguration = JSON.parse(route.configuration_json) as unknown;
    } catch {
      throw new ExecutorPatchPublicationError('publication_conflict');
    }
    const persistedProfileDigest = await canonicalSha256({
      schemaVersion: route.schema_version,
      profileId: route.profile_id,
      kind: route.provider_kind,
      pluginSchemaVersion: route.plugin_schema_version,
      releaseDigest: route.release_digest,
      configuration: routeConfiguration,
    });
    if (
      patch.status !== 'prepared' || patch.attempt_id !== input.spec.attemptId ||
      patch.lease_generation !== input.spec.leaseGeneration ||
      patch.repository !== input.spec.repository || patch.base_sha !== input.spec.baseSha ||
      patch.checkout_sha !== input.spec.checkoutSha ||
      route.profile_id !== input.spec.profile.profileId ||
      route.provider_kind !== input.spec.profile.kind ||
      route.plugin_schema_version !== input.spec.profile.pluginSchemaVersion ||
      route.release_digest !== input.spec.profile.releaseDigest ||
      persistedProfileDigest !== await canonicalSha256(input.spec.profile) ||
      !this.registry.resolve(input.spec.profile).capabilities(input.spec.profile)
        .supportsPublisherRole
    ) throw new ExecutorPatchPublicationError('publication_conflict');
    const nowIso = (input.now ?? new Date()).toISOString();
    try {
      await this.db.batch([
        this.db.prepare(
          `INSERT INTO outbox (
             outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
             delivery_state, created_at, updated_at
           ) VALUES (?, ?, 'agent_execution_start', 'agent_executor', ?, ?, 'pending', ?, ?)`,
        ).bind(
          input.outboxId, input.spec.runId,
          `d1://attempt-executions/${input.spec.executionId}`,
          `agent-executor:${input.spec.executionId}`, nowIso, nowIso,
        ),
        this.db.prepare(
          `INSERT INTO attempt_execution_instances (
             execution_id, attempt_id, attempt_version, lease_generation, execution_role,
             executor_profile_id, executor_route_version, spec_digest, spec_json,
             release_digest, provider_kind, plugin_schema_version, status,
             provider_external_id, validated_handle_json, outbox_id,
             created_at, started_at, terminal_at, updated_at
           ) VALUES (?, ?, ?, ?, 'publisher', ?, ?, ?, ?, ?, ?, ?, 'pending',
                     NULL, NULL, ?, ?, NULL, NULL, ?)`,
        ).bind(
          input.spec.executionId, input.spec.attemptId, input.expectedAttemptVersion,
          input.spec.leaseGeneration, route.profile_id, route.route_version, specDigest,
          JSON.stringify(input.spec), input.spec.profile.releaseDigest,
          input.spec.profile.kind, input.spec.profile.pluginSchemaVersion,
          input.outboxId, nowIso, nowIso,
        ),
        this.db.prepare(
          `INSERT INTO executor_patch_publications (
             publication_id, patch_id, publisher_execution_id, attempt_id,
             lease_generation, repository, target_branch, expected_patch_digest,
             status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        ).bind(
          input.publicationId, patch.patch_id, input.spec.executionId,
          input.spec.attemptId, input.spec.leaseGeneration, input.spec.repository,
          input.targetBranch, patch.patch_digest, nowIso,
        ),
      ]);
    } catch {
      if (await this.scheduledPublicationMatches(input, specDigest) === true) {
        return { created: false };
      }
      throw new ExecutorPatchPublicationError('publication_conflict');
    }
    if (await this.scheduledPublicationMatches(input, specDigest) !== true) {
      throw new ExecutorPatchPublicationError('publication_conflict');
    }
    return { created: true };
  }

  async completePublication(input: {
    publicationId: string;
    publisherExecutionId: string;
    recomputedPatchDigest: string;
    headSha: string;
    now?: Date;
  }): Promise<void> {
    if (
      !ID_PATTERN.test(input.publicationId) || !ID_PATTERN.test(input.publisherExecutionId) ||
      !DIGEST_PATTERN.test(input.recomputedPatchDigest) || !SHA_PATTERN.test(input.headSha)
    ) throw new ExecutorPatchPublicationError('publication_conflict');
    const existingMatches = await this.publicationCompletionMatches(input);
    if (existingMatches !== null) {
      if (!existingMatches) throw new ExecutorPatchPublicationError('publication_conflict');
      return;
    }
    const nowIso = (input.now ?? new Date()).toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE executor_patch_publications
         SET status = 'published', recomputed_patch_digest = ?, head_sha = ?, published_at = ?
         WHERE publication_id = ? AND publisher_execution_id = ? AND status = 'running'
           AND expected_patch_digest = ?`,
      ).bind(
        input.recomputedPatchDigest, input.headSha, nowIso, input.publicationId,
        input.publisherExecutionId, input.recomputedPatchDigest,
      ),
      this.db.prepare(
        `UPDATE executor_patch_artifacts SET status = 'published', published_at = ?
         WHERE patch_id = (
           SELECT patch_id FROM executor_patch_publications
           WHERE publication_id = ? AND status = 'published'
         ) AND status = 'prepared'`,
      ).bind(nowIso, input.publicationId),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      if (await this.publicationCompletionMatches(input) === true) return;
      throw new ExecutorPatchPublicationError('publication_conflict');
    }
    if (await this.publicationCompletionMatches(input) !== true) {
      throw new ExecutorPatchPublicationError('publication_conflict');
    }
  }

  async completeVerifiedPublication(input: {
    publicationId: string;
    publisherExecutionId: string;
    recomputedPatchDigest: string;
    headSha: string;
    branch: string;
    suiteId: string;
    evidenceIds: readonly string[];
    now?: Date;
  }): Promise<void> {
    if (
      !safeBranch(input.branch) || !ID_PATTERN.test(input.suiteId) ||
      input.evidenceIds.length < 2 || input.evidenceIds.length > 100 ||
      new Set(input.evidenceIds).size !== input.evidenceIds.length ||
      !input.evidenceIds.every((id) => ID_PATTERN.test(id))
    ) throw new ExecutorPatchPublicationError('publication_conflict');
    const row = await this.db.prepare(
      `SELECT publication.target_branch, publication.expected_patch_digest,
              publication.status AS publication_status,
              attempts.head_sha, attempts.head_branch,
              execution.status AS execution_status,
              suites.status AS suite_status, suites.head_sha AS suite_head_sha,
              suites.attempt_id AS suite_attempt_id,
              publication.attempt_id
       FROM executor_patch_publications AS publication
       JOIN attempt_execution_instances AS execution
         ON execution.execution_id = publication.publisher_execution_id
       JOIN attempts ON attempts.attempt_id = publication.attempt_id
       JOIN verification_suites AS suites ON suites.suite_id = ?
       WHERE publication.publication_id = ?
         AND publication.publisher_execution_id = ?`,
    ).bind(
      input.suiteId,
      input.publicationId,
      input.publisherExecutionId,
    ).first<{
      target_branch: string;
      expected_patch_digest: string;
      publication_status: string;
      head_sha: string | null;
      head_branch: string | null;
      execution_status: string;
      suite_status: string;
      suite_head_sha: string;
      suite_attempt_id: string;
      attempt_id: string;
    }>();
    if (
      row === null || !['running', 'published'].includes(row.publication_status) ||
      !['starting', 'running', 'succeeded'].includes(row.execution_status) ||
      row.target_branch !== input.branch || row.expected_patch_digest !== input.recomputedPatchDigest ||
      row.head_sha !== input.headSha || row.head_branch !== input.branch ||
      row.suite_status !== 'completed' || row.suite_head_sha !== input.headSha ||
      row.suite_attempt_id !== row.attempt_id
    ) throw new ExecutorPatchPublicationError('publication_conflict');
    const evidence = await this.db.prepare(
      `SELECT commands.evidence_id
       FROM verification_suite_commands AS commands
       JOIN evidence ON evidence.evidence_id = commands.evidence_id
       WHERE commands.suite_id = ? AND commands.result_status = 'passed'
         AND evidence.attempt_id = ? AND evidence.status = 'passed'
         AND evidence.sha = ?
       ORDER BY commands.position`,
    ).bind(input.suiteId, row.attempt_id, input.headSha).all<{ evidence_id: string }>();
    if (
      !evidence.success || evidence.results.length !== input.evidenceIds.length ||
      evidence.results.some((item, index) => item.evidence_id !== input.evidenceIds[index])
    ) throw new ExecutorPatchPublicationError('publication_conflict');
    await this.completePublication(input);
    const nowIso = (input.now ?? new Date()).toISOString();
    const terminal = await this.db.prepare(
      `UPDATE attempt_execution_instances
       SET status = 'succeeded', terminal_at = COALESCE(terminal_at, ?), updated_at = ?
       WHERE execution_id = ? AND execution_role = 'publisher'
         AND status IN ('starting', 'running', 'succeeded')`,
    ).bind(nowIso, nowIso, input.publisherExecutionId).run();
    if (terminal.meta.changes !== 1) {
      throw new ExecutorPatchPublicationError('publication_conflict');
    }
  }

  private async patch(patchId: string): Promise<PatchRow> {
    const row = await this.db.prepare(
      `SELECT patch_id, work_execution_id, attempt_id, lease_generation, repository,
              base_sha, checkout_sha, patch_digest, changed_paths_digest, patch_ref,
              byte_length, status
       FROM executor_patch_artifacts WHERE patch_id = ?`,
    ).bind(patchId).first<PatchRow>();
    if (row === null) throw new ExecutorPatchPublicationError('patch_invalid');
    return row;
  }

  private async scheduledPublicationMatches(
    input: SchedulePublisherInput,
    specDigest: string,
  ): Promise<boolean | null> {
    const row = await this.db.prepare(
      `SELECT publication.publication_id, publication.patch_id,
              publication.publisher_execution_id,
              publication.attempt_id AS publication_attempt_id,
              publication.lease_generation AS publication_lease_generation,
              publication.repository AS publication_repository,
              publication.target_branch, publication.expected_patch_digest,
              patch.attempt_id AS patch_attempt_id,
              patch.lease_generation AS patch_lease_generation,
              patch.repository AS patch_repository, patch.base_sha AS patch_base_sha,
              patch.checkout_sha AS patch_checkout_sha, patch.patch_digest,
              execution.attempt_id AS execution_attempt_id, execution.attempt_version,
              execution.lease_generation AS execution_lease_generation,
              execution.execution_role, execution.executor_profile_id,
              execution.spec_digest, execution.release_digest,
              execution.provider_kind, execution.plugin_schema_version,
              outbox.outbox_id, outbox.run_id AS outbox_run_id,
              outbox.kind AS outbox_kind, outbox.destination, outbox.payload_ref,
              outbox.dedupe_key
       FROM executor_patch_publications AS publication
       JOIN executor_patch_artifacts AS patch ON patch.patch_id = publication.patch_id
       JOIN attempt_execution_instances AS execution
         ON execution.execution_id = publication.publisher_execution_id
       JOIN outbox ON outbox.outbox_id = execution.outbox_id
       WHERE publication.publication_id = ?`,
    ).bind(input.publicationId).first<ScheduledPublicationRow>();
    if (row === null) return null;
    return row.patch_id === input.spec.patchArtifactId &&
      row.publisher_execution_id === input.spec.executionId &&
      row.publication_attempt_id === input.spec.attemptId &&
      row.publication_lease_generation === input.spec.leaseGeneration &&
      row.publication_repository === input.spec.repository &&
      row.target_branch === input.targetBranch &&
      row.expected_patch_digest === row.patch_digest &&
      row.patch_attempt_id === input.spec.attemptId &&
      row.patch_lease_generation === input.spec.leaseGeneration &&
      row.patch_repository === input.spec.repository &&
      row.patch_base_sha === input.spec.baseSha &&
      row.patch_checkout_sha === input.spec.checkoutSha &&
      row.execution_attempt_id === input.spec.attemptId &&
      row.attempt_version === input.expectedAttemptVersion &&
      row.execution_lease_generation === input.spec.leaseGeneration &&
      row.execution_role === 'publisher' &&
      row.executor_profile_id === input.spec.profile.profileId &&
      row.spec_digest === specDigest &&
      row.release_digest === input.spec.profile.releaseDigest &&
      row.provider_kind === input.spec.profile.kind &&
      row.plugin_schema_version === input.spec.profile.pluginSchemaVersion &&
      row.outbox_id === input.outboxId && row.outbox_run_id === input.spec.runId &&
      row.outbox_kind === 'agent_execution_start' && row.destination === 'agent_executor' &&
      row.payload_ref === `d1://attempt-executions/${input.spec.executionId}` &&
      row.dedupe_key === `agent-executor:${input.spec.executionId}`;
  }

  private async publicationCompletionMatches(input: {
    publicationId: string;
    publisherExecutionId: string;
    recomputedPatchDigest: string;
    headSha: string;
  }): Promise<boolean | null> {
    const row = await this.db.prepare(
      `SELECT publication.publisher_execution_id, publication.status,
              publication.expected_patch_digest, publication.recomputed_patch_digest,
              publication.head_sha, publication.published_at,
              patch.status AS patch_status, patch.patch_digest,
              patch.published_at AS patch_published_at
       FROM executor_patch_publications AS publication
       JOIN executor_patch_artifacts AS patch ON patch.patch_id = publication.patch_id
       WHERE publication.publication_id = ?`,
    ).bind(input.publicationId).first<{
      publisher_execution_id: string;
      status: string;
      expected_patch_digest: string;
      recomputed_patch_digest: string | null;
      head_sha: string | null;
      published_at: string | null;
      patch_status: string;
      patch_digest: string;
      patch_published_at: string | null;
    }>();
    if (row === null || row.status !== 'published') return null;
    return row.publisher_execution_id === input.publisherExecutionId &&
      row.expected_patch_digest === input.recomputedPatchDigest &&
      row.recomputed_patch_digest === input.recomputedPatchDigest &&
      row.patch_digest === input.recomputedPatchDigest && row.head_sha === input.headSha &&
      row.published_at !== null && row.patch_status === 'published' &&
      row.patch_published_at === row.published_at;
  }
}
