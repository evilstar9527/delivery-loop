import { z } from 'zod';
import {
  MeegleTriageGapSchema,
  MeegleWorkItemSnapshotV1Schema,
  meegleExactSnapshotDigest,
  meegleMappingSnapshotDigest,
} from '../domain/meegle-work-item.js';

const QuerySchema = z.object({
  tenantKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/),
  eventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/),
}).strict();
const MAX_SNAPSHOT_BYTES = 2 * 1_024 * 1_024;

interface LineageRow {
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
  candidate_id: string | null;
  task_id: string | null;
  run_id: string | null;
}

interface MappedRow {
  source_task_key: string;
  task_revision: string;
  task_digest: string;
  task_id: string;
  run_id: string;
  workflow_instance_id: string;
  workflow_create_outbox_id: string;
  workflow_create_state: 'pending' | 'delivering' | 'settled';
}

interface TriageRow {
  candidate_id: string;
  gaps_json: string;
  lineage_count: number;
}

interface CountRow {
  mapping_lineages: number;
  mapped_lineages: number;
  triage_lineages: number;
  tasks: number;
  runs: number;
  workflow_create_outboxes: number;
}

export interface MeegleWorkItemEvidenceProjection {
  schemaVersion: '1';
  tenantKey: string;
  eventId: string;
  outcome: 'mapped' | 'triaging' | null;
  counts: {
    mappingLineages: number;
    mappedLineages: number;
    triageLineages: number;
    tasks: number;
    runs: number;
    workflowCreateOutboxes: number;
  };
  lineage: {
    ingressOutboxId: string;
    projectKey: string;
    workItemTypeKey: string;
    workItemId: string;
    revision: string | null;
    exactSnapshotDigest: string;
    mappingSnapshotDigest: string;
    mappingProfileVersion: number;
    mappingProfileDigest: string;
    acceptanceCriteriaFieldKey: string;
    ownerRoleKey: string;
    targetRepositoryFieldKey: string;
    fieldsComplete: boolean;
    hasNextPageToken: boolean;
    fieldCount: number;
    roleCount: number;
    ownerCount: number;
    targetRepositoryStatus: 'allowed' | 'missing' | 'invalid';
    snapshotObjectPresent: boolean;
    snapshotDigestVerified: boolean;
  } | null;
  mapped: {
    sourceTaskKey: string;
    taskRevision: string;
    taskDigest: string;
    taskId: string;
    runId: string;
    workflowInstanceId: string;
    workflowCreateOutboxId: string;
    workflowCreateState: 'pending' | 'delivering' | 'settled';
  } | null;
  triage: {
    candidateId: string;
    gaps: z.infer<typeof MeegleTriageGapSchema>[];
    lineageCount: number;
  } | null;
}

export class MeegleWorkItemEvidenceStoreError extends Error {
  constructor(readonly code: 'invalid_query' | 'projection_conflict') {
    super(`Meegle work-item evidence projection failed: ${code}`);
    this.name = 'MeegleWorkItemEvidenceStoreError';
  }
}

function countIsValid(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseGaps(raw: string): z.infer<typeof MeegleTriageGapSchema>[] {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new MeegleWorkItemEvidenceStoreError('projection_conflict'); }
  const parsed = z.array(MeegleTriageGapSchema).nonempty().safeParse(value);
  if (!parsed.success) throw new MeegleWorkItemEvidenceStoreError('projection_conflict');
  return parsed.data;
}

export class MeegleWorkItemEvidenceStore {
  constructor(
    private readonly db: D1Database,
    private readonly objects: R2Bucket,
  ) {}

