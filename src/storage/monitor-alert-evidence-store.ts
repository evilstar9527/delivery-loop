import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import {
  MonitorAlertWebhookV1Schema,
  monitorAlertResourceDigest,
  monitorAlertSnapshotDigest,
} from '../domain/monitor-alert.js';

const QuerySchema = z.object({
  tenantKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/),
  eventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),
}).strict();
const MAX_SNAPSHOT_BYTES = 256 * 1_024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

interface ProjectionRow {
  receipt_id: string;
  receipt_lineage_id: string;
  adapter: 'generic';
  tenant_key: string;
  external_event_id: string;
  exact_snapshot_digest: string;
  snapshot_ref: string;
  profile_digest: string;
  fingerprint_digest: string;
  repository: string;
  alert_rule_id: string;
  resource_digest: string;
  environment: 'none' | 'test' | 'production';
  severity: 'info' | 'warning' | 'error' | 'critical';
  suppression_window_ms: number;
  occurred_at: string;
  received_at: string;
  lineage_id: string;
  candidate_id: string;
  occurrence_ordinal: number;
  suppressed: number;
  candidate_status: 'triaging';
  candidate_occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  suppression_expires_at: string;
  candidate_created_at: string;
  candidate_updated_at: string;
  candidate_lineage_count: number;
}

interface CountRow {
  receipts: number;
  lineages: number;
  candidates: number;
  task_sources: number;
  runs: number;
  approvals: number;
  outboxes: number;
}

export interface MonitorAlertEvidenceProjection {
  schemaVersion: '1';
  adapter: 'generic';
  tenantKey: string;
  eventId: string;
  found: boolean;
  counts: {
    receipts: number;
    lineages: number;
    candidates: number;
    taskSources: number;
    runs: number;
    approvals: number;
    outboxes: number;
  };
  receipt: {
    receiptId: string;
    lineageId: string;
    candidateId: string;
    occurrenceOrdinal: number;
    suppressed: boolean;
    occurredAt: string;
    receivedAt: string;
  } | null;
  mapping: {
    repository: string;
    alertRuleId: string;
    environment: 'none' | 'test' | 'production';
    severity: 'info' | 'warning' | 'error' | 'critical';
    suppressionWindowMs: number;
  } | null;
  candidate: {
    candidateId: string;
    status: 'triaging';
    occurrenceCount: number;
    lineageCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    suppressionExpiresAt: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  snapshot: {
    objectPresent: boolean;
    objectVerified: boolean;
  } | null;
}

export class MonitorAlertEvidenceStoreError extends Error {
  constructor(readonly code: 'invalid_query' | 'projection_conflict') {
    super(`Monitor alert evidence projection failed: ${code}`);
    this.name = 'MonitorAlertEvidenceStoreError';
  }
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/** Operations-only exact-event view. Alert prose, resource, digests and R2 refs stay private. */
export class MonitorAlertEvidenceStore {
  constructor(
    private readonly db: D1Database,
    private readonly objects: R2Bucket,
  ) {}

