import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import {
  MeegleTaskMappingProfileV1Schema,
  MeegleTriageGapSchema,
  MeegleWorkItemMappingError,
  MeegleWorkItemSnapshotV1Schema,
  mapMeegleWorkItem,
  meegleExactSnapshotDigest,
  type MeegleTaskMappingProfileV1,
  type MeegleTriageGap,
  type MeegleWorkItemSnapshotV1,
} from '../domain/meegle-work-item.js';
import { SecretScanner } from '../security/redaction.js';
import {
  ImmutableR2ObjectConflictError,
  putImmutableJsonObject,
} from './immutable-r2-object.js';
import {
  FeishuNormalizedTaskError,
  FeishuNormalizedTaskStore,
} from './feishu-normalized-task-store.js';

const ProcessInputSchema = z.object({
  ingressOutboxId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/),
  snapshot: MeegleWorkItemSnapshotV1Schema,
  profile: MeegleTaskMappingProfileV1Schema,
  now: z.date(),
}).strict();

export interface MeegleWorkItemProcessInput {
  ingressOutboxId: string;
  snapshot: MeegleWorkItemSnapshotV1;
  profile: MeegleTaskMappingProfileV1;
  now: Date;
}

export interface MeegleWorkItemProcessResult {
  state: 'queued' | 'triaging';
  disposition: 'linked' | 'duplicate' | 'created';
  candidateId?: string;
  taskId?: string;
  runId?: string;
  gaps: MeegleTriageGap[];
}

export class MeegleWorkItemIngressError extends Error {
  constructor(readonly code:
    | 'not_found'
    | 'not_ready'
    | 'binding_mismatch'
    | 'profile_binding_mismatch'
    | 'secret_detected'
    | 'revision_conflict'
    | 'storage_unavailable'
    | 'state_conflict') {
    super(`Meegle work-item ingress rejected: ${code}`);
    this.name = 'MeegleWorkItemIngressError';
  }
}

interface IngressRow {
  outbox_id: string;
  delivery_state: string;
  tenant_key: string;
  event_id: string;
  queue_observed_at: string | null;
  delivery_status: string;
}

interface CandidateRow {
  candidate_id: string;
  source_identity_digest: string;
  tenant_key: string;
  project_key: string;
  work_item_type_key: string;
  work_item_id: string;
  external_revision: string | null;
  status: 'triaging';
  gaps_json: string;
  mapping_snapshot_digest: string;
  mapping_profile_version: number;
  mapping_profile_digest: string;
  created_at: string;
  updated_at: string;
  lineage_count?: number;
}

interface LineageRow {
  candidate_id: string;
  exact_snapshot_digest: string;
  snapshot_ref: string;
}

interface MappingLineageRow {
  ingress_outbox_id: string;
  event_id: string;
  tenant_key: string;
  project_key: string;
  work_item_type_key: string;
  work_item_id: string;
  external_revision: string | null;
  outcome: 'mapped' | 'triaging';
  exact_snapshot_digest: string;
  mapping_snapshot_digest: string;
  mapping_profile_version: number;
  mapping_profile_digest: string;
  acceptance_criteria_field_key: string;
  owner_role_key: string;
  target_repository_field_key: string;
  snapshot_ref: string;
  fields_complete: number;
  has_next_page_token: number;
  field_count: number;
  role_count: number;
  owner_count: number;
  target_repository_status: 'allowed' | 'missing' | 'invalid';
  gaps_json: string;
  candidate_id: string | null;
  task_id: string | null;
  run_id: string | null;
}

interface MappingLineageInput {
  ingress: IngressRow;
  snapshot: MeegleWorkItemSnapshotV1;
  profile: MeegleTaskMappingProfileV1;
  exactSnapshotDigest: string;
  mappingSnapshotDigest: string;
  mappingProfileDigest: string;
  snapshotRef: string;
  outcome: 'mapped' | 'triaging';
  gaps: readonly MeegleTriageGap[];
  candidateId: string | null;
  taskId: string | null;
  runId: string | null;
  now: string;
}

function mappingLineageFacts(input: MappingLineageInput): {
  ownerCount: number;
  targetRepositoryStatus: MappingLineageRow['target_repository_status'];
  gapsJson: string;
} {
  const ownerCount = input.snapshot.roles.find(
    (role) => role.roleKey === input.profile.ownerRoleKey,
  )?.owners.length ?? 0;
  const repository = input.snapshot.fields.find(
    (field) => field.fieldKey === input.profile.targetRepositoryFieldKey,
  )?.value;
  const targetRepositoryStatus = input.gaps.includes('target_repository_missing')
    ? 'missing'
    : input.gaps.includes('target_repository_invalid')
      ? 'invalid'
      : repository === undefined || repository === null
        ? 'missing'
        : 'allowed';
  return { ownerCount, targetRepositoryStatus, gapsJson: JSON.stringify(input.gaps) };
}

