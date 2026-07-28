import { IdentityMapper, ANONYMOUS_PRINCIPAL } from '../auth/identity-mapper.js';
import { canonicalSha256 } from '../domain/digest.js';
import {
  QUOTA_RESOURCES,
  QuotaOverrideInputSchema,
  type QuotaOverrideInput,
} from '../domain/quota.js';

const MAX_SOURCE_AGE_MS = 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_OVERRIDE_TTL_MS = 4 * 60 * 60_000;

export type QuotaOverrideErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'state_conflict'
  | 'source_conflict'
  | 'not_p0';

export class QuotaOverrideError extends Error {
  constructor(readonly code: QuotaOverrideErrorCode) {
    super(`quota override failed: ${code}`);
    this.name = 'QuotaOverrideError';
  }
}

export interface QuotaOverrideStoreOptions {
  now?: () => Date;
}

interface CandidateRow {
  run_id: string;
  run_version: number;
  priority: string;
  tenant_key: string;
  repository: string;
  actor_type: string;
  actor_id: string;
}

interface SourceRow {
  source_id: string;
  provider: string;
  tenant_key: string;
  external_event_id: string;
  external_subject: string;
  event_digest: string;
  request_digest: string;
  occurred_at: string;
}

interface OverrideRow {
  override_id: string;
  source_id: string;
  run_id: string;
  expected_run_version: number;
  resources_json: string;
  reason_digest: string;
  approver_principal: string | null;
  multiplier: number;
  decision: string;
  status: string;
  rejection_reason: string | null;
  expires_at: string;
}

export interface QuotaOverrideResult {
  overrideId: string;
  sourceId: string;
  runId: string;
  status: 'approved' | 'rejected' | 'identity_rejected';
  principal: string | null;
  multiplier: 2;
  rejectionReason: string | null;
  expiresAt: string;
  created: boolean;
}