  async get(rawQuery: {
    tenantKey: string;
    eventId: string;
  }): Promise<MeegleWorkItemEvidenceProjection> {
    const parsed = QuerySchema.safeParse(rawQuery);
    if (!parsed.success) throw new MeegleWorkItemEvidenceStoreError('invalid_query');
    const { tenantKey, eventId } = parsed.data;
    const results = await this.db.batch([
      this.db.prepare(
        `SELECT * FROM meegle_mapping_lineage
         WHERE tenant_key = ? AND event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT task.source_task_key, task.task_revision, task.task_digest, task.task_id,
                run.run_id, run.workflow_instance_id,
                effect.outbox_id AS workflow_create_outbox_id,
                effect.delivery_state AS workflow_create_state
         FROM meegle_mapping_lineage AS lineage
         JOIN tasks AS task ON task.task_id = lineage.task_id
         JOIN runs AS run ON run.run_id = lineage.run_id
         JOIN outbox AS effect ON effect.run_id = run.run_id
           AND effect.kind = 'workflow_create'
         WHERE lineage.tenant_key = ? AND lineage.event_id = ?
           AND lineage.outcome = 'mapped'`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT candidate.candidate_id, candidate.gaps_json,
                (SELECT COUNT(*) FROM meegle_triage_lineage AS triage_lineage
                  WHERE triage_lineage.candidate_id = candidate.candidate_id) AS lineage_count
         FROM meegle_mapping_lineage AS lineage
         JOIN meegle_triage_candidates AS candidate
           ON candidate.candidate_id = lineage.candidate_id
         WHERE lineage.tenant_key = ? AND lineage.event_id = ?
           AND lineage.outcome = 'triaging'`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM meegle_mapping_lineage
             WHERE tenant_key = ? AND event_id = ?) AS mapping_lineages,
           (SELECT COUNT(*) FROM meegle_mapping_lineage
             WHERE tenant_key = ? AND event_id = ? AND outcome = 'mapped') AS mapped_lineages,
           (SELECT COUNT(*) FROM meegle_triage_lineage AS triage_lineage
              JOIN meegle_mapping_lineage AS lineage
                ON lineage.ingress_outbox_id = triage_lineage.ingress_outbox_id
             WHERE lineage.tenant_key = ? AND lineage.event_id = ?) AS triage_lineages,
           (SELECT COUNT(*) FROM tasks AS task
              JOIN meegle_mapping_lineage AS lineage ON lineage.task_id = task.task_id
             WHERE lineage.tenant_key = ? AND lineage.event_id = ?) AS tasks,
           (SELECT COUNT(*) FROM runs AS run
              JOIN meegle_mapping_lineage AS lineage ON lineage.run_id = run.run_id
             WHERE lineage.tenant_key = ? AND lineage.event_id = ?) AS runs,
           (SELECT COUNT(*) FROM outbox AS effect
              JOIN meegle_mapping_lineage AS lineage ON lineage.run_id = effect.run_id
             WHERE lineage.tenant_key = ? AND lineage.event_id = ?
               AND effect.kind = 'workflow_create') AS workflow_create_outboxes`,
      ).bind(
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
      ),
    ]);
    const lineageRows = (results[0]?.results ?? []) as unknown as LineageRow[];
    const mappedRows = (results[1]?.results ?? []) as unknown as MappedRow[];
    const triageRows = (results[2]?.results ?? []) as unknown as TriageRow[];
    const counts = (results[3]?.results[0] ?? null) as unknown as CountRow | null;
    if (
      counts === null || lineageRows.length > 1 || mappedRows.length > 1 ||
      triageRows.length > 1 || !Object.values(counts).every(countIsValid) ||
      counts.mapping_lineages !== lineageRows.length ||
      counts.mapped_lineages !== mappedRows.length ||
      (counts.triage_lineages === 0) !== (triageRows.length === 0)
    ) throw new MeegleWorkItemEvidenceStoreError('projection_conflict');

    const lineage = lineageRows[0];
    const mapped = mappedRows[0];
    const triage = triageRows[0];
    if (
      lineage !== undefined &&
      ((lineage.outcome === 'mapped' && (mapped === undefined || triage !== undefined)) ||
        (lineage.outcome === 'triaging' && (mapped !== undefined || triage === undefined)))
    ) throw new MeegleWorkItemEvidenceStoreError('projection_conflict');

    const objectVerification = lineage === undefined
      ? { present: false, verified: false }
      : await this.verifySnapshot(lineage);
    return {
      schemaVersion: '1',
      tenantKey,
      eventId,
      outcome: lineage?.outcome ?? null,
      counts: {
        mappingLineages: counts.mapping_lineages,
        mappedLineages: counts.mapped_lineages,
        triageLineages: counts.triage_lineages,
        tasks: counts.tasks,
        runs: counts.runs,
        workflowCreateOutboxes: counts.workflow_create_outboxes,
      },
      lineage: lineage === undefined ? null : {
        ingressOutboxId: lineage.ingress_outbox_id,
        projectKey: lineage.project_key,
        workItemTypeKey: lineage.work_item_type_key,
        workItemId: lineage.work_item_id,
        revision: lineage.external_revision,
        exactSnapshotDigest: lineage.exact_snapshot_digest,
        mappingSnapshotDigest: lineage.mapping_snapshot_digest,
        mappingProfileVersion: lineage.mapping_profile_version,
        mappingProfileDigest: lineage.mapping_profile_digest,
        acceptanceCriteriaFieldKey: lineage.acceptance_criteria_field_key,
        ownerRoleKey: lineage.owner_role_key,
        targetRepositoryFieldKey: lineage.target_repository_field_key,
        fieldsComplete: lineage.fields_complete === 1,
        hasNextPageToken: lineage.has_next_page_token === 1,
        fieldCount: lineage.field_count,
        roleCount: lineage.role_count,
        ownerCount: lineage.owner_count,
        targetRepositoryStatus: lineage.target_repository_status,
        snapshotObjectPresent: objectVerification.present,
        snapshotDigestVerified: objectVerification.verified,
      },
      mapped: mapped === undefined ? null : {
        sourceTaskKey: mapped.source_task_key,
        taskRevision: mapped.task_revision,
        taskDigest: mapped.task_digest,
        taskId: mapped.task_id,
        runId: mapped.run_id,
        workflowInstanceId: mapped.workflow_instance_id,
        workflowCreateOutboxId: mapped.workflow_create_outbox_id,
        workflowCreateState: mapped.workflow_create_state,
      },
      triage: triage === undefined ? null : {
        candidateId: triage.candidate_id,
        gaps: parseGaps(triage.gaps_json),
        lineageCount: triage.lineage_count,
      },
    };
  }