function mappingLineageMatches(
  row: MappingLineageRow | null,
  input: MappingLineageInput,
): boolean {
  if (row === null) return false;
  const facts = mappingLineageFacts(input);
  return row.ingress_outbox_id === input.ingress.outbox_id &&
    row.event_id === input.ingress.event_id && row.tenant_key === input.snapshot.tenantKey &&
    row.project_key === input.snapshot.projectKey &&
    row.work_item_type_key === input.snapshot.workItemTypeKey &&
    row.work_item_id === input.snapshot.workItemId &&
    row.external_revision === input.snapshot.revision && row.outcome === input.outcome &&
    row.exact_snapshot_digest === input.exactSnapshotDigest &&
    row.mapping_snapshot_digest === input.mappingSnapshotDigest &&
    row.mapping_profile_version === input.profile.profileVersion &&
    row.mapping_profile_digest === input.mappingProfileDigest &&
    row.acceptance_criteria_field_key === input.profile.acceptanceCriteriaFieldKey &&
    row.owner_role_key === input.profile.ownerRoleKey &&
    row.target_repository_field_key === input.profile.targetRepositoryFieldKey &&
    row.snapshot_ref === input.snapshotRef &&
    row.fields_complete === (input.snapshot.fieldsComplete ? 1 : 0) &&
    row.has_next_page_token === (input.snapshot.nextPageToken === null ? 0 : 1) &&
    row.field_count === input.snapshot.fields.length &&
    row.role_count === input.snapshot.roles.length &&
    row.owner_count === facts.ownerCount &&
    row.target_repository_status === facts.targetRepositoryStatus &&
    row.gaps_json === facts.gapsJson && row.candidate_id === input.candidateId &&
    row.task_id === input.taskId && row.run_id === input.runId;
}

export interface MeegleTriageCandidateSummary {
  candidateId: string;
  status: 'triaging';
  source: {
    system: 'meego';
    tenantKey: string;
    projectKey: string;
    workItemTypeKey: string;
    workItemId: string;
    revision: string | null;
  };
  gaps: MeegleTriageGap[];
  mappingProfileVersion: number;
  lineageCount: number;
  createdAt: string;
  updatedAt: string;
}

function parseGaps(raw: string): MeegleTriageGap[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new MeegleWorkItemIngressError('state_conflict');
  }
  const result = z.array(MeegleTriageGapSchema).nonempty().safeParse(parsed);
  if (!result.success) throw new MeegleWorkItemIngressError('state_conflict');
  return result.data;
}

export class MeegleTriageCandidateStore {
  constructor(private readonly db: D1Database) {}

