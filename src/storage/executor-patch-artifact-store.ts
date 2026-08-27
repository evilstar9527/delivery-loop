import { canonicalSha256, sha256Bytes } from '../domain/digest.js';
import {
  ExecutorPatchUploadRequestSchema,
  type ExecutorPatchUploadRequest,
} from '../domain/executor-patch-artifact.js';
import { PatchProposalSchema, type PatchProposal } from '../domain/patch-proposal.js';
import { isExactExecutionToolActions } from '../domain/tool-bridge.js';
import {
  assertFrozenExecutionSpec,
  type ExecutorPluginRegistry,
} from '../executor/core/executor-registry.js';
import type {
  FrozenExecutionSpec,
  VerifiedExecutorIdentity,
} from '../executor/core/executor-plugin.js';
import { SecretScanner } from '../security/redaction.js';
import {
  ExecutorPatchPublicationError,
  ExecutorPatchPublicationStore,
} from './executor-patch-publication-store.js';
import {
  ImmutableR2ObjectConflictError,
  putImmutableJsonObject,
} from './immutable-r2-object.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const MAX_PATCH_BYTES = 1_048_576;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export type ExecutorPatchArtifactErrorCode =
  | 'invalid_request'
  | 'invalid_token'
  | 'policy_denied'
  | 'not_found'
  | 'state_conflict'
  | 'payload_conflict'
  | 'secret_detected'
  | 'storage_unavailable';

export class ExecutorPatchArtifactError extends Error {
  constructor(readonly code: ExecutorPatchArtifactErrorCode) {
    super(`Executor patch artifact operation failed: ${code}`);
    this.name = 'ExecutorPatchArtifactError';
  }
}

export interface SavedExecutorPatchArtifact {
  schemaVersion: '1';
  patchId: string;
  workExecutionId: string;
  patchRef: string;
  patchDigest: string;
  changedPathsDigest: string;
  byteLength: number;
  created: boolean;
  publicationId: string;
  publisherExecutionId: string;
  publisherOutboxId: string;
  targetBranch: string;
}

export interface LoadedExecutorPatchArtifact {
  schemaVersion: '1';
  patchId: string;
  publicationId: string;
  publisherExecutionId: string;
  repository: string;
  taskId: string;
  baseSha: string;
  checkoutSha: string;
  baseBranch: string;
  targetBranch: string;
  targetBranchMode: 'new' | 'existing_fast_forward';
  planVersion: number;
  planItemId: string;
  targetedCommandRefs: string[];
  requiredVerifyCommandRefs: string[];
  patchDigest: string;
  changedPathsDigest: string;
  proposal: PatchProposal;
}

interface WorkAuthorizationRow {
  attempt_id: string;
  run_id: string;
  mode: string;
  attempt_status: string;
  attempt_version: number;
  attempt_lease_generation: number;
  attempt_lease_expires_at: string | null;
  repository: string | null;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  active_plan_id: string | null;
  active_plan_version: number | null;
  plan_status: string | null;
  progress_status: string | null;
  active_attempt_id: string | null;
  token_expires_at: string;
  scopes_json: string;
  identity_kind: string;
  token_execution_id: string | null;
  execution_status: string;
  execution_role: string;
  spec_json: string;
}

interface PublisherBindingRow {
  publication_id: string;
  publication_status: string;
  patch_id: string;
  work_execution_id: string;
  patch_attempt_id: string;
  patch_lease_generation: number;
  patch_repository: string;
  base_sha: string;
  checkout_sha: string;
  patch_digest: string;
  changed_paths_digest: string;
  patch_ref: string;
  byte_length: number;
  patch_status: string;
  publisher_execution_id: string;
  target_branch: string;
  expected_patch_digest: string;
  execution_attempt_id: string;
  attempt_version: number;
  execution_lease_generation: number;
  execution_status: string;
  execution_role: string;
  spec_json: string;
  attempt_status: string;
  current_attempt_version: number;
  current_lease_generation: number;
  attempt_repository: string | null;
  task_id: string;
  target_base_branch: string;
  plan_version: number | null;
  plan_item_id: string | null;
}

interface ExpectedObject {
  key: string;
  metadata: Record<string, string>;
  patchDigest: string;
  changedPathsDigest: string;
  byteLength: number;
}

function parseSpec(raw: string): FrozenExecutionSpec {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
    assertFrozenExecutionSpec(value as FrozenExecutionSpec);
  } catch {
    throw new ExecutorPatchArtifactError('state_conflict');
  }
  return value as FrozenExecutionSpec;
}

