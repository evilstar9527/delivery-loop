import {
  AgentCheckpointV1Schema,
  computeAgentCheckpointDigest,
  type AgentCheckpointV1,
} from '../domain/checkpoint.js';
import { canonicalSha256 } from '../domain/digest.js';
import { SecretScanner } from '../security/redaction.js';

const R2_PREFIX = 'r2://';
const MAX_CHECKPOINT_OBJECT_BYTES = 256 * 1_024;

export type AgentCheckpointErrorCode =
  | 'invalid_token'
  | 'state_conflict'
  | 'sequence_conflict'
  | 'binding_conflict'
  | 'evidence_conflict'
  | 'policy_denied'
  | 'secret_detected'
  | 'payload_conflict'
  | 'storage_unavailable';

export class AgentCheckpointError extends Error {
  constructor(readonly code: AgentCheckpointErrorCode) {
    super(`Agent checkpoint operation failed: ${code}`);
    this.name = 'AgentCheckpointError';
  }
}

interface CheckpointAuthorizationRow {
  attempt_id: string;
  run_id: string;
  status: string;
  version: number;
  lease_generation: number;
  lease_expires_at: string | null;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  head_branch: string | null;
  head_sha: string | null;
  token_id: string;
  token_digest: string;
  token_expires_at: string;
  scopes_json: string;
  active_plan_id: string | null;
  active_plan_version: number | null;
  plan_status: string | null;
  progress_status: string | null;
  active_attempt_id: string | null;
}

interface CheckpointProjectionRow {
  checkpoint_id: string;
  attempt_id: string;
  sequence: number;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  head_sha: string;
  payload_ref: string;
  payload_digest: string;
  summary: string;
  next_step: string;
  created_at: string;
}

interface RecoveryCheckpointRow extends CheckpointProjectionRow {
  run_id: string;
}

export interface SaveAgentCheckpointInput {
  expectedVersion: number;
  leaseGeneration: number;
  checkpoint: AgentCheckpointV1;
  registeredSecrets?: readonly string[];
}

export interface SaveAgentCheckpointResult {
  checkpointId: string;
  sequence: number;
  payloadRef: string;
  digest: string;
  created: boolean;
}

export interface RecoverableAgentCheckpoint {
  checkpointId: string;
  attemptId: string;
  digest: string;
  checkpoint: AgentCheckpointV1;
}

function checkpointObjectKey(
  attemptId: string,
  sequence: number,
  digest: string,
): string {
  return `checkpoints/${attemptId}/${sequence}-${digest.slice('sha256:'.length)}.json`;
}

function checkpointId(identityDigest: string): string {
  return `checkpoint_${identityDigest.slice('sha256:'.length, 'sha256:'.length + 56)}`;
}

function evidenceId(reference: string): string {
  return reference.slice('d1://evidence/'.length);
}

/** R2 payload + D1 safe projection adapter for fenced AgentCheckpoint v1 writes. */
export class AgentCheckpointStore {
  constructor(
    private readonly db: D1Database,
    private readonly objects: R2Bucket,
  ) {}