/** P0 override is a bounded human decision, not a Task priority side effect. */
export class QuotaOverrideStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: D1Database,
    options: QuotaOverrideStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async decide(rawInput: unknown): Promise<QuotaOverrideResult> {
    const parsed = QuotaOverrideInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new QuotaOverrideError('invalid_request');
    const input = this.normalized(parsed.data);
    const now = this.now();
    this.assertTimes(input, now);
    const candidate = await this.candidate(input.runId);
    if (candidate === null) throw new QuotaOverrideError('not_found');
    if (candidate.priority !== 'p0') throw new QuotaOverrideError('not_p0');
    if (candidate.run_version !== input.expectedRunVersion) {
      throw new QuotaOverrideError('state_conflict');
    }

    const requestDigest = await canonicalSha256(input);
    const sourceIdentity = await canonicalSha256({
      provider: input.source.provider,
      tenantKey: input.source.tenantKey,
      externalEventId: input.source.externalEventId,
    });
    const sourceId = `quota_override_source_${this.suffix(sourceIdentity, 42)}`;
    const existingSource = await this.source(sourceId);
    if (existingSource !== null) {
      this.assertSource(existingSource, input, requestDigest);
      const existing = await this.outcome(sourceId);
      if (existing === null) throw new QuotaOverrideError('source_conflict');
      return this.result(existing, false);
    }
    const nowIso = now.toISOString();
    await this.db.prepare(
      `INSERT INTO quota_override_source_events (
         source_id, provider, tenant_key, external_event_id, external_subject,
         event_digest, request_digest, occurred_at, received_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      sourceId,
      input.source.provider,
      input.source.tenantKey,
      input.source.externalEventId,
      input.source.externalSubject,
      input.source.eventDigest,
      requestDigest,
      input.source.occurredAt,
      nowIso,
      nowIso,
    ).run();
    const persistedSource = await this.source(sourceId);
    if (persistedSource === null) throw new QuotaOverrideError('source_conflict');
    this.assertSource(persistedSource, input, requestDigest);

    const channel = `${input.source.provider}:${input.source.tenantKey}`;
    const identity = await new IdentityMapper(this.db).resolve(
      channel,
      input.source.externalSubject,
    );
    const rejectionReason = this.identityRejection(input, candidate, identity);
    const status = rejectionReason !== null
      ? 'identity_rejected'
      : input.decision === 'approve'
        ? 'approved'
        : 'rejected';
    const principal = identity.principal === ANONYMOUS_PRINCIPAL ? null : identity.principal;
    const overrideIdentity = await canonicalSha256({
      sourceId,
      runId: input.runId,
      expectedRunVersion: input.expectedRunVersion,
      resources: input.resources,
      reasonDigest: input.reasonDigest,
      decision: input.decision,
      expiresAt: input.expiresAt,
      principal,
      status,
      rejectionReason,
    });
    const overrideId = `quota_override_${this.suffix(overrideIdentity, 48)}`;
    const insert = await this.db.prepare(
      `INSERT INTO quota_overrides (
         override_id, source_id, run_id, expected_run_version, priority_snapshot,
         resources_json, reason_digest, approver_principal, multiplier, decision,
         status, rejection_reason, expires_at, created_at
       )
       SELECT ?, ?, runs.run_id, runs.version, 'p0', ?, ?, ?, 2, ?, ?, ?, ?, ?
       FROM runs JOIN tasks ON tasks.task_id = runs.task_id
       WHERE runs.run_id = ? AND runs.version = ? AND tasks.priority = 'p0'
       ON CONFLICT DO NOTHING`,
    ).bind(
      overrideId,
      sourceId,
      JSON.stringify(input.resources),
      input.reasonDigest,
      principal,
      input.decision,
      status,
      rejectionReason,
      input.expiresAt,
      nowIso,
      input.runId,
      input.expectedRunVersion,
    ).run();
    const persisted = await this.outcome(sourceId);
    if (persisted === null) throw new QuotaOverrideError('state_conflict');
    return this.result(persisted, insert.meta.changes === 1);
  }

  private normalized(input: QuotaOverrideInput): QuotaOverrideInput {
    const order = new Map(QUOTA_RESOURCES.map((resource, index) => [resource, index]));
    return {
      ...input,
      resources: [...input.resources].sort((left, right) => order.get(left)! - order.get(right)!),
    };
  }

  private assertTimes(input: QuotaOverrideInput, now: Date): void {
    const occurredAt = Date.parse(input.source.occurredAt);
    const expiresAt = Date.parse(input.expiresAt);
    const timestamp = now.getTime();
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(occurredAt) ||
      occurredAt < timestamp - MAX_SOURCE_AGE_MS ||
      occurredAt > timestamp + MAX_FUTURE_SKEW_MS ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= timestamp ||
      expiresAt > timestamp + MAX_OVERRIDE_TTL_MS
    ) throw new QuotaOverrideError('invalid_request');
  }

  private identityRejection(
    input: QuotaOverrideInput,
    candidate: CandidateRow,
    identity: { principal: string; roles: string[] },
  ): string | null {
    const expectedTenant = input.source.provider === 'github'
      ? candidate.repository
      : candidate.tenant_key;
    if (input.source.tenantKey !== expectedTenant) return 'source_tenant_mismatch';
    if (identity.principal === ANONYMOUS_PRINCIPAL) return 'identity_unresolved';
    if (
      !identity.roles.includes('human') ||
      identity.principal.startsWith('agent:') ||
      identity.principal.startsWith('service:')
    ) return 'actor_not_human';
    if (!identity.roles.includes('approve:quota_override')) return 'actor_not_authorized';
    if (
      input.decision === 'approve' &&
      candidate.actor_type === 'user' &&
      candidate.actor_id === identity.principal
    ) return 'task_actor_self_approval';
    return null;
  }

  private async candidate(runId: string): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version, tasks.priority,
              tasks.tenant_key, tasks.target_repository AS repository,
              tasks.actor_type, tasks.actor_id
       FROM runs JOIN tasks ON tasks.task_id = runs.task_id
       WHERE runs.run_id = ?`,
    ).bind(runId).first<CandidateRow>();
  }

  private async source(sourceId: string): Promise<SourceRow | null> {
    return await this.db.prepare(
      `SELECT source_id, provider, tenant_key, external_event_id, external_subject,
              event_digest, request_digest, occurred_at
       FROM quota_override_source_events WHERE source_id = ?`,
    ).bind(sourceId).first<SourceRow>();
  }

  private assertSource(
    row: SourceRow,
    input: QuotaOverrideInput,
    requestDigest: string,
  ): void {
    if (
      row.provider !== input.source.provider ||
      row.tenant_key !== input.source.tenantKey ||
      row.external_event_id !== input.source.externalEventId ||
      row.external_subject !== input.source.externalSubject ||
      row.event_digest !== input.source.eventDigest ||
      row.occurred_at !== input.source.occurredAt ||
      row.request_digest !== requestDigest
    ) throw new QuotaOverrideError('source_conflict');
  }

  private async outcome(sourceId: string): Promise<OverrideRow | null> {
    return await this.db.prepare(
      `SELECT override_id, source_id, run_id, expected_run_version,
              resources_json, reason_digest, approver_principal, multiplier,
              decision, status, rejection_reason, expires_at
       FROM quota_overrides WHERE source_id = ?`,
    ).bind(sourceId).first<OverrideRow>();
  }

  private result(row: OverrideRow, created: boolean): QuotaOverrideResult {
    if (
      row.multiplier !== 2 ||
      !['approved', 'rejected', 'identity_rejected'].includes(row.status)
    ) throw new QuotaOverrideError('state_conflict');
    return {
      overrideId: row.override_id,
      sourceId: row.source_id,
      runId: row.run_id,
      status: row.status as QuotaOverrideResult['status'],
      principal: row.approver_principal,
      multiplier: 2,
      rejectionReason: row.rejection_reason,
      expiresAt: row.expires_at,
      created,
    };
  }

  private suffix(digest: string, length: number): string {
    return digest.slice('sha256:'.length, 'sha256:'.length + length);
  }
}