function patchObject(
  patchId: string,
  workExecutionId: string,
  attemptId: string,
  leaseGeneration: number,
  patchDigest: string,
  changedPathsDigest: string,
  byteLength: number,
): ExpectedObject {
  return {
    key: `executor-patches/${patchId}`,
    metadata: {
      schemaVersion: '1',
      patchId,
      workExecutionId,
      attemptId,
      leaseGeneration: String(leaseGeneration),
      patchDigest,
      changedPathsDigest,
      byteLength: String(byteLength),
    },
    patchDigest,
    changedPathsDigest,
    byteLength,
  };
}

function metadataMatches(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
): boolean {
  return actual !== undefined && Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value);
}

export async function executorPatchArtifactId(workExecutionId: string): Promise<string> {
  if (!ID_PATTERN.test(workExecutionId)) throw new ExecutorPatchArtifactError('invalid_request');
  const digest = await canonicalSha256({ schemaVersion: '1', workExecutionId });
  return `patch-${digest.slice('sha256:'.length, 'sha256:'.length + 40)}`;
}

/** Private R2 handoff: executor work upload, exact publisher-only download. */
export class ExecutorPatchArtifactStore {
  private readonly secrets: readonly string[];
  private readonly now: () => Date;

  constructor(
    private readonly db: D1Database,
    private readonly objects: R2Bucket,
    private readonly registry: ExecutorPluginRegistry,
    options: { secrets?: readonly string[]; now?: () => Date } = {},
  ) {
    this.secrets = options.secrets ?? [];
    this.now = options.now ?? (() => new Date());
  }

  async saveWorkPatch(
    attemptId: string,
    rawToken: string,
    rawInput: unknown,
  ): Promise<SavedExecutorPatchArtifact> {
    const parsed = ExecutorPatchUploadRequestSchema.safeParse(rawInput);
    if (!ID_PATTERN.test(attemptId) || !parsed.success) {
      throw new ExecutorPatchArtifactError('invalid_request');
    }
    const input = parsed.data;
    const patchId = await executorPatchArtifactId(input.workExecutionId);
    const serialized = JSON.stringify(input.proposal);
    const bytes = textEncoder.encode(serialized);
    if (bytes.byteLength < 2 || bytes.byteLength > MAX_PATCH_BYTES) {
      throw new ExecutorPatchArtifactError('invalid_request');
    }
    if (new SecretScanner({ secrets: [rawToken, ...this.secrets] }).scan(
      input.proposal,
      '$.proposal',
    ).length > 0) throw new ExecutorPatchArtifactError('secret_detected');
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new ExecutorPatchArtifactError('state_conflict');
    const tokenDigest = await canonicalSha256(rawToken);
    const spec = await this.authorizeWork(attemptId, tokenDigest, input, now.toISOString());
    const [patchDigest, changedPathsDigest] = await Promise.all([
      sha256Bytes(bytes),
      canonicalSha256({
        schemaVersion: '1',
        paths: input.proposal.changes.map((change) => change.path),
      }),
    ]);
    const expected = patchObject(
      patchId,
      input.workExecutionId,
      attemptId,
      input.leaseGeneration,
      patchDigest,
      changedPathsDigest,
      bytes.byteLength,
    );
    try {
      await putImmutableJsonObject(this.objects, {
        key: expected.key,
        body: serialized,
        metadata: expected.metadata,
      });
      await this.readObject(expected);
    } catch (error) {
      if (error instanceof ExecutorPatchArtifactError) throw error;
      if (error instanceof ImmutableR2ObjectConflictError) {
        throw new ExecutorPatchArtifactError('payload_conflict');
      }
      throw new ExecutorPatchArtifactError('storage_unavailable');
    }
    await this.authorizeWork(
      attemptId,
      tokenDigest,
      input,
      this.now().toISOString(),
    );
    let recorded: {
      created: boolean;
      publicationId: string;
      publisherExecutionId: string;
      publisherOutboxId: string;
      targetBranch: string;
    };
    try {
      recorded = await new ExecutorPatchPublicationStore(
        this.db,
        this.registry,
      ).recordWorkPatchAndSchedulePublisher({
          patchId,
          workExecutionId: input.workExecutionId,
          attemptId,
          leaseGeneration: input.leaseGeneration,
          repository: spec.repository,
          baseSha: spec.baseSha,
          checkoutSha: spec.checkoutSha,
          patchDigest,
          changedPathsDigest,
          patchRef: `r2://${expected.key}`,
          byteLength: bytes.byteLength,
          now: this.now(),
        });
    } catch (error) {
      if (error instanceof ExecutorPatchPublicationError) {
        throw new ExecutorPatchArtifactError(
          error.code === 'patch_invalid' ? 'payload_conflict' : 'state_conflict',
        );
      }
      throw error;
    }
    return {
      schemaVersion: '1',
      patchId,
      workExecutionId: input.workExecutionId,
      patchRef: `r2://${expected.key}`,
      patchDigest,
      changedPathsDigest,
      byteLength: bytes.byteLength,
      created: recorded.created,
      publicationId: recorded.publicationId,
      publisherExecutionId: recorded.publisherExecutionId,
      publisherOutboxId: recorded.publisherOutboxId,
      targetBranch: recorded.targetBranch,
    };
  }