  async save(
    attemptId: string,
    rawToken: string,
    input: SaveAgentCheckpointInput,
    now = new Date(),
  ): Promise<SaveAgentCheckpointResult> {
    const parsed = AgentCheckpointV1Schema.safeParse(input.checkpoint);
    if (!parsed.success) throw new AgentCheckpointError('binding_conflict');
    const checkpoint = parsed.data;
    const secrets = [rawToken, ...(input.registeredSecrets ?? [])];
    if (new SecretScanner({ secrets }).scan(checkpoint).length > 0) {
      throw new AgentCheckpointError('secret_detected');
    }

    const nowIso = now.toISOString();
    const tokenDigest = await canonicalSha256(rawToken);
    const authorization = await this.authorization(attemptId, tokenDigest, nowIso);
    this.assertBinding(authorization, input, checkpoint, nowIso);
    await this.assertEvidenceBindings(authorization, checkpoint.evidenceRefs);

    const digest = await computeAgentCheckpointDigest(checkpoint);
    const identityDigest = await canonicalSha256({ attemptId, sequence: checkpoint.sequence });
    const id = checkpointId(identityDigest);
    const objectKey = checkpointObjectKey(attemptId, checkpoint.sequence, digest);
    const payloadRef = `${R2_PREFIX}${objectKey}`;
    const existing = await this.projection(attemptId, checkpoint.sequence);
    if (existing !== null) {
      this.assertImmutableProjection(existing, id, authorization, checkpoint, payloadRef, digest);
      await this.putObject(objectKey, checkpoint, digest, attemptId);
      return {
        checkpointId: existing.checkpoint_id,
        sequence: existing.sequence,
        payloadRef: existing.payload_ref,
        digest: existing.payload_digest,
        created: false,
      };
    }

    const latest = await this.db
      .prepare('SELECT MAX(sequence) AS sequence FROM checkpoints WHERE attempt_id = ?')
      .bind(attemptId)
      .first<{ sequence: number | null }>();
    if (latest?.sequence !== null && latest?.sequence !== undefined && latest.sequence >= checkpoint.sequence) {
      // Another identical request may have committed after the first projection read.
      // Reconcile the exact sequence before classifying it as an out-of-order conflict.
      const raced = await this.projection(attemptId, checkpoint.sequence);
      if (raced !== null) {
        this.assertImmutableProjection(raced, id, authorization, checkpoint, payloadRef, digest);
        await this.putObject(objectKey, checkpoint, digest, attemptId);
        return {
          checkpointId: raced.checkpoint_id,
          sequence: raced.sequence,
          payloadRef: raced.payload_ref,
          digest: raced.payload_digest,
          created: false,
        };
      }
      throw new AgentCheckpointError('sequence_conflict');
    }

    await this.putObject(objectKey, checkpoint, digest, attemptId);
    const write = await this.db
      .prepare(
        `INSERT INTO checkpoints (
           checkpoint_id, attempt_id, sequence, plan_id, plan_version, plan_item_id,
           head_sha, payload_ref, payload_digest, summary, next_step, created_at
         )
         SELECT ?, attempts.attempt_id, ?, attempts.plan_id, attempts.plan_version,
                attempts.plan_item_id, attempts.head_sha, ?, ?, ?, ?, ?
         FROM attempts
         JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
         JOIN runs ON runs.run_id = attempts.run_id
         JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
         JOIN plan_item_progress
           ON plan_item_progress.plan_id = attempts.plan_id
          AND plan_item_progress.item_id = attempts.plan_item_id
         WHERE attempts.attempt_id = ?
           AND attempts.status = 'running'
           AND attempts.version = ?
           AND attempts.lease_generation = ?
           AND attempts.lease_expires_at > ?
           AND attempts.plan_version = ?
           AND attempts.plan_item_id = ?
           AND attempts.head_sha = ?
           AND (? IS NULL OR attempts.head_branch = ?)
           AND attempt_tokens.token_id = ?
           AND attempt_tokens.token_digest = ?
           AND attempt_tokens.lease_generation = ?
           AND attempt_tokens.revoked_at IS NULL
           AND attempt_tokens.expires_at > ?
           AND runs.active_plan_id = attempts.plan_id
           AND runs.active_plan_version = attempts.plan_version
           AND execution_plans.plan_version = attempts.plan_version
           AND execution_plans.status = 'active'
           AND plan_item_progress.status = 'in_progress'
           AND plan_item_progress.active_attempt_id = attempts.attempt_id
           AND NOT EXISTS (
             SELECT 1 FROM checkpoints AS current
             WHERE current.attempt_id = attempts.attempt_id
               AND current.sequence >= ?
           )
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        id,
        checkpoint.sequence,
        payloadRef,
        digest,
        checkpoint.summary,
        checkpoint.nextStep,
        nowIso,
        attemptId,
        input.expectedVersion,
        input.leaseGeneration,
        nowIso,
        checkpoint.planVersion,
        checkpoint.planItemId,
        checkpoint.headSha,
        checkpoint.headBranch ?? null,
        checkpoint.headBranch ?? null,
        authorization.token_id,
        tokenDigest,
        input.leaseGeneration,
        nowIso,
        checkpoint.sequence,
      )
      .run();

    const persisted = await this.projection(attemptId, checkpoint.sequence);
    if (persisted === null) throw new AgentCheckpointError('state_conflict');
    this.assertImmutableProjection(persisted, id, authorization, checkpoint, payloadRef, digest);
    return {
      checkpointId: persisted.checkpoint_id,
      sequence: persisted.sequence,
      payloadRef: persisted.payload_ref,
      digest: persisted.payload_digest,
      created: write.meta.changes === 1,
    };
  }

  async loadLatestForRecovery(
    runId: string,
    planVersion: number,
    planItemId: string,
  ): Promise<RecoverableAgentCheckpoint | null> {
    const row = await this.db
      .prepare(
        `SELECT checkpoints.checkpoint_id, checkpoints.attempt_id,
                checkpoints.sequence, checkpoints.plan_id, checkpoints.plan_version,
                checkpoints.plan_item_id, checkpoints.head_sha,
                checkpoints.payload_ref, checkpoints.payload_digest,
                checkpoints.summary, checkpoints.next_step, checkpoints.created_at,
                attempts.run_id
         FROM checkpoints
         JOIN attempts ON attempts.attempt_id = checkpoints.attempt_id
         JOIN runs ON runs.run_id = attempts.run_id
         JOIN execution_plans ON execution_plans.plan_id = checkpoints.plan_id
         JOIN plan_item_progress
           ON plan_item_progress.plan_id = checkpoints.plan_id
          AND plan_item_progress.item_id = checkpoints.plan_item_id
         WHERE attempts.run_id = ?
           AND checkpoints.plan_version = ?
           AND checkpoints.plan_item_id = ?
           AND runs.active_plan_id = checkpoints.plan_id
           AND runs.active_plan_version = checkpoints.plan_version
           AND execution_plans.status = 'active'
           AND plan_item_progress.status IN ('ready', 'in_progress', 'failed', 'blocked')
         ORDER BY attempts.ordinal DESC, checkpoints.sequence DESC
         LIMIT 1`,
      )
      .bind(runId, planVersion, planItemId)
      .first<RecoveryCheckpointRow>();
    if (row === null) return null;
    const checkpoint = await this.readObject(row);
    return {
      checkpointId: row.checkpoint_id,
      attemptId: row.attempt_id,
      digest: row.payload_digest,
      checkpoint,
    };
  }

  private async authorization(
    attemptId: string,
    tokenDigest: string,
    nowIso: string,
  ): Promise<CheckpointAuthorizationRow> {
    const row = await this.db
      .prepare(
        `SELECT attempts.attempt_id, attempts.run_id, attempts.status, attempts.version,
                attempts.lease_generation, attempts.lease_expires_at,
                attempts.plan_id, attempts.plan_version, attempts.plan_item_id,
                attempts.head_branch, attempts.head_sha,
                attempt_tokens.token_id, attempt_tokens.token_digest,
                attempt_tokens.expires_at AS token_expires_at,
                attempt_tokens.scopes_json,
                runs.active_plan_id, runs.active_plan_version,
                execution_plans.status AS plan_status,
                plan_item_progress.status AS progress_status,
                plan_item_progress.active_attempt_id
         FROM attempts
         JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
         JOIN runs ON runs.run_id = attempts.run_id
         LEFT JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
         LEFT JOIN plan_item_progress
           ON plan_item_progress.plan_id = attempts.plan_id
          AND plan_item_progress.item_id = attempts.plan_item_id
         WHERE attempts.attempt_id = ?
           AND attempt_tokens.token_digest = ?
           AND attempt_tokens.revoked_at IS NULL
           AND attempt_tokens.expires_at > ?`,
      )
      .bind(attemptId, tokenDigest, nowIso)
      .first<CheckpointAuthorizationRow>();
    if (row === null) throw new AgentCheckpointError('invalid_token');
    return row;
  }

  private assertBinding(
    authorization: CheckpointAuthorizationRow,
    input: SaveAgentCheckpointInput,
    checkpoint: AgentCheckpointV1,
    nowIso: string,
  ): void {
    let scopes: unknown;
    try {
      scopes = JSON.parse(authorization.scopes_json) as unknown;
    } catch {
      throw new AgentCheckpointError('invalid_token');
    }
    if (!Array.isArray(scopes) || !scopes.includes('checkpoint:write')) {
      throw new AgentCheckpointError('policy_denied');
    }
    if (
      authorization.status !== 'running' ||
      authorization.version !== input.expectedVersion ||
      authorization.lease_generation !== input.leaseGeneration ||
      authorization.lease_expires_at === null ||
      authorization.lease_expires_at <= nowIso ||
      authorization.token_expires_at <= nowIso
    ) {
      throw new AgentCheckpointError('state_conflict');
    }
    if (
      authorization.plan_id === null ||
      authorization.plan_version !== checkpoint.planVersion ||
      authorization.plan_item_id !== checkpoint.planItemId ||
      authorization.head_sha !== checkpoint.headSha ||
      (checkpoint.headBranch !== undefined &&
        authorization.head_branch !== checkpoint.headBranch) ||
      authorization.active_plan_id !== authorization.plan_id ||
      authorization.active_plan_version !== checkpoint.planVersion ||
      authorization.plan_status !== 'active' ||
      authorization.progress_status !== 'in_progress' ||
      authorization.active_attempt_id !== authorization.attempt_id
    ) {
      throw new AgentCheckpointError('binding_conflict');
    }
  }

  private async assertEvidenceBindings(
    authorization: CheckpointAuthorizationRow,
    references: readonly string[],
  ): Promise<void> {
    if (references.length === 0) return;
    const ids = references.map(evidenceId);
    const placeholders = ids.map(() => '?').join(', ');
    const result = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT evidence_id) AS count
         FROM evidence
         WHERE evidence_id IN (${placeholders})
           AND run_id = ?
           AND plan_id = ?
           AND plan_version = ?
           AND plan_item_id = ?`,
      )
      .bind(
        ...ids,
        authorization.run_id,
        authorization.plan_id,
        authorization.plan_version,
        authorization.plan_item_id,
      )
      .first<{ count: number }>();
    if (result?.count !== ids.length) throw new AgentCheckpointError('evidence_conflict');
  }