  private async verifySnapshot(lineage: LineageRow): Promise<{
    present: boolean;
    verified: boolean;
  }> {
    if (!lineage.snapshot_ref.startsWith('r2://meegle-snapshots/')) {
      return { present: false, verified: false };
    }
    const key = lineage.snapshot_ref.slice('r2://'.length);
    let object: R2ObjectBody | null;
    try { object = await this.objects.get(key); }
    catch { return { present: false, verified: false }; }
    if (object === null) return { present: false, verified: false };
    if (object.size > MAX_SNAPSHOT_BYTES) {
      await object.body.cancel();
      return { present: true, verified: false };
    }
    let raw: unknown;
    try { raw = JSON.parse(await object.text()) as unknown; }
    catch { return { present: true, verified: false }; }
    const snapshot = MeegleWorkItemSnapshotV1Schema.safeParse(raw);
    if (!snapshot.success) return { present: true, verified: false };
    const value = snapshot.data;
    const custom = object.customMetadata ?? {};
    return {
      present: true,
      verified:
        await meegleExactSnapshotDigest(value) === lineage.exact_snapshot_digest &&
        await meegleMappingSnapshotDigest(value) === lineage.mapping_snapshot_digest &&
        custom.exactSnapshotDigest === lineage.exact_snapshot_digest &&
        custom.mappingSnapshotDigest === lineage.mapping_snapshot_digest &&
        custom.mappingProfileDigest === lineage.mapping_profile_digest &&
        value.eventId === lineage.event_id && value.tenantKey === lineage.tenant_key &&
        value.projectKey === lineage.project_key &&
        value.workItemTypeKey === lineage.work_item_type_key &&
        value.workItemId === lineage.work_item_id &&
        value.revision === lineage.external_revision &&
        value.fieldsComplete === (lineage.fields_complete === 1) &&
        (value.nextPageToken !== null) === (lineage.has_next_page_token === 1) &&
        value.fields.length === lineage.field_count && value.roles.length === lineage.role_count &&
        (value.roles.find((role) => role.roleKey === lineage.owner_role_key)?.owners.length ?? 0) ===
          lineage.owner_count,
    };
  }
}