  async loadPublisherPatch(
    identity: VerifiedExecutorIdentity,
    patchId: string,
  ): Promise<LoadedExecutorPatchArtifact> {
    if (!ID_PATTERN.test(patchId) || identity.role !== 'publisher') {
      throw new ExecutorPatchArtifactError('policy_denied');
    }
    const binding = await this.publisherBinding(identity, patchId);
    const spec = parseSpec(binding.spec_json);
    if (
      spec.role !== 'publisher' || spec.patchArtifactId !== patchId ||
      spec.executionId !== identity.executionId || spec.attemptId !== identity.attemptId ||
      spec.leaseGeneration !== identity.leaseGeneration ||
      spec.repository !== identity.repository || spec.repository !== binding.patch_repository ||
      spec.baseSha !== binding.base_sha || spec.checkoutSha !== binding.checkout_sha
    ) throw new ExecutorPatchArtifactError('state_conflict');
    const expected = patchObject(
      patchId,
      binding.work_execution_id,
      binding.patch_attempt_id,
      binding.patch_lease_generation,
      binding.patch_digest,
      binding.changed_paths_digest,
      binding.byte_length,
    );
    if (binding.patch_ref !== `r2://${expected.key}`) {
      throw new ExecutorPatchArtifactError('payload_conflict');
    }
    const proposal = await this.readObject(expected);
    if (await canonicalSha256({
      schemaVersion: '1',
      paths: proposal.changes.map((change) => change.path),
    }) !== binding.changed_paths_digest) {
      throw new ExecutorPatchArtifactError('payload_conflict');
    }
    await this.publisherBinding(identity, patchId);
    const targetedCommandRefs = await this.targetedCommandRefs(
      binding.execution_attempt_id,
      binding.plan_version,
      binding.plan_item_id,
    );
    const requiredVerifyCommandRefs = await this.requiredVerifyCommandRefs(
      binding.execution_attempt_id,
      binding.plan_version,
      binding.plan_item_id,
    );
    const derivedBranch = `agent/${binding.task_id}/${binding.execution_attempt_id}`;
    const targetBranchMode = binding.target_branch === derivedBranch
      ? 'new' as const
      : 'existing_fast_forward' as const;
    return {
      schemaVersion: '1',
      patchId,
      publicationId: binding.publication_id,
      publisherExecutionId: identity.executionId,
      repository: binding.patch_repository,
      taskId: binding.task_id,
      baseSha: binding.base_sha,
      checkoutSha: binding.checkout_sha,
      baseBranch: binding.target_base_branch,
      targetBranch: binding.target_branch,
      targetBranchMode,
      planVersion: binding.plan_version!,
      planItemId: binding.plan_item_id!,
      targetedCommandRefs,
      requiredVerifyCommandRefs,
      patchDigest: binding.patch_digest,
      changedPathsDigest: binding.changed_paths_digest,
      proposal,
    };
  }