  private async projection(
    attemptId: string,
    sequence: number,
  ): Promise<CheckpointProjectionRow | null> {
    return await this.db
      .prepare(
        `SELECT checkpoint_id, attempt_id, sequence, plan_id, plan_version,
                plan_item_id, head_sha, payload_ref, payload_digest,
                summary, next_step, created_at
         FROM checkpoints WHERE attempt_id = ? AND sequence = ?`,
      )
      .bind(attemptId, sequence)
      .first<CheckpointProjectionRow>();
  }

  private assertImmutableProjection(
    projection: CheckpointProjectionRow,
    id: string,
    authorization: CheckpointAuthorizationRow,
    checkpoint: AgentCheckpointV1,
    payloadRef: string,
    digest: string,
  ): void {
    if (
      projection.checkpoint_id !== id ||
      projection.plan_id !== authorization.plan_id ||
      projection.plan_version !== checkpoint.planVersion ||
      projection.plan_item_id !== checkpoint.planItemId ||
      projection.head_sha !== checkpoint.headSha ||
      projection.payload_ref !== payloadRef ||
      projection.payload_digest !== digest ||
      projection.summary !== checkpoint.summary ||
      projection.next_step !== checkpoint.nextStep
    ) {
      throw new AgentCheckpointError('sequence_conflict');
    }
  }

