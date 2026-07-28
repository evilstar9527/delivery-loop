import { canonicalSha256 } from '../domain/digest.js';
import {
  MonitorAdapterProfileV1Schema,
  MonitorAlertWebhookV1Schema,
  monitorAdapterProfileDigest,
  monitorAlertFingerprint,
  monitorAlertResourceDigest,
  monitorAlertSnapshotDigest,
  type MonitorAdapterProfileV1,
  type MonitorAlertSeverity,
  type MonitorAlertWebhookV1,
} from '../domain/monitor-alert.js';
import { SecretScanner } from '../security/redaction.js';
import {
  ImmutableR2ObjectConflictError,
  putImmutableJsonObject,
} from './immutable-r2-object.js';

const MAX_SOURCE_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export type MonitorAlertIngressErrorCode =
  | 'invalid_request'
  | 'repository_not_allowed'
  | 'secret_detected'
  | 'event_conflict'
  | 'storage_unavailable'
  | 'state_conflict';

export class MonitorAlertIngressError extends Error {
  constructor(readonly code: MonitorAlertIngressErrorCode) {
    super(`Monitor alert ingress rejected: ${code}`);
    this.name = 'MonitorAlertIngressError';
  }
}

export interface MonitorAlertIngressResult {
  eventId: string;
  receiptId: string;
  candidateId: string;
  disposition: 'created' | 'suppressed' | 'duplicate';
  occurrenceCount: number;
}

interface ReceiptRow {
  receipt_id: string;
  lineage_id: string;
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
  severity: MonitorAlertSeverity;
  suppression_window_ms: number;
  occurred_at: string;
}

interface ProjectionRow extends ReceiptRow {
  candidate_id: string;
  occurrence_ordinal: number;
  suppressed: number;
  candidate_occurrence_count: number;
}

interface CandidateRow {
  candidate_id: string;
  adapter: 'generic';
  tenant_key: string;
  repository: string;
  alert_rule_id: string;
  environment: 'none' | 'test' | 'production';
  severity: MonitorAlertSeverity;
  status: 'triaging';
  suppression_window_ms: number;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  suppression_expires_at: string;
  created_at: string;
  updated_at: string;
  lineage_count: number;
}