  private async authorizeWork(
    attemptId: string,
    tokenDigest: string,
    input: ExecutorPatchUploadRequest,
    nowIso: string,
  ): Promise<FrozenExecutionSpec> {
    const row = await this.db.prepare(
      `SELECT attempts.attempt_id, attempts.run_id, attempts.mode,
              attempts.status AS attempt_status, attempts.version AS attempt_version,
              attempts.lease_generation AS attempt_lease_generation,
              attempts.lease_expires_at AS attempt_lease_expires_at,
              attempts.repository, attempts.plan_id, attempts.plan_version,
              attempts.plan_item_id, runs.active_plan_id, runs.active_plan_version,
              execution_plans.status AS plan_status,
              plan_item_progress.status AS progress_status,
              plan_item_progress.active_attempt_id,
              attempt_tokens.expires_at AS token_expires_at,
              attempt_tokens.scopes_json, attempt_tokens.identity_kind,
              attempt_tokens.execution_id AS token_execution_id,
              execution.status AS execution_status,
              execution.execution_role, execution.spec_json
       FROM attempts
       JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
         AND attempt_tokens.lease_generation = attempts.lease_generation
       JOIN attempt_execution_instances AS execution
         ON execution.execution_id = attempt_tokens.execution_id
        AND execution.attempt_id = attempts.attempt_id
        AND execution.lease_generation = attempts.lease_generation
       JOIN runs ON runs.run_id = attempts.run_id
       LEFT JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
       LEFT JOIN plan_item_progress
         ON plan_item_progress.plan_id = attempts.plan_id
        AND plan_item_progress.item_id = attempts.plan_item_id
       WHERE attempts.attempt_id = ? AND attempt_tokens.token_digest = ?
         AND attempt_tokens.identity_kind = 'executor'
         AND attempt_tokens.revoked_at IS NULL AND attempt_tokens.expires_at > ?`,
    ).bind(attemptId, tokenDigest, nowIso).first<WorkAuthorizationRow>();
    if (row === null) throw new ExecutorPatchArtifactError('invalid_token');
    let scopes: unknown;
    try {
      scopes = JSON.parse(row.scopes_json) as unknown;
    } catch {
      throw new ExecutorPatchArtifactError('policy_denied');
    }
    if (!isExactExecutionToolActions(scopes) || !scopes.includes('artifact:write')) {
      throw new ExecutorPatchArtifactError('policy_denied');
    }
    if (
      row.token_execution_id !== input.workExecutionId || row.execution_role !== 'work' ||
      !['starting', 'running'].includes(row.execution_status) ||
      (row.mode !== 'implement' && row.mode !== 'review_fix') ||
      row.attempt_status !== 'running' || row.attempt_version !== input.expectedVersion ||
      row.attempt_lease_generation !== input.leaseGeneration ||
      row.attempt_lease_expires_at === null || row.attempt_lease_expires_at <= nowIso ||
      row.token_expires_at <= nowIso || row.repository === null || row.plan_id === null ||
      row.plan_version === null || row.plan_item_id === null ||
      row.active_plan_id !== row.plan_id || row.active_plan_version !== row.plan_version ||
      row.plan_status !== 'active' || row.progress_status !== 'in_progress' ||
      row.active_attempt_id !== row.attempt_id
    ) throw new ExecutorPatchArtifactError('state_conflict');
    const spec = parseSpec(row.spec_json);
    if (
      spec.role !== 'work' || spec.executionId !== input.workExecutionId ||
      spec.attemptId !== attemptId || spec.runId !== row.run_id ||
      spec.leaseGeneration !== input.leaseGeneration || spec.mode !== row.mode ||
      spec.repository !== row.repository
    ) throw new ExecutorPatchArtifactError('state_conflict');
    return spec;
  }

  private async publisherBinding(
    identity: VerifiedExecutorIdentity,
    patchId: string,
  ): Promise<PublisherBindingRow> {
    const row = await this.db.prepare(
      `SELECT publication.publication_id, publication.status AS publication_status, patch.patch_id,
              patch.work_execution_id, patch.attempt_id AS patch_attempt_id,
              patch.lease_generation AS patch_lease_generation,
              patch.repository AS patch_repository, patch.base_sha, patch.checkout_sha,
              patch.patch_digest, patch.changed_paths_digest, patch.patch_ref,
              patch.byte_length, patch.status AS patch_status,
              publication.publisher_execution_id, publication.target_branch,
              publication.expected_patch_digest,
              execution.attempt_id AS execution_attempt_id, execution.attempt_version,
              execution.lease_generation AS execution_lease_generation,
              execution.status AS execution_status, execution.execution_role,
              execution.spec_json, attempts.status AS attempt_status,
              attempts.version AS current_attempt_version,
              attempts.lease_generation AS current_lease_generation,
              attempts.repository AS attempt_repository, attempts.plan_version,
              attempts.plan_item_id, tasks.task_id, tasks.target_base_branch
       FROM executor_patch_publications AS publication
       JOIN executor_patch_artifacts AS patch ON patch.patch_id = publication.patch_id
       JOIN attempt_execution_instances AS execution
         ON execution.execution_id = publication.publisher_execution_id
       JOIN attempts ON attempts.attempt_id = execution.attempt_id
       JOIN runs ON runs.run_id = attempts.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       WHERE publication.patch_id = ? AND publication.publisher_execution_id = ?`,
    ).bind(patchId, identity.executionId).first<PublisherBindingRow>();
    if (row === null) throw new ExecutorPatchArtifactError('not_found');
    if (
      identity.attemptId !== row.execution_attempt_id ||
      identity.leaseGeneration !== row.execution_lease_generation ||
      identity.repository !== row.patch_repository || identity.repository !== row.attempt_repository ||
      row.execution_role !== 'publisher' ||
      !['starting', 'running'].includes(row.execution_status) ||
      row.publication_status !== 'running' || row.patch_status !== 'prepared' ||
      row.expected_patch_digest !== row.patch_digest ||
      row.patch_attempt_id !== row.execution_attempt_id ||
      row.patch_lease_generation !== row.execution_lease_generation ||
      row.attempt_status !== 'running' || row.current_attempt_version !== row.attempt_version ||
      row.current_lease_generation !== row.execution_lease_generation ||
      row.plan_version === null || row.plan_item_id === null
    ) throw new ExecutorPatchArtifactError('state_conflict');
    return row;
  }