  private async putObject(
    objectKey: string,
    checkpoint: AgentCheckpointV1,
    digest: string,
    attemptId: string,
  ): Promise<void> {
    try {
      await this.objects.put(objectKey, JSON.stringify(checkpoint), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: {
          checkpointDigest: digest,
          attemptId,
          sequence: String(checkpoint.sequence),
        },
      });
    } catch {
      throw new AgentCheckpointError('storage_unavailable');
    }
  }

  private async readObject(row: RecoveryCheckpointRow): Promise<AgentCheckpointV1> {
    if (!row.payload_ref.startsWith(R2_PREFIX)) {
      throw new AgentCheckpointError('payload_conflict');
    }
    let object: R2ObjectBody | null;
    try {
      object = await this.objects.get(row.payload_ref.slice(R2_PREFIX.length));
    } catch {
      throw new AgentCheckpointError('storage_unavailable');
    }
    if (
      object === null ||
      object.size > MAX_CHECKPOINT_OBJECT_BYTES ||
      object.customMetadata?.checkpointDigest !== row.payload_digest ||
      object.customMetadata.attemptId !== row.attempt_id ||
      object.customMetadata.sequence !== String(row.sequence)
    ) {
      throw new AgentCheckpointError('payload_conflict');
    }
    let checkpoint: AgentCheckpointV1;
    try {
      checkpoint = AgentCheckpointV1Schema.parse(JSON.parse(await object.text()) as unknown);
    } catch {
      throw new AgentCheckpointError('payload_conflict');
    }
    if (
      (await computeAgentCheckpointDigest(checkpoint)) !== row.payload_digest ||
      checkpoint.sequence !== row.sequence ||
      checkpoint.planVersion !== row.plan_version ||
      checkpoint.planItemId !== row.plan_item_id ||
      checkpoint.headSha !== row.head_sha ||
      checkpoint.summary !== row.summary ||
      checkpoint.nextStep !== row.next_step
    ) {
      throw new AgentCheckpointError('payload_conflict');
    }
    return checkpoint;
  }
}