export interface MonitorAlertCandidateSummary {
  candidateId: string;
  status: 'triaging';
  adapter: 'generic';
  tenantKey: string;
  repository: string;
  alertRuleId: string;
  environment: 'none' | 'test' | 'production';
  severity: MonitorAlertSeverity;
  suppressionWindowMs: number;
  occurrenceCount: number;
  lineageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  suppressionExpiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export class MonitorAlertCandidateStore {
  constructor(private readonly db: D1Database) {}

  async list(limit = 50): Promise<MonitorAlertCandidateSummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new MonitorAlertIngressError('state_conflict');
    }
    const { results } = await this.db.prepare(
      `SELECT candidates.candidate_id, candidates.adapter, candidates.tenant_key,
              candidates.repository, candidates.alert_rule_id,
              candidates.environment, candidates.severity, candidates.status,
              candidates.suppression_window_ms, candidates.occurrence_count,
              candidates.first_seen_at, candidates.last_seen_at,
              candidates.suppression_expires_at, candidates.created_at,
              candidates.updated_at,
              (SELECT COUNT(*) FROM monitor_alert_lineage AS lineage
               WHERE lineage.candidate_id = candidates.candidate_id) AS lineage_count
       FROM monitor_alert_candidates AS candidates
       WHERE candidates.status = 'triaging'
       ORDER BY candidates.first_seen_at, candidates.candidate_id
       LIMIT ?`,
    ).bind(limit).all<CandidateRow>();
    return results.map((row) => ({
      candidateId: row.candidate_id,
      status: row.status,
      adapter: row.adapter,
      tenantKey: row.tenant_key,
      repository: row.repository,
      alertRuleId: row.alert_rule_id,
      environment: row.environment,
      severity: row.severity,
      suppressionWindowMs: row.suppression_window_ms,
      occurrenceCount: row.occurrence_count,
      lineageCount: row.lineage_count,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      suppressionExpiresAt: row.suppression_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}

export class MonitorAlertIngressStore {
  private readonly profile: MonitorAdapterProfileV1;
  private readonly secrets: readonly string[];

  constructor(
    private readonly db: D1Database,
    private readonly objects: R2Bucket,
    options: { profile: MonitorAdapterProfileV1; secrets?: readonly string[] },
  ) {
    this.profile = MonitorAdapterProfileV1Schema.parse(options.profile);
    this.secrets = options.secrets ?? [];
  }

  async accept(
    rawEvent: MonitorAlertWebhookV1,
    now = new Date(),
  ): Promise<MonitorAlertIngressResult> {
    const parsed = MonitorAlertWebhookV1Schema.safeParse(rawEvent);
    if (!parsed.success || !Number.isFinite(now.getTime())) {
      throw new MonitorAlertIngressError('invalid_request');
    }
    const event = parsed.data;
    const occurredAt = Date.parse(event.occurredAt);
    if (
      !Number.isFinite(occurredAt) ||
      occurredAt < now.getTime() - MAX_SOURCE_AGE_MS ||
      occurredAt > now.getTime() + MAX_FUTURE_SKEW_MS
    ) throw new MonitorAlertIngressError('invalid_request');
    if (!this.profile.allowedRepositories.includes(event.alert.repository)) {
      throw new MonitorAlertIngressError('repository_not_allowed');
    }
    if (new SecretScanner({ secrets: [...this.secrets] }).scan(event).length > 0) {
      throw new MonitorAlertIngressError('secret_detected');
    }

    const [profileDigest, exactSnapshotDigest, fingerprintDigest, resourceDigest] =
      await Promise.all([
        monitorAdapterProfileDigest(this.profile),
        monitorAlertSnapshotDigest(event),
        monitorAlertFingerprint(event, this.profile),
        monitorAlertResourceDigest(event.alert.resourceKey),
      ]);
    const receiptIdentity = await canonicalSha256({
      adapter: this.profile.adapter,
      tenantKey: this.profile.tenantKey,
      eventId: event.eventId,
    });
    const receiptId = `monitor_receipt_${this.suffix(receiptIdentity, 48)}`;
    const lineageId = `monitor_lineage_${this.suffix(receiptIdentity, 48)}`;
    const candidateIdentity = await canonicalSha256({
      fingerprintDigest,
      eventId: event.eventId,
    });
    const proposedCandidateId = `monitor_triage_${this.suffix(candidateIdentity, 48)}`;
    const snapshotKey = `monitor-alerts/${this.suffix(exactSnapshotDigest, 64)}.json`;
    const snapshotRef = `r2://${snapshotKey}`;
    const expected = {
      receiptId,
      lineageId,
      profileDigest,
      exactSnapshotDigest,
      fingerprintDigest,
      resourceDigest,
      snapshotRef,
      event,
    };

    const existing = await this.receipt(event.eventId);
    if (existing !== null) return await this.duplicate(existing, expected);

    try {
      await putImmutableJsonObject(this.objects, {
        key: snapshotKey,
        body: JSON.stringify(event),
        metadata: { exactSnapshotDigest, fingerprintDigest, profileDigest },
      });
    } catch (error) {
      if (error instanceof ImmutableR2ObjectConflictError) {
        throw new MonitorAlertIngressError('event_conflict');
      }
      throw new MonitorAlertIngressError('storage_unavailable');
    }

    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.profile.suppressionWindowMs).toISOString();
    let result: D1Result<unknown>;
    try {
      result = await this.db.prepare(
        `INSERT INTO monitor_alert_receipts (
           receipt_id, lineage_id, adapter, tenant_key, external_event_id,
           exact_snapshot_digest, snapshot_ref, profile_digest, fingerprint_digest,
           proposed_candidate_id, repository, alert_rule_id, resource_digest,
           environment, severity, suppression_window_ms, occurred_at, received_at,
           proposed_expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        receiptId,
        lineageId,
        this.profile.adapter,
        this.profile.tenantKey,
        event.eventId,
        exactSnapshotDigest,
        snapshotRef,
        profileDigest,
        fingerprintDigest,
        proposedCandidateId,
        event.alert.repository,
        event.alert.ruleId,
        resourceDigest,
        event.alert.environment,
        event.alert.severity,
        this.profile.suppressionWindowMs,
        event.occurredAt,
        nowIso,
        expiresAt,
        nowIso,
      ).run();
    } catch {
      throw new MonitorAlertIngressError('state_conflict');
    }

    const projection = await this.projection(event.eventId);
    if (projection === null) throw new MonitorAlertIngressError('state_conflict');
    this.assertReceipt(projection, expected);
    if (result.meta.changes === 0) {
      return this.result(projection, 'duplicate');
    }
    return this.result(projection, projection.suppressed === 1 ? 'suppressed' : 'created');
  }

  private async duplicate(
    row: ReceiptRow,
    expected: ExpectedReceipt,
  ): Promise<MonitorAlertIngressResult> {
    this.assertReceipt(row, expected);
    const projection = await this.projection(expected.event.eventId);
    if (projection === null) throw new MonitorAlertIngressError('state_conflict');
    return this.result(projection, 'duplicate');
  }

  private assertReceipt(row: ReceiptRow, expected: ExpectedReceipt): void {
    const event = expected.event;
    if (
      row.receipt_id !== expected.receiptId || row.lineage_id !== expected.lineageId ||
      row.adapter !== this.profile.adapter || row.tenant_key !== this.profile.tenantKey ||
      row.external_event_id !== event.eventId ||
      row.exact_snapshot_digest !== expected.exactSnapshotDigest ||
      row.snapshot_ref !== expected.snapshotRef || row.profile_digest !== expected.profileDigest ||
      row.fingerprint_digest !== expected.fingerprintDigest ||
      row.repository !== event.alert.repository || row.alert_rule_id !== event.alert.ruleId ||
      row.resource_digest !== expected.resourceDigest ||
      row.environment !== event.alert.environment || row.severity !== event.alert.severity ||
      row.suppression_window_ms !== this.profile.suppressionWindowMs ||
      row.occurred_at !== event.occurredAt
    ) throw new MonitorAlertIngressError('event_conflict');
  }

  private result(
    row: ProjectionRow,
    disposition: MonitorAlertIngressResult['disposition'],
  ): MonitorAlertIngressResult {
    if (
      row.candidate_id.length === 0 || row.occurrence_ordinal < 1 ||
      row.candidate_occurrence_count < row.occurrence_ordinal ||
      (row.suppressed === 0) !== (row.occurrence_ordinal === 1)
    ) throw new MonitorAlertIngressError('state_conflict');
    return {
      eventId: row.external_event_id,
      receiptId: row.receipt_id,
      candidateId: row.candidate_id,
      disposition,
      occurrenceCount: row.candidate_occurrence_count,
    };
  }

  private async receipt(eventId: string): Promise<ReceiptRow | null> {
    return await this.db.prepare(
      `SELECT receipt_id, lineage_id, adapter, tenant_key, external_event_id,
              exact_snapshot_digest, snapshot_ref, profile_digest,
              fingerprint_digest, repository, alert_rule_id, resource_digest,
              environment, severity, suppression_window_ms, occurred_at
       FROM monitor_alert_receipts
       WHERE adapter = ? AND tenant_key = ? AND external_event_id = ?`,
    ).bind(this.profile.adapter, this.profile.tenantKey, eventId).first<ReceiptRow>();
  }

  private async projection(eventId: string): Promise<ProjectionRow | null> {
    return await this.db.prepare(
      `SELECT receipts.receipt_id, receipts.lineage_id, receipts.adapter,
              receipts.tenant_key, receipts.external_event_id,
              receipts.exact_snapshot_digest, receipts.snapshot_ref,
              receipts.profile_digest, receipts.fingerprint_digest,
              receipts.repository, receipts.alert_rule_id, receipts.resource_digest,
              receipts.environment, receipts.severity,
              receipts.suppression_window_ms, receipts.occurred_at,
              lineage.candidate_id, lineage.occurrence_ordinal, lineage.suppressed,
              candidates.occurrence_count AS candidate_occurrence_count
       FROM monitor_alert_receipts AS receipts
       JOIN monitor_alert_lineage AS lineage ON lineage.receipt_id = receipts.receipt_id
       JOIN monitor_alert_candidates AS candidates
         ON candidates.candidate_id = lineage.candidate_id
       WHERE receipts.adapter = ? AND receipts.tenant_key = ?
         AND receipts.external_event_id = ?`,
    ).bind(this.profile.adapter, this.profile.tenantKey, eventId).first<ProjectionRow>();
  }

  private suffix(digest: string, length: number): string {
    return digest.slice('sha256:'.length, 'sha256:'.length + length);
  }
}

interface ExpectedReceipt {
  receiptId: string;
  lineageId: string;
  profileDigest: string;
  exactSnapshotDigest: string;
  fingerprintDigest: string;
  resourceDigest: string;
  snapshotRef: string;
  event: MonitorAlertWebhookV1;
}