  private async targetedCommandRefs(
    attemptId: string,
    planVersion: number | null,
    planItemId: string | null,
  ): Promise<string[]> {
    if (planVersion === null || planItemId === null) {
      throw new ExecutorPatchArtifactError('state_conflict');
    }
    const result = await this.db.prepare(
      `SELECT command_ref
       FROM plan_item_command_refs
       WHERE plan_id = (SELECT plan_id FROM attempts WHERE attempt_id = ?)
         AND (SELECT plan_version FROM attempts WHERE attempt_id = ?) = ?
         AND item_id = ? AND command_ref LIKE 'test:%'
       ORDER BY command_ref`,
    ).bind(attemptId, attemptId, planVersion, planItemId).all<{ command_ref: string }>();
    const refs = result.results.map((row) => row.command_ref);
    if (
      !result.success || refs.length < 1 || refs.length > 100 ||
      new Set(refs).size !== refs.length ||
      !refs.every((ref) => /^test:[A-Za-z0-9_-]{1,64}$/.test(ref))
    ) throw new ExecutorPatchArtifactError('state_conflict');
    return refs;
  }

  // The plan-authorized required verify refs (e.g. verify:smoke). Deliberately
  // may be empty: the plan policy limits verification to what is affordable in
  // the sandbox and excludes heavy suites like verify:all (the full go test
  // suite needing infra the sandbox lacks). The publisher runs only these; the
  // authoritative full suite runs in CI on the opened PR.
  private async requiredVerifyCommandRefs(
    attemptId: string,
    planVersion: number | null,
    planItemId: string | null,
  ): Promise<string[]> {
    if (planVersion === null || planItemId === null) {
      throw new ExecutorPatchArtifactError('state_conflict');
    }
    const result = await this.db.prepare(
      `SELECT command_ref
       FROM plan_item_command_refs
       WHERE plan_id = (SELECT plan_id FROM attempts WHERE attempt_id = ?)
         AND (SELECT plan_version FROM attempts WHERE attempt_id = ?) = ?
         AND item_id = ? AND command_ref LIKE 'verify:%'
       ORDER BY command_ref`,
    ).bind(attemptId, attemptId, planVersion, planItemId).all<{ command_ref: string }>();
    const refs = result.results.map((row) => row.command_ref);
    if (
      !result.success || refs.length > 100 ||
      new Set(refs).size !== refs.length ||
      !refs.every((ref) => /^verify:[A-Za-z0-9_-]{1,64}$/.test(ref))
    ) throw new ExecutorPatchArtifactError('state_conflict');
    return refs;
  }

  private async readObject(expected: ExpectedObject): Promise<PatchProposal> {
    let object: R2ObjectBody | null;
    try {
      object = await this.objects.get(expected.key);
    } catch {
      throw new ExecutorPatchArtifactError('storage_unavailable');
    }
    if (
      object === null || object.size !== expected.byteLength || object.size > MAX_PATCH_BYTES ||
      !metadataMatches(object.customMetadata, expected.metadata)
    ) throw new ExecutorPatchArtifactError('payload_conflict');
    let rawBuffer: ArrayBuffer;
    try {
      rawBuffer = await object.arrayBuffer();
    } catch {
      throw new ExecutorPatchArtifactError('storage_unavailable');
    }
    const bytes = new Uint8Array(rawBuffer);
    if (
      bytes.byteLength !== expected.byteLength ||
      await sha256Bytes(rawBuffer) !== expected.patchDigest
    ) {
      throw new ExecutorPatchArtifactError('payload_conflict');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(textDecoder.decode(bytes)) as unknown;
    } catch {
      throw new ExecutorPatchArtifactError('payload_conflict');
    }
    const parsed = PatchProposalSchema.safeParse(raw);
    if (!parsed.success || JSON.stringify(parsed.data) !== textDecoder.decode(bytes)) {
      throw new ExecutorPatchArtifactError('payload_conflict');
    }
    return parsed.data;
  }
}