  async list(limit = 50): Promise<MeegleTriageCandidateSummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new MeegleWorkItemIngressError('state_conflict');
    }
    const { results } = await this.db.prepare(
      `SELECT candidates.*,
              (SELECT COUNT(*) FROM meegle_triage_lineage AS lineage
               WHERE lineage.candidate_id = candidates.candidate_id) AS lineage_count
       FROM meegle_triage_candidates AS candidates
       WHERE candidates.status = 'triaging'
       ORDER BY candidates.created_at, candidates.candidate_id
       LIMIT ?`,
    ).bind(limit).all<CandidateRow>();
    return results.map((row) => ({
      candidateId: row.candidate_id,
      status: row.status,
      source: {
        system: 'meego',
        tenantKey: row.tenant_key,
        projectKey: row.project_key,
        workItemTypeKey: row.work_item_type_key,
        workItemId: row.work_item_id,
        revision: row.external_revision,
      },
      gaps: parseGaps(row.gaps_json),
      mappingProfileVersion: row.mapping_profile_version,
      lineageCount: row.lineage_count ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}

export class MeegleWorkItemIngressStore {
  private readonly secrets: readonly string[];

  constructor(
    private readonly db: D1Database,
    private readonly objects: R2Bucket,
    options: { secrets?: readonly string[] } = {},
  ) {
    this.secrets = options.secrets ?? [];
  }

  async process(rawInput: MeegleWorkItemProcessInput): Promise<MeegleWorkItemProcessResult> {
    const input = ProcessInputSchema.parse(rawInput);
    const ingress = await this.ingress(input.ingressOutboxId);
    if (ingress === null) throw new MeegleWorkItemIngressError('not_found');
    if (
      (ingress.delivery_state !== 'queued' && ingress.delivery_state !== 'settled') ||
      ingress.queue_observed_at === null || ingress.delivery_status !== 'accepted'
    ) throw new MeegleWorkItemIngressError('not_ready');
    if (
      input.snapshot.eventId !== ingress.event_id ||
      input.snapshot.tenantKey !== ingress.tenant_key
    ) throw new MeegleWorkItemIngressError('binding_mismatch');
    if (
      input.profile.tenantKey !== ingress.tenant_key ||
      input.profile.tenantKey !== input.snapshot.tenantKey ||
      input.profile.projectKey !== input.snapshot.projectKey ||
      input.profile.workItemTypeKey !== input.snapshot.workItemTypeKey
    ) throw new MeegleWorkItemIngressError('profile_binding_mismatch');
    if (new SecretScanner({ secrets: [...this.secrets] }).scan(input.snapshot).length > 0) {
      throw new MeegleWorkItemIngressError('secret_detected');
    }

    let mapping;
    try {
      mapping = await mapMeegleWorkItem(input.snapshot, input.profile);
    } catch (error) {
      if (error instanceof MeegleWorkItemMappingError) {
        throw new MeegleWorkItemIngressError(error.code);
      }
      throw error;
    }

    const exactSnapshotDigest = await meegleExactSnapshotDigest(input.snapshot);
    const mappingSnapshotDigest = mapping.kind === 'mapped'
      ? mapping.snapshotDigest
      : mapping.candidate.snapshotDigest;
    const mappingProfileDigest = mapping.kind === 'mapped'
      ? mapping.profileDigest
      : mapping.candidate.profileDigest;
    const snapshotKey = `meegle-snapshots/${exactSnapshotDigest.slice('sha256:'.length)}.json`;
    const snapshotRef = `r2://${snapshotKey}`;
    try {
      await putImmutableJsonObject(this.objects, {
        key: snapshotKey,
        body: JSON.stringify(input.snapshot),
        metadata: {
          exactSnapshotDigest,
          mappingSnapshotDigest,
          mappingProfileDigest,
        },
      });
    } catch (error) {
      if (error instanceof ImmutableR2ObjectConflictError) {
        throw new MeegleWorkItemIngressError('revision_conflict');
      }
      throw new MeegleWorkItemIngressError('storage_unavailable');
    }

    if (mapping.kind === 'mapped') {
      try {
        const accepted = await new FeishuNormalizedTaskStore(
          this.db,
          this.objects,
          { secrets: this.secrets },
        ).accept({
          ingressOutboxId: input.ingressOutboxId,
          task: mapping.task,
          now: input.now,
        });
        await this.persistMappingLineage({
          ingress,
          snapshot: input.snapshot,
          profile: input.profile,
          exactSnapshotDigest,
          mappingSnapshotDigest,
          mappingProfileDigest,
          snapshotRef,
          outcome: 'mapped',
          gaps: [],
          candidateId: null,
          taskId: accepted.taskId,
          runId: accepted.runId,
          now: input.now.toISOString(),
        });
        return {
          state: 'queued',
          disposition: accepted.disposition,
          taskId: accepted.taskId,
          runId: accepted.runId,
          gaps: [],
        };
      } catch (error) {
        if (error instanceof FeishuNormalizedTaskError) {
          throw new MeegleWorkItemIngressError(error.code);
        }
        throw error;
      }
    }

    return await this.persistTriage({
      ingress,
      mapping: mapping.candidate,
      snapshot: input.snapshot,
      profile: input.profile,
      exactSnapshotDigest,
      snapshotRef,
      now: input.now.toISOString(),
    });
  }

  private async persistTriage(input: {
    ingress: IngressRow;
    mapping: Extract<Awaited<ReturnType<typeof mapMeegleWorkItem>>, { kind: 'triaging' }>['candidate'];
    snapshot: MeegleWorkItemSnapshotV1;
    profile: MeegleTaskMappingProfileV1;
    exactSnapshotDigest: string;
    snapshotRef: string;
    now: string;
  }): Promise<MeegleWorkItemProcessResult> {
    const sourceIdentityDigest = await canonicalSha256(input.mapping.source);
    const candidateIdentityDigest = await canonicalSha256({
      sourceIdentityDigest,
      mappingProfileDigest: input.mapping.profileDigest,
    });
    const candidateId = `meegle_triage_${candidateIdentityDigest
      .slice('sha256:'.length, 'sha256:'.length + 48)}`;
    const gapsJson = JSON.stringify(input.mapping.gaps);
    const mappingLineage: MappingLineageInput = {
      ingress: input.ingress,
      snapshot: input.snapshot,
      profile: input.profile,
      exactSnapshotDigest: input.exactSnapshotDigest,
      mappingSnapshotDigest: input.mapping.snapshotDigest,
      mappingProfileDigest: input.mapping.profileDigest,
      snapshotRef: input.snapshotRef,
      outcome: 'triaging',
      gaps: input.mapping.gaps,
      candidateId,
      taskId: null,
      runId: null,
      now: input.now,
    };
    const facts = mappingLineageFacts(mappingLineage);
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT OR IGNORE INTO meegle_triage_candidates (
           candidate_id, source_identity_digest, tenant_key, project_key,
           work_item_type_key, work_item_id, external_revision, status, gaps_json,
           mapping_snapshot_digest, mapping_profile_version, mapping_profile_digest,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'triaging', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        candidateId,
        sourceIdentityDigest,
        input.mapping.source.tenantKey,
        input.mapping.source.projectKey,
        input.mapping.source.workItemTypeKey,
        input.mapping.source.workItemId,
        input.mapping.source.revision,
        gapsJson,
        input.mapping.snapshotDigest,
        input.mapping.mappingProfileVersion,
        input.mapping.profileDigest,
        input.now,
        input.now,
      ),
      this.db.prepare(
        `INSERT OR IGNORE INTO meegle_triage_lineage (
           candidate_id, ingress_outbox_id, event_id, exact_snapshot_digest,
           snapshot_ref, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM meegle_triage_candidates
           WHERE candidate_id = ? AND source_identity_digest = ?
             AND gaps_json = ? AND mapping_snapshot_digest = ?
             AND mapping_profile_version = ? AND mapping_profile_digest = ?
         )`,
      ).bind(
        candidateId,
        input.ingress.outbox_id,
        input.ingress.event_id,
        input.exactSnapshotDigest,
        input.snapshotRef,
        input.now,
        candidateId,
        sourceIdentityDigest,
        gapsJson,
        input.mapping.snapshotDigest,
        input.mapping.mappingProfileVersion,
        input.mapping.profileDigest,
      ),
      this.db.prepare(
        `INSERT OR IGNORE INTO meegle_mapping_lineage (
           ingress_outbox_id, event_id, tenant_key, project_key, work_item_type_key,
           work_item_id, external_revision, outcome, exact_snapshot_digest,
           mapping_snapshot_digest, mapping_profile_version, mapping_profile_digest,
           acceptance_criteria_field_key, owner_role_key, target_repository_field_key,
           snapshot_ref, fields_complete, has_next_page_token, field_count, role_count,
           owner_count, target_repository_status, gaps_json, candidate_id, task_id,
           run_id, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, 'triaging', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, NULL, NULL, ?
         WHERE EXISTS (
           SELECT 1 FROM meegle_triage_candidates
           WHERE candidate_id = ? AND source_identity_digest = ? AND gaps_json = ?
             AND mapping_snapshot_digest = ? AND mapping_profile_version = ?
             AND mapping_profile_digest = ?
         )`,
      ).bind(
        input.ingress.outbox_id,
        input.ingress.event_id,
        input.snapshot.tenantKey,
        input.snapshot.projectKey,
        input.snapshot.workItemTypeKey,
        input.snapshot.workItemId,
        input.snapshot.revision,
        input.exactSnapshotDigest,
        input.mapping.snapshotDigest,
        input.profile.profileVersion,
        input.mapping.profileDigest,
        input.profile.acceptanceCriteriaFieldKey,
        input.profile.ownerRoleKey,
        input.profile.targetRepositoryFieldKey,
        input.snapshotRef,
        input.snapshot.fieldsComplete ? 1 : 0,
        input.snapshot.nextPageToken === null ? 0 : 1,
        input.snapshot.fields.length,
        input.snapshot.roles.length,
        facts.ownerCount,
        facts.targetRepositoryStatus,
        facts.gapsJson,
        candidateId,
        input.now,
        candidateId,
        sourceIdentityDigest,
        gapsJson,
        input.mapping.snapshotDigest,
        input.mapping.mappingProfileVersion,
        input.mapping.profileDigest,
      ),
    ]);

    const candidate = await this.db.prepare(
      'SELECT * FROM meegle_triage_candidates WHERE candidate_id = ?',
    ).bind(candidateId).first<CandidateRow>();
    if (
      candidate === null || candidate.source_identity_digest !== sourceIdentityDigest ||
      candidate.gaps_json !== gapsJson ||
      candidate.mapping_snapshot_digest !== input.mapping.snapshotDigest ||
      candidate.mapping_profile_version !== input.mapping.mappingProfileVersion ||
      candidate.mapping_profile_digest !== input.mapping.profileDigest
    ) throw new MeegleWorkItemIngressError('revision_conflict');
    const lineage = await this.db.prepare(
      `SELECT candidate_id, exact_snapshot_digest, snapshot_ref
       FROM meegle_triage_lineage WHERE ingress_outbox_id = ?`,
    ).bind(input.ingress.outbox_id).first<LineageRow>();
    if (
      lineage === null || lineage.candidate_id !== candidateId ||
      lineage.exact_snapshot_digest !== input.exactSnapshotDigest ||
      lineage.snapshot_ref !== input.snapshotRef
    ) throw new MeegleWorkItemIngressError('state_conflict');
    const durableMappingLineage = await this.mappingLineage(input.ingress.outbox_id);
    if (!mappingLineageMatches(durableMappingLineage, mappingLineage)) {
      throw new MeegleWorkItemIngressError('state_conflict');
    }
    return {
      state: 'triaging',
      disposition: results[0]?.meta.changes === 1 ? 'created' : 'duplicate',
      candidateId,
      gaps: [...input.mapping.gaps],
    };
  }

  private async persistMappingLineage(input: MappingLineageInput): Promise<void> {
    const facts = mappingLineageFacts(input);
    await this.db.prepare(
      `INSERT OR IGNORE INTO meegle_mapping_lineage (
         ingress_outbox_id, event_id, tenant_key, project_key, work_item_type_key,
         work_item_id, external_revision, outcome, exact_snapshot_digest,
         mapping_snapshot_digest, mapping_profile_version, mapping_profile_digest,
         acceptance_criteria_field_key, owner_role_key, target_repository_field_key,
         snapshot_ref, fields_complete, has_next_page_token, field_count, role_count,
         owner_count, target_repository_status, gaps_json, candidate_id, task_id,
         run_id, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, 'mapped', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, '[]', NULL, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM feishu_ingress_outbox AS ingress
         JOIN tasks AS task ON task.task_id = ingress.task_id
         JOIN runs AS run ON run.run_id = ingress.run_id
         WHERE ingress.outbox_id = ? AND ingress.event_id = ?
           AND ingress.delivery_state = 'settled' AND task.task_id = ? AND run.run_id = ?
       )`,
    ).bind(
      input.ingress.outbox_id,
      input.ingress.event_id,
      input.snapshot.tenantKey,
      input.snapshot.projectKey,
      input.snapshot.workItemTypeKey,
      input.snapshot.workItemId,
      input.snapshot.revision,
      input.exactSnapshotDigest,
      input.mappingSnapshotDigest,
      input.profile.profileVersion,
      input.mappingProfileDigest,
      input.profile.acceptanceCriteriaFieldKey,
      input.profile.ownerRoleKey,
      input.profile.targetRepositoryFieldKey,
      input.snapshotRef,
      input.snapshot.fieldsComplete ? 1 : 0,
      input.snapshot.nextPageToken === null ? 0 : 1,
      input.snapshot.fields.length,
      input.snapshot.roles.length,
      facts.ownerCount,
      facts.targetRepositoryStatus,
      input.taskId,
      input.runId,
      input.now,
      input.ingress.outbox_id,
      input.ingress.event_id,
      input.taskId,
      input.runId,
    ).run();
    if (!mappingLineageMatches(await this.mappingLineage(input.ingress.outbox_id), input)) {
      throw new MeegleWorkItemIngressError('state_conflict');
    }
  }

  private async mappingLineage(outboxId: string): Promise<MappingLineageRow | null> {
    return await this.db.prepare(
      'SELECT * FROM meegle_mapping_lineage WHERE ingress_outbox_id = ?',
    ).bind(outboxId).first<MappingLineageRow>();
  }

  private async ingress(outboxId: string): Promise<IngressRow | null> {
    return await this.db.prepare(
      `SELECT ingress.outbox_id, ingress.delivery_state, ingress.tenant_key,
              ingress.event_id, ingress.queue_observed_at,
              deliveries.status AS delivery_status
       FROM feishu_ingress_outbox AS ingress
       JOIN feishu_webhook_deliveries AS deliveries
         ON deliveries.delivery_id = ingress.delivery_id
       WHERE ingress.outbox_id = ?`,
    ).bind(outboxId).first<IngressRow>();
  }
}