  async get(rawQuery: { tenantKey: string; eventId: string }): Promise<MonitorAlertEvidenceProjection> {
    const parsed = QuerySchema.safeParse(rawQuery);
    if (!parsed.success) throw new MonitorAlertEvidenceStoreError('invalid_query');
    const { tenantKey, eventId } = parsed.data;
    const results = await this.db.batch([
      this.db.prepare(
        `SELECT receipts.receipt_id, receipts.lineage_id AS receipt_lineage_id,
                receipts.adapter, receipts.tenant_key, receipts.external_event_id,
                receipts.exact_snapshot_digest, receipts.snapshot_ref,
                receipts.profile_digest, receipts.fingerprint_digest,
                receipts.repository, receipts.alert_rule_id, receipts.resource_digest,
                receipts.environment, receipts.severity, receipts.suppression_window_ms,
                receipts.occurred_at, receipts.received_at,
                lineage.lineage_id, lineage.candidate_id,
                lineage.occurrence_ordinal, lineage.suppressed,
                candidates.status AS candidate_status,
                candidates.occurrence_count AS candidate_occurrence_count,
                candidates.first_seen_at, candidates.last_seen_at,
                candidates.suppression_expires_at,
                candidates.created_at AS candidate_created_at,
                candidates.updated_at AS candidate_updated_at,
                (SELECT COUNT(*) FROM monitor_alert_lineage AS candidate_lineage
                  WHERE candidate_lineage.candidate_id = candidates.candidate_id)
                  AS candidate_lineage_count
         FROM monitor_alert_receipts AS receipts
         JOIN monitor_alert_lineage AS lineage ON lineage.receipt_id = receipts.receipt_id
         JOIN monitor_alert_candidates AS candidates
           ON candidates.candidate_id = lineage.candidate_id
         WHERE receipts.adapter = 'generic' AND receipts.tenant_key = ?
           AND receipts.external_event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM monitor_alert_receipts
             WHERE adapter = 'generic' AND tenant_key = ?
               AND external_event_id = ?) AS receipts,
           (SELECT COUNT(*) FROM monitor_alert_lineage AS lineage
              JOIN monitor_alert_receipts AS receipt ON receipt.receipt_id = lineage.receipt_id
             WHERE receipt.adapter = 'generic' AND receipt.tenant_key = ?
               AND receipt.external_event_id = ?) AS lineages,
           (SELECT COUNT(DISTINCT lineage.candidate_id)
              FROM monitor_alert_lineage AS lineage
              JOIN monitor_alert_receipts AS receipt ON receipt.receipt_id = lineage.receipt_id
             WHERE receipt.adapter = 'generic' AND receipt.tenant_key = ?
               AND receipt.external_event_id = ?) AS candidates,
           (SELECT COUNT(*) FROM tasks
             WHERE source_system = 'monitor' AND tenant_key = ?
               AND source_task_key = ?) AS task_sources,
           (SELECT COUNT(*) FROM runs JOIN tasks ON tasks.task_id = runs.task_id
             WHERE tasks.source_system = 'monitor' AND tasks.tenant_key = ?
               AND tasks.source_task_key = ?) AS runs,
           (SELECT COUNT(*) FROM approvals
              JOIN runs ON runs.run_id = approvals.run_id
              JOIN tasks ON tasks.task_id = runs.task_id
             WHERE tasks.source_system = 'monitor' AND tasks.tenant_key = ?
               AND tasks.source_task_key = ?) AS approvals,
           (SELECT COUNT(*) FROM outbox
              JOIN runs ON runs.run_id = outbox.run_id
              JOIN tasks ON tasks.task_id = runs.task_id
             WHERE tasks.source_system = 'monitor' AND tasks.tenant_key = ?
               AND tasks.source_task_key = ?) AS outboxes`,
      ).bind(
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
      ),
    ]);
    const rows = (results[0]?.results ?? []) as unknown as ProjectionRow[];
    const counts = (results[1]?.results[0] ?? null) as unknown as CountRow | null;
    if (
      counts === null || rows.length > 1 || !Object.values(counts).every(validCount) ||
      counts.receipts !== rows.length || counts.lineages !== rows.length ||
      counts.candidates !== rows.length
    ) throw new MonitorAlertEvidenceStoreError('projection_conflict');
    const row = rows[0];
    if (row === undefined) return {
      schemaVersion: '1',
      adapter: 'generic',
      tenantKey,
      eventId,
      found: false,
      counts: this.counts(counts),
      receipt: null,
      mapping: null,
      candidate: null,
      snapshot: null,
    };
    if (
      row.receipt_lineage_id !== row.lineage_id || row.tenant_key !== tenantKey ||
      row.external_event_id !== eventId || row.adapter !== 'generic' ||
      !DIGEST_PATTERN.test(row.exact_snapshot_digest) ||
      !DIGEST_PATTERN.test(row.profile_digest) ||
      !DIGEST_PATTERN.test(row.fingerprint_digest) ||
      !DIGEST_PATTERN.test(row.resource_digest) || row.candidate_status !== 'triaging' ||
      !Number.isSafeInteger(row.occurrence_ordinal) || row.occurrence_ordinal < 1 ||
      !Number.isSafeInteger(row.candidate_occurrence_count) ||
      row.candidate_occurrence_count < row.occurrence_ordinal ||
      row.candidate_lineage_count !== row.candidate_occurrence_count ||
      (row.suppressed === 0) !== (row.occurrence_ordinal === 1) ||
      ![0, 1].includes(row.suppressed) ||
      !Number.isSafeInteger(row.suppression_window_ms) ||
      row.suppression_window_ms < 60_000 || row.suppression_window_ms > 86_400_000 ||
      ![row.occurred_at, row.received_at, row.first_seen_at, row.last_seen_at,
        row.suppression_expires_at, row.candidate_created_at, row.candidate_updated_at]
        .every(validTimestamp)
    ) throw new MonitorAlertEvidenceStoreError('projection_conflict');
    const snapshot = await this.verifySnapshot(row);
    return {
      schemaVersion: '1',
      adapter: 'generic',
      tenantKey,
      eventId,
      found: true,
      counts: this.counts(counts),
      receipt: {
        receiptId: row.receipt_id,
        lineageId: row.lineage_id,
        candidateId: row.candidate_id,
        occurrenceOrdinal: row.occurrence_ordinal,
        suppressed: row.suppressed === 1,
        occurredAt: row.occurred_at,
        receivedAt: row.received_at,
      },
      mapping: {
        repository: row.repository,
        alertRuleId: row.alert_rule_id,
        environment: row.environment,
        severity: row.severity,
        suppressionWindowMs: row.suppression_window_ms,
      },
      candidate: {
        candidateId: row.candidate_id,
        status: 'triaging',
        occurrenceCount: row.candidate_occurrence_count,
        lineageCount: row.candidate_lineage_count,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        suppressionExpiresAt: row.suppression_expires_at,
        createdAt: row.candidate_created_at,
        updatedAt: row.candidate_updated_at,
      },
      snapshot,
    };
  }

  private counts(row: CountRow): MonitorAlertEvidenceProjection['counts'] {
    return {
      receipts: row.receipts,
      lineages: row.lineages,
      candidates: row.candidates,
      taskSources: row.task_sources,
      runs: row.runs,
      approvals: row.approvals,
      outboxes: row.outboxes,
    };
  }

  private async verifySnapshot(row: ProjectionRow): Promise<{
    objectPresent: boolean;
    objectVerified: boolean;
  }> {
    if (!row.snapshot_ref.startsWith('r2://monitor-alerts/')) {
      return { objectPresent: false, objectVerified: false };
    }
    const key = row.snapshot_ref.slice('r2://'.length);
    let object: R2ObjectBody | null;
    try { object = await this.objects.get(key); }
    catch { return { objectPresent: false, objectVerified: false }; }
    if (object === null) return { objectPresent: false, objectVerified: false };
    if (object.size > MAX_SNAPSHOT_BYTES) {
      await object.body.cancel();
      return { objectPresent: true, objectVerified: false };
    }
    let raw: unknown;
    try { raw = JSON.parse(await object.text()) as unknown; }
    catch { return { objectPresent: true, objectVerified: false }; }
    const parsed = MonitorAlertWebhookV1Schema.safeParse(raw);
    if (!parsed.success) return { objectPresent: true, objectVerified: false };
    const event = parsed.data;
    const expectedFingerprint = await canonicalSha256({
      schemaVersion: '1',
      adapter: row.adapter,
      tenantKey: row.tenant_key,
      profileDigest: row.profile_digest,
      ruleId: event.alert.ruleId,
      resourceKey: event.alert.resourceKey,
      repository: event.alert.repository,
      environment: event.alert.environment,
      severity: event.alert.severity,
    });
    const metadata = object.customMetadata ?? {};
    return {
      objectPresent: true,
      objectVerified:
        await monitorAlertSnapshotDigest(event) === row.exact_snapshot_digest &&
        await monitorAlertResourceDigest(event.alert.resourceKey) === row.resource_digest &&
        expectedFingerprint === row.fingerprint_digest &&
        metadata.exactSnapshotDigest === row.exact_snapshot_digest &&
        metadata.profileDigest === row.profile_digest &&
        metadata.fingerprintDigest === row.fingerprint_digest &&
        event.eventId === row.external_event_id && event.occurredAt === row.occurred_at &&
        event.alert.repository === row.repository && event.alert.ruleId === row.alert_rule_id &&
        event.alert.environment === row.environment && event.alert.severity === row.severity,
    };
  }
}
