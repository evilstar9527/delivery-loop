import type { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import type { QuotaResourceSchema } from '../domain/quota.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const RESERVATION_TTL_MS = 2 * 60 * 60_000;
type QuotaResource = z.infer<typeof QuotaResourceSchema>;

export type QuotaControlErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'quota_exceeded'
  | 'profile_unavailable'
  | 'state_conflict'
  | 'usage_exceeds_reservation';

export class QuotaControlError extends Error {
  constructor(readonly code: QuotaControlErrorCode) {
    super(`quota control failed: ${code}`);
    this.name = 'QuotaControlError';
  }
}

interface ReservationRow {
  reservation_id: string;
  attempt_id: string;
  run_id: string;
  override_id: string | null;
  expires_at: string;
  released_at: string | null;
}

interface AttemptContextRow {
  attempt_id: string;
  run_id: string;
  status: string;
  lease_expires_at: string | null;
}

interface ModelProfileRow {
  profile_id: string;
  provider: string;
  model: string;
  max_input_tokens: number;
  max_output_tokens: number;
  input_microusd_per_million: number;
  cached_input_microusd_per_million: number;
  output_microusd_per_million: number;
}

interface ModelReservationRow extends ModelProfileRow {
  reservation_id: string;
  attempt_id: string;
  run_id: string;
  reserved_tokens: number;
  reserved_cost_microusd: number;
  override_id: string | null;
  status: string;
  expires_at: string;
  usage_id: string | null;
}

interface UsageRow {
  usage_id: string;
  provider: string;
  model: string;
  run_id: string;
  attempt_id: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cost_microusd: number;
  source_digest: string;
}

interface ExceededPolicyRow {
  scope_type: string;
  scope_key: string;
  limit_value: number;
  used_units: number;
  effective_limit: number;
}

export interface ConcurrencyReservationResult {
  reservationId: string;
  attemptId: string;
  runId: string;
  expiresAt: string;
  overrideId: string | null;
  disposition: 'created' | 'existing';
}

export interface ToolCallAdmissionInput {
  traceId: string;
  attemptId: string;
  occurredAt: string;
}

export interface ToolCallAdmissionResult {
  traceId: string;
  runId: string;
  attemptId: string;
  overrideId: string | null;
  disposition: 'created' | 'existing';
}

export interface ModelCallReservationInput {
  reservationId: string;
  attemptId: string;
  profileId: string;
  occurredAt: string;
}

export interface ModelCallReservationResult {
  reservationId: string;
  attemptId: string;
  runId: string;
  provider: string;
  model: string;
  reservedTokens: number;
  reservedCostMicrousd: number;
  expiresAt: string;
  overrideId: string | null;
  disposition: 'created' | 'existing';
}

export interface ModelCallSettlementInput {
  reservationId: string;
  usageId: string;
  attemptId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  occurredAt: string;
}

export interface ModelCallSettlementResult {
  usageId: string;
  reservationId: string;
  totalTokens: number;
  costMicrousd: number;
  disposition: 'created' | 'existing';
}

function safeDate(raw: string): Date {
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== raw) {
    throw new QuotaControlError('invalid_request');
  }
  return date;
}

function safeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function pricedTokens(tokens: number, microusdPerMillion: number): number {
  const value = (BigInt(tokens) * BigInt(microusdPerMillion) + 999_999n) / 1_000_000n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new QuotaControlError('invalid_request');
  return Number(value);
}

function maxReservationCost(profile: ModelProfileRow): number {
  const total = pricedTokens(profile.max_input_tokens, profile.input_microusd_per_million) +
    pricedTokens(profile.max_output_tokens, profile.output_microusd_per_million);
  if (!Number.isSafeInteger(total)) throw new QuotaControlError('invalid_request');
  return total;
}

/** Durable quota gate. All admissions are stable-ID INSERT ... SELECT decisions in D1. */
export class QuotaControlStore {
  constructor(private readonly db: D1Database) {}

  async reserveAttemptConcurrency(
    attemptId: string,
    now = new Date(),
  ): Promise<ConcurrencyReservationResult> {
    if (!ID_PATTERN.test(attemptId) || !Number.isFinite(now.getTime())) {
      throw new QuotaControlError('invalid_request');
    }
    const attempt = await this.attempt(attemptId);
    if (attempt === null) throw new QuotaControlError('not_found');
    if (!['pending', 'starting', 'running'].includes(attempt.status)) {
      throw new QuotaControlError('state_conflict');
    }
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS).toISOString();
    const existing = await this.concurrencyReservation(attemptId);
    if (existing !== null) {
      if (this.concurrencyReservationActive(existing, attempt, nowIso)) {
        return this.concurrencyResult(existing, 'existing');
      }
      const rearmed = await this.rearmAttemptConcurrency(attempt, expiresAt, nowIso);
      if (rearmed !== null) return this.concurrencyResult(rearmed, 'existing');
      await this.deny(attempt.run_id, attemptId, attemptId, 'concurrency', 1, nowIso);
      throw new QuotaControlError('quota_exceeded');
    }
    const reservationId = `quota_concurrency_${attemptId}`;
    const result = await this.db.prepare(
      `INSERT INTO quota_concurrency_reservations (
         reservation_id, attempt_id, run_id, override_id, expires_at,
         released_at, release_reason, created_at, updated_at
       )
       SELECT ?, attempts.attempt_id, attempts.run_id,
              (
                SELECT overrides.override_id FROM quota_overrides AS overrides
                WHERE overrides.run_id = attempts.run_id
                  AND overrides.status = 'approved' AND overrides.expires_at > ?
                  AND EXISTS (
                    SELECT 1 FROM json_each(overrides.resources_json)
                    WHERE value = 'concurrency'
                  )
                ORDER BY overrides.created_at DESC, overrides.override_id DESC LIMIT 1
              ),
              ?, NULL, NULL, ?, ?
       FROM attempts
       WHERE attempts.attempt_id = ?
         AND attempts.status IN ('pending', 'starting', 'running')
         AND NOT EXISTS (
           SELECT 1 FROM quota_effective_policies AS policy
           WHERE policy.run_id = attempts.run_id
             AND policy.resource_type = 'concurrency'
             AND (
               SELECT COUNT(*)
               FROM quota_concurrency_reservations AS active
               JOIN quota_run_scopes AS scope
                 ON scope.run_id = active.run_id
                AND scope.scope_type = policy.scope_type
                AND scope.scope_key = policy.scope_key
               JOIN attempts AS active_attempt ON active_attempt.attempt_id = active.attempt_id
               WHERE active.released_at IS NULL AND (
                 (active_attempt.status = 'pending' AND active.expires_at > ?) OR
                 (active_attempt.status IN ('starting', 'running') AND (
                   active.expires_at > ? OR active_attempt.lease_expires_at > ?
                 ))
               )
             ) + 1 > policy.limit_value * CASE WHEN EXISTS (
               SELECT 1 FROM quota_overrides AS overrides
               WHERE overrides.run_id = attempts.run_id
                 AND overrides.status = 'approved' AND overrides.expires_at > ?
                 AND EXISTS (
                   SELECT 1 FROM json_each(overrides.resources_json)
                   WHERE value = 'concurrency'
                 )
             ) THEN 2 ELSE 1 END
         )
       ON CONFLICT(attempt_id) DO NOTHING`,
    ).bind(
      reservationId,
      nowIso,
      expiresAt,
      nowIso,
      nowIso,
      attemptId,
      nowIso,
      nowIso,
      nowIso,
      nowIso,
    ).run();
    const persisted = await this.concurrencyReservation(attemptId);
    if (persisted !== null) {
      return this.concurrencyResult(persisted, result.meta.changes === 1 ? 'created' : 'existing');
    }
    await this.deny(attempt.run_id, attemptId, attemptId, 'concurrency', 1, nowIso);
    throw new QuotaControlError('quota_exceeded');
  }

  async releaseAttemptConcurrency(
    attemptId: string,
    now = new Date(),
    reason: 'attempt_terminal' | 'effect_failed' | 'expired' = 'attempt_terminal',
  ): Promise<void> {
    if (!ID_PATTERN.test(attemptId) || !Number.isFinite(now.getTime())) {
      throw new QuotaControlError('invalid_request');
    }
    const nowIso = now.toISOString();
    await this.db.prepare(
      `UPDATE quota_concurrency_reservations
       SET released_at = ?, release_reason = ?, updated_at = ?
       WHERE attempt_id = ? AND released_at IS NULL`,
    ).bind(nowIso, reason, nowIso, attemptId).run();
  }

  async admitToolCall(input: ToolCallAdmissionInput): Promise<ToolCallAdmissionResult> {
    const occurredAt = safeDate(input.occurredAt).toISOString();
    if (!ID_PATTERN.test(input.traceId) || !ID_PATTERN.test(input.attemptId)) {
      throw new QuotaControlError('invalid_request');
    }
    const existing = await this.db.prepare(
      `SELECT trace_id, run_id, attempt_id, override_id
       FROM quota_tool_call_admissions WHERE trace_id = ?`,
    ).bind(input.traceId).first<{
      trace_id: string;
      run_id: string;
      attempt_id: string;
      override_id: string | null;
    }>();
    if (existing !== null) {
      if (existing.attempt_id !== input.attemptId) throw new QuotaControlError('state_conflict');
      return {
        traceId: existing.trace_id,
        runId: existing.run_id,
        attemptId: existing.attempt_id,
        overrideId: existing.override_id,
        disposition: 'existing',
      };
    }
    const attempt = await this.attempt(input.attemptId);
    if (attempt === null) throw new QuotaControlError('not_found');
    const result = await this.db.prepare(
      `INSERT INTO quota_tool_call_admissions (
         trace_id, run_id, attempt_id, override_id, occurred_at, created_at
       )
       SELECT ?, attempts.run_id, attempts.attempt_id,
              (
                SELECT overrides.override_id FROM quota_overrides AS overrides
                WHERE overrides.run_id = attempts.run_id
                  AND overrides.status = 'approved' AND overrides.expires_at > ?
                  AND EXISTS (
                    SELECT 1 FROM json_each(overrides.resources_json)
                    WHERE value = 'tool_call'
                  )
                ORDER BY overrides.created_at DESC, overrides.override_id DESC LIMIT 1
              ), ?, ?
       FROM attempts
       WHERE attempts.attempt_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM quota_effective_policies AS policy
           WHERE policy.run_id = attempts.run_id AND policy.resource_type = 'tool_call'
             AND (
               SELECT COUNT(*) FROM quota_tool_call_admissions AS usage
               JOIN quota_run_scopes AS scope
                 ON scope.run_id = usage.run_id
                AND scope.scope_type = policy.scope_type
                AND scope.scope_key = policy.scope_key
               WHERE policy.window_kind = 'run_lifetime'
                  OR substr(usage.occurred_at, 1, 10) = substr(?, 1, 10)
             ) + 1 > policy.limit_value * CASE WHEN EXISTS (
               SELECT 1 FROM quota_overrides AS overrides
               WHERE overrides.run_id = attempts.run_id
                 AND overrides.status = 'approved' AND overrides.expires_at > ?
                 AND EXISTS (
                   SELECT 1 FROM json_each(overrides.resources_json)
                   WHERE value = 'tool_call'
                 )
             ) THEN 2 ELSE 1 END
         )
       ON CONFLICT(trace_id) DO NOTHING`,
    ).bind(
      input.traceId,
      occurredAt,
      occurredAt,
      occurredAt,
      input.attemptId,
      occurredAt,
      occurredAt,
    ).run();
    const persisted = await this.db.prepare(
      `SELECT trace_id, run_id, attempt_id, override_id
       FROM quota_tool_call_admissions WHERE trace_id = ?`,
    ).bind(input.traceId).first<{
      trace_id: string;
      run_id: string;
      attempt_id: string;
      override_id: string | null;
    }>();
    if (persisted !== null) {
      return {
        traceId: persisted.trace_id,
        runId: persisted.run_id,
        attemptId: persisted.attempt_id,
        overrideId: persisted.override_id,
        disposition: result.meta.changes === 1 ? 'created' : 'existing',
      };
    }
    await this.deny(attempt.run_id, input.attemptId, input.traceId, 'tool_call', 1, occurredAt);
    throw new QuotaControlError('quota_exceeded');
  }

  async reserveModelCall(input: ModelCallReservationInput): Promise<ModelCallReservationResult> {
    const occurredAt = safeDate(input.occurredAt).toISOString();
    if (
      !ID_PATTERN.test(input.reservationId) ||
      !ID_PATTERN.test(input.attemptId) ||
      !ID_PATTERN.test(input.profileId)
    ) throw new QuotaControlError('invalid_request');
    const existing = await this.modelReservation(input.reservationId);
    if (existing !== null) {
      this.assertModelReservation(existing, input, occurredAt);
      return this.modelReservationResult(existing, 'existing');
    }
    const attempt = await this.attempt(input.attemptId);
    if (attempt === null) throw new QuotaControlError('not_found');
    const profile = await this.profile(input.profileId);
    if (profile === null) throw new QuotaControlError('profile_unavailable');
    const reservedTokens = profile.max_input_tokens + profile.max_output_tokens;
    const reservedCost = maxReservationCost(profile);
    if (!Number.isSafeInteger(reservedTokens)) throw new QuotaControlError('invalid_request');
    const expiresAt = new Date(Date.parse(occurredAt) + RESERVATION_TTL_MS).toISOString();
    const result = await this.db.prepare(
      `INSERT INTO quota_model_reservations (
         reservation_id, attempt_id, run_id, profile_id, reserved_tokens,
         reserved_cost_microusd, override_id, status, expires_at, usage_id,
         created_at, updated_at
       )
       SELECT ?, attempts.attempt_id, attempts.run_id, ?, ?, ?,
              (
                SELECT overrides.override_id FROM quota_overrides AS overrides
                WHERE overrides.run_id = attempts.run_id
                  AND overrides.status = 'approved' AND overrides.expires_at > ?
                  AND EXISTS (
                    SELECT 1 FROM json_each(overrides.resources_json)
                    WHERE value IN ('model_tokens', 'model_cost_microusd')
                  )
                ORDER BY overrides.created_at DESC, overrides.override_id DESC LIMIT 1
              ),
              'reserved', ?, NULL, ?, ?
       FROM attempts
       WHERE attempts.attempt_id = ?
         AND attempts.status IN ('pending', 'starting', 'running')
         AND NOT EXISTS (
           SELECT 1 FROM quota_effective_policies AS policy
           WHERE policy.run_id = attempts.run_id
             AND policy.resource_type IN ('model_tokens', 'model_cost_microusd')
             AND (
               COALESCE((
                 SELECT SUM(CASE policy.resource_type
                   WHEN 'model_tokens' THEN usage.input_tokens + usage.output_tokens
                   ELSE usage.cost_microusd END)
                 FROM model_usage AS usage
                 JOIN quota_run_scopes AS scope
                   ON scope.run_id = usage.run_id
                  AND scope.scope_type = policy.scope_type
                  AND scope.scope_key = policy.scope_key
                 WHERE policy.window_kind = 'run_lifetime'
                    OR substr(usage.at, 1, 10) = substr(?, 1, 10)
               ), 0) + COALESCE((
                 SELECT SUM(CASE policy.resource_type
                   WHEN 'model_tokens' THEN reservations.reserved_tokens
                   ELSE reservations.reserved_cost_microusd END)
                 FROM quota_model_reservations AS reservations
                 JOIN quota_run_scopes AS scope
                   ON scope.run_id = reservations.run_id
                  AND scope.scope_type = policy.scope_type
                  AND scope.scope_key = policy.scope_key
                 WHERE reservations.status = 'reserved' AND reservations.expires_at > ?
                   AND (policy.window_kind = 'run_lifetime'
                     OR substr(reservations.created_at, 1, 10) = substr(?, 1, 10))
               ), 0) + CASE policy.resource_type
                 WHEN 'model_tokens' THEN ? ELSE ? END
             ) > policy.limit_value * CASE WHEN EXISTS (
               SELECT 1 FROM quota_overrides AS overrides
               WHERE overrides.run_id = attempts.run_id
                 AND overrides.status = 'approved' AND overrides.expires_at > ?
                 AND EXISTS (
                   SELECT 1 FROM json_each(overrides.resources_json)
                   WHERE value = policy.resource_type
                 )
             ) THEN 2 ELSE 1 END
         )
       ON CONFLICT(reservation_id) DO NOTHING`,
    ).bind(
      input.reservationId,
      input.profileId,
      reservedTokens,
      reservedCost,
      occurredAt,
      expiresAt,
      occurredAt,
      occurredAt,
      input.attemptId,
      occurredAt,
      occurredAt,
      occurredAt,
      reservedTokens,
      reservedCost,
      occurredAt,
    ).run();
    const persisted = await this.modelReservation(input.reservationId);
    if (persisted !== null) {
      this.assertModelReservation(persisted, input, occurredAt);
      return this.modelReservationResult(
        persisted,
        result.meta.changes === 1 ? 'created' : 'existing',
      );
    }
    const resource = await this.firstExceededModelResource(
      attempt.run_id,
      reservedTokens,
      reservedCost,
      occurredAt,
    );
    await this.deny(
      attempt.run_id,
      input.attemptId,
      input.reservationId,
      resource,
      resource === 'model_tokens' ? reservedTokens : Math.max(1, reservedCost),
      occurredAt,
    );
    throw new QuotaControlError('quota_exceeded');
  }

  async settleModelCall(input: ModelCallSettlementInput): Promise<ModelCallSettlementResult> {
    const occurredAt = safeDate(input.occurredAt).toISOString();
    if (
      !ID_PATTERN.test(input.reservationId) ||
      !ID_PATTERN.test(input.usageId) ||
      !ID_PATTERN.test(input.attemptId) ||
      !safeInteger(input.inputTokens) ||
      !safeInteger(input.cachedInputTokens) ||
      !safeInteger(input.outputTokens) ||
      !safeInteger(input.reasoningOutputTokens) ||
      input.cachedInputTokens > input.inputTokens ||
      input.reasoningOutputTokens > input.outputTokens
    ) throw new QuotaControlError('invalid_request');
    const sourceDigest = await canonicalSha256({
      reservationId: input.reservationId,
      usageId: input.usageId,
      attemptId: input.attemptId,
      inputTokens: input.inputTokens,
      cachedInputTokens: input.cachedInputTokens,
      outputTokens: input.outputTokens,
      reasoningOutputTokens: input.reasoningOutputTokens,
    });
    const existing = await this.usage(input.usageId);
    if (existing !== null) {
      this.assertUsage(existing, input, sourceDigest);
      return {
        usageId: existing.usage_id,
        reservationId: input.reservationId,
        totalTokens: existing.input_tokens + existing.output_tokens,
        costMicrousd: existing.cost_microusd,
        disposition: 'existing',
      };
    }
    const reservation = await this.modelReservation(input.reservationId);
    if (reservation === null) throw new QuotaControlError('not_found');
    if (
      reservation.attempt_id !== input.attemptId ||
      reservation.status !== 'reserved' ||
      reservation.expires_at <= occurredAt
    ) throw new QuotaControlError('state_conflict');
    const totalTokens = input.inputTokens + input.outputTokens;
    if (!Number.isSafeInteger(totalTokens) || totalTokens > reservation.reserved_tokens) {
      throw new QuotaControlError('usage_exceeds_reservation');
    }
    const uncachedInput = input.inputTokens - input.cachedInputTokens;
    const costMicrousd =
      pricedTokens(uncachedInput, reservation.input_microusd_per_million) +
      pricedTokens(input.cachedInputTokens, reservation.cached_input_microusd_per_million) +
      pricedTokens(input.outputTokens, reservation.output_microusd_per_million);
    if (costMicrousd > reservation.reserved_cost_microusd) {
      throw new QuotaControlError('usage_exceeds_reservation');
    }
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO model_usage (
           usage_id, at, provider, model, run_id, attempt_id,
           tenant_key, repository, principal, input_tokens, cached_input_tokens,
           output_tokens, reasoning_output_tokens, cost_microusd, source_digest, created_at
         )
         SELECT ?, ?, profiles.provider, profiles.model, reservations.run_id,
                reservations.attempt_id, tasks.tenant_key, tasks.target_repository,
                tasks.actor_id, ?, ?, ?, ?, ?, ?, ?
         FROM quota_model_reservations AS reservations
         JOIN quota_model_profiles AS profiles ON profiles.profile_id = reservations.profile_id
         JOIN runs ON runs.run_id = reservations.run_id
         JOIN tasks ON tasks.task_id = runs.task_id
         WHERE reservations.reservation_id = ? AND reservations.attempt_id = ?
           AND reservations.status = 'reserved' AND reservations.usage_id IS NULL
           AND reservations.expires_at > ?
           AND ? <= reservations.reserved_tokens
           AND ? <= reservations.reserved_cost_microusd
         ON CONFLICT(usage_id) DO NOTHING`,
      ).bind(
        input.usageId,
        occurredAt,
        input.inputTokens,
        input.cachedInputTokens,
        input.outputTokens,
        input.reasoningOutputTokens,
        costMicrousd,
        sourceDigest,
        occurredAt,
        input.reservationId,
        input.attemptId,
        occurredAt,
        totalTokens,
        costMicrousd,
      ),
      this.db.prepare(
        `UPDATE quota_model_reservations
         SET status = 'settled', usage_id = ?, updated_at = ?
         WHERE reservation_id = ? AND attempt_id = ? AND status = 'reserved'
           AND usage_id IS NULL
           AND EXISTS (
             SELECT 1 FROM model_usage
             WHERE usage_id = ? AND attempt_id = quota_model_reservations.attempt_id
           )`,
      ).bind(
        input.usageId,
        occurredAt,
        input.reservationId,
        input.attemptId,
        input.usageId,
      ),
    ]);
    const persisted = await this.usage(input.usageId);
    if (persisted === null) throw new QuotaControlError('state_conflict');
    this.assertUsage(persisted, input, sourceDigest);
    return {
      usageId: persisted.usage_id,
      reservationId: input.reservationId,
      totalTokens,
      costMicrousd,
      disposition: 'created',
    };
  }

  async reconcile(now = new Date()): Promise<{ concurrency: number; model: number }> {
    if (!Number.isFinite(now.getTime())) throw new QuotaControlError('invalid_request');
    const nowIso = now.toISOString();
    const [concurrency, model] = await this.db.batch([
      this.db.prepare(
        `UPDATE quota_concurrency_reservations
         SET released_at = ?,
             release_reason = CASE WHEN EXISTS (
               SELECT 1 FROM attempts
               WHERE attempt_id = quota_concurrency_reservations.attempt_id
                 AND status IN ('completed', 'failed', 'cancelled', 'lost')
             ) THEN 'attempt_terminal' ELSE 'expired' END,
             updated_at = ?
         WHERE released_at IS NULL AND (
           EXISTS (
             SELECT 1 FROM attempts
             WHERE attempt_id = quota_concurrency_reservations.attempt_id
               AND status IN ('completed', 'failed', 'cancelled', 'lost')
           ) OR (
             expires_at <= ? AND NOT EXISTS (
               SELECT 1 FROM attempts
               WHERE attempt_id = quota_concurrency_reservations.attempt_id
                 AND status IN ('starting', 'running') AND lease_expires_at > ?
             )
           )
         )`,
      ).bind(nowIso, nowIso, nowIso, nowIso),
      this.db.prepare(
        `UPDATE quota_model_reservations SET status = 'expired', updated_at = ?
         WHERE status = 'reserved' AND expires_at <= ?`,
      ).bind(nowIso, nowIso),
    ]);
    return {
      concurrency: concurrency?.meta.changes ?? 0,
      model: model?.meta.changes ?? 0,
    };
  }

  private async attempt(attemptId: string): Promise<AttemptContextRow | null> {
    return await this.db.prepare(
      `SELECT attempt_id, run_id, status, lease_expires_at
       FROM attempts WHERE attempt_id = ?`,
    ).bind(attemptId).first<AttemptContextRow>();
  }

  private concurrencyReservationActive(
    reservation: ReservationRow,
    attempt: AttemptContextRow,
    nowIso: string,
  ): boolean {
    return reservation.released_at === null && (
      reservation.expires_at > nowIso ||
      (['starting', 'running'].includes(attempt.status) &&
        attempt.lease_expires_at !== null && attempt.lease_expires_at > nowIso)
    );
  }

  private async rearmAttemptConcurrency(
    attempt: AttemptContextRow,
    expiresAt: string,
    nowIso: string,
  ): Promise<ReservationRow | null> {
    await this.db.prepare(
      `UPDATE quota_concurrency_reservations
       SET override_id = (
             SELECT overrides.override_id FROM quota_overrides AS overrides
             WHERE overrides.run_id = quota_concurrency_reservations.run_id
               AND overrides.status = 'approved' AND overrides.expires_at > ?
               AND EXISTS (
                 SELECT 1 FROM json_each(overrides.resources_json)
                 WHERE value = 'concurrency'
               )
             ORDER BY overrides.created_at DESC, overrides.override_id DESC LIMIT 1
           ),
           expires_at = ?, released_at = NULL, release_reason = NULL, updated_at = ?
       WHERE attempt_id = ? AND run_id = ?
         AND EXISTS (
           SELECT 1 FROM attempts AS current_attempt
           WHERE current_attempt.attempt_id = quota_concurrency_reservations.attempt_id
             AND current_attempt.run_id = quota_concurrency_reservations.run_id
             AND current_attempt.status IN ('pending', 'starting', 'running')
         )
         AND (released_at IS NOT NULL OR NOT (
           expires_at > ? OR (
             ? IN ('starting', 'running') AND ? IS NOT NULL AND ? > ?
           )
         ))
         AND NOT EXISTS (
           SELECT 1 FROM quota_effective_policies AS policy
           WHERE policy.run_id = quota_concurrency_reservations.run_id
             AND policy.resource_type = 'concurrency'
             AND (
               SELECT COUNT(*)
               FROM quota_concurrency_reservations AS active
               JOIN quota_run_scopes AS scope
                 ON scope.run_id = active.run_id
                AND scope.scope_type = policy.scope_type
                AND scope.scope_key = policy.scope_key
               JOIN attempts AS active_attempt ON active_attempt.attempt_id = active.attempt_id
               WHERE active.released_at IS NULL AND (
                 (active_attempt.status = 'pending' AND active.expires_at > ?) OR
                 (active_attempt.status IN ('starting', 'running') AND (
                   active.expires_at > ? OR active_attempt.lease_expires_at > ?
                 ))
               )
             ) + 1 > policy.limit_value * CASE WHEN EXISTS (
               SELECT 1 FROM quota_overrides AS overrides
               WHERE overrides.run_id = quota_concurrency_reservations.run_id
                 AND overrides.status = 'approved' AND overrides.expires_at > ?
                 AND EXISTS (
                   SELECT 1 FROM json_each(overrides.resources_json)
                   WHERE value = 'concurrency'
                 )
             ) THEN 2 ELSE 1 END
         )`,
    ).bind(
      nowIso,
      expiresAt,
      nowIso,
      attempt.attempt_id,
      attempt.run_id,
      nowIso,
      attempt.status,
      attempt.lease_expires_at,
      attempt.lease_expires_at,
      nowIso,
      nowIso,
      nowIso,
      nowIso,
      nowIso,
    ).run();
    const persisted = await this.concurrencyReservation(attempt.attempt_id);
    return persisted !== null && this.concurrencyReservationActive(persisted, attempt, nowIso)
      ? persisted
      : null;
  }

  private async concurrencyReservation(attemptId: string): Promise<ReservationRow | null> {
    return await this.db.prepare(
      `SELECT reservation_id, attempt_id, run_id, override_id, expires_at, released_at
       FROM quota_concurrency_reservations WHERE attempt_id = ?`,
    ).bind(attemptId).first<ReservationRow>();
  }

  private concurrencyResult(
    row: ReservationRow,
    disposition: 'created' | 'existing',
  ): ConcurrencyReservationResult {
    return {
      reservationId: row.reservation_id,
      attemptId: row.attempt_id,
      runId: row.run_id,
      expiresAt: row.expires_at,
      overrideId: row.override_id,
      disposition,
    };
  }

  private async profile(profileId: string): Promise<ModelProfileRow | null> {
    return await this.db.prepare(
      `SELECT profile_id, provider, model, max_input_tokens, max_output_tokens,
              input_microusd_per_million, cached_input_microusd_per_million,
              output_microusd_per_million
       FROM quota_model_profiles WHERE profile_id = ? AND enabled = 1`,
    ).bind(profileId).first<ModelProfileRow>();
  }

  private async modelReservation(reservationId: string): Promise<ModelReservationRow | null> {
    return await this.db.prepare(
      `SELECT reservations.reservation_id, reservations.attempt_id, reservations.run_id,
              reservations.profile_id, reservations.reserved_tokens,
              reservations.reserved_cost_microusd, reservations.override_id,
              reservations.status, reservations.expires_at, reservations.usage_id,
              profiles.provider, profiles.model, profiles.max_input_tokens,
              profiles.max_output_tokens, profiles.input_microusd_per_million,
              profiles.cached_input_microusd_per_million,
              profiles.output_microusd_per_million
       FROM quota_model_reservations AS reservations
       JOIN quota_model_profiles AS profiles ON profiles.profile_id = reservations.profile_id
       WHERE reservations.reservation_id = ?`,
    ).bind(reservationId).first<ModelReservationRow>();
  }

  private assertModelReservation(
    row: ModelReservationRow,
    input: ModelCallReservationInput,
    occurredAt: string,
  ): void {
    if (
      row.attempt_id !== input.attemptId ||
      row.profile_id !== input.profileId ||
      row.status !== 'reserved' ||
      row.expires_at <= occurredAt
    ) {
      throw new QuotaControlError('state_conflict');
    }
  }

  private modelReservationResult(
    row: ModelReservationRow,
    disposition: 'created' | 'existing',
  ): ModelCallReservationResult {
    if (!MODEL_NAME_PATTERN.test(row.provider) || !MODEL_NAME_PATTERN.test(row.model)) {
      throw new QuotaControlError('state_conflict');
    }
    return {
      reservationId: row.reservation_id,
      attemptId: row.attempt_id,
      runId: row.run_id,
      provider: row.provider,
      model: row.model,
      reservedTokens: row.reserved_tokens,
      reservedCostMicrousd: row.reserved_cost_microusd,
      expiresAt: row.expires_at,
      overrideId: row.override_id,
      disposition,
    };
  }

  private async usage(usageId: string): Promise<UsageRow | null> {
    return await this.db.prepare(
      `SELECT usage_id, provider, model, run_id, attempt_id, input_tokens,
              cached_input_tokens, output_tokens, reasoning_output_tokens,
              cost_microusd, source_digest
       FROM model_usage WHERE usage_id = ?`,
    ).bind(usageId).first<UsageRow>();
  }

  private assertUsage(
    row: UsageRow,
    input: ModelCallSettlementInput,
    sourceDigest: string,
  ): void {
    if (
      row.attempt_id !== input.attemptId ||
      row.input_tokens !== input.inputTokens ||
      row.cached_input_tokens !== input.cachedInputTokens ||
      row.output_tokens !== input.outputTokens ||
      row.reasoning_output_tokens !== input.reasoningOutputTokens ||
      row.source_digest !== sourceDigest
    ) throw new QuotaControlError('state_conflict');
  }

  private async firstExceededModelResource(
    runId: string,
    tokens: number,
    cost: number,
    occurredAt: string,
  ): Promise<'model_tokens' | 'model_cost_microusd'> {
    const row = await this.exceededPolicy(runId, 'model_tokens', tokens, occurredAt);
    return row === null ? 'model_cost_microusd' : 'model_tokens';
  }

  private async deny(
    runId: string,
    attemptId: string,
    requestId: string,
    resource: QuotaResource,
    requestedUnits: number,
    occurredAt: string,
  ): Promise<void> {
    const policy = await this.exceededPolicy(runId, resource, requestedUnits, occurredAt);
    if (policy === null) return;
    const [scopeKeyDigest, reasonDigest] = await Promise.all([
      canonicalSha256({ scopeType: policy.scope_type, scopeKey: policy.scope_key }),
      canonicalSha256({
        runId,
        attemptId,
        requestId,
        resource,
        scopeType: policy.scope_type,
        usedUnits: policy.used_units,
        requestedUnits,
        effectiveLimit: policy.effective_limit,
      }),
    ]);
    const identity = await canonicalSha256({ requestId, resource });
    const denialId = `quota_denial_${identity.slice('sha256:'.length, 'sha256:'.length + 51)}`;
    await this.db.prepare(
      `INSERT INTO quota_denials (
         denial_id, request_id, run_id, attempt_id, resource_type, scope_type,
         scope_key_digest, limit_value, requested_units, reason_digest,
         occurred_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id, resource_type) DO NOTHING`,
    ).bind(
      denialId,
      requestId,
      runId,
      attemptId,
      resource,
      policy.scope_type,
      scopeKeyDigest,
      policy.limit_value,
      requestedUnits,
      reasonDigest,
      occurredAt,
      occurredAt,
    ).run();
  }

  private async exceededPolicy(
    runId: string,
    resource: QuotaResource,
    requestedUnits: number,
    occurredAt: string,
  ): Promise<ExceededPolicyRow | null> {
    let usageSql: string;
    if (resource === 'concurrency') {
      usageSql = `(
        SELECT COUNT(*) FROM quota_concurrency_reservations AS usage
        JOIN quota_run_scopes AS scope
          ON scope.run_id = usage.run_id AND scope.scope_type = policy.scope_type
         AND scope.scope_key = policy.scope_key
        JOIN attempts ON attempts.attempt_id = usage.attempt_id
        WHERE usage.released_at IS NULL AND (
          (attempts.status = 'pending' AND usage.expires_at > ?) OR
          (attempts.status IN ('starting', 'running') AND (
            usage.expires_at > ? OR attempts.lease_expires_at > ?
          ))
        )
      )`;
    } else if (resource === 'tool_call') {
      usageSql = `(
        SELECT COUNT(*) FROM quota_tool_call_admissions AS usage
        JOIN quota_run_scopes AS scope
          ON scope.run_id = usage.run_id AND scope.scope_type = policy.scope_type
         AND scope.scope_key = policy.scope_key
        WHERE policy.window_kind = 'run_lifetime'
           OR substr(usage.occurred_at, 1, 10) = substr(?, 1, 10)
      )`;
    } else if (resource === 'attempt') {
      usageSql = `(
        SELECT COUNT(*) FROM attempts AS usage
        JOIN quota_run_scopes AS scope
          ON scope.run_id = usage.run_id AND scope.scope_type = policy.scope_type
         AND scope.scope_key = policy.scope_key
        WHERE policy.window_kind = 'run_lifetime'
           OR substr(usage.created_at, 1, 10) = substr(?, 1, 10)
      )`;
    } else {
      const column = resource === 'model_tokens'
        ? 'usage.input_tokens + usage.output_tokens'
        : 'usage.cost_microusd';
      const reservationColumn = resource === 'model_tokens'
        ? 'reservations.reserved_tokens'
        : 'reservations.reserved_cost_microusd';
      usageSql = `(COALESCE((
        SELECT SUM(${column}) FROM model_usage AS usage
        JOIN quota_run_scopes AS scope
          ON scope.run_id = usage.run_id AND scope.scope_type = policy.scope_type
         AND scope.scope_key = policy.scope_key
        WHERE policy.window_kind = 'run_lifetime'
           OR substr(usage.at, 1, 10) = substr(?, 1, 10)
      ), 0) + COALESCE((
        SELECT SUM(${reservationColumn}) FROM quota_model_reservations AS reservations
        JOIN quota_run_scopes AS scope
          ON scope.run_id = reservations.run_id AND scope.scope_type = policy.scope_type
         AND scope.scope_key = policy.scope_key
        WHERE reservations.status = 'reserved' AND reservations.expires_at > ?
          AND (policy.window_kind = 'run_lifetime'
            OR substr(reservations.created_at, 1, 10) = substr(?, 1, 10))
      ), 0))`;
    }
    const bindings = resource === 'concurrency'
      ? [occurredAt, occurredAt, occurredAt]
      : resource === 'model_tokens' || resource === 'model_cost_microusd'
        ? [occurredAt, occurredAt, occurredAt]
        : [occurredAt];
    return await this.db.prepare(
      `SELECT policy.scope_type, policy.scope_key, policy.limit_value,
              ${usageSql} AS used_units,
              policy.limit_value * CASE WHEN EXISTS (
                SELECT 1 FROM quota_overrides AS overrides
                WHERE overrides.run_id = policy.run_id
                  AND overrides.status = 'approved' AND overrides.expires_at > ?
                  AND EXISTS (
                    SELECT 1 FROM json_each(overrides.resources_json)
                    WHERE value = policy.resource_type
                  )
              ) THEN 2 ELSE 1 END AS effective_limit
       FROM quota_effective_policies AS policy
       WHERE policy.run_id = ? AND policy.resource_type = ?
         AND ${usageSql} + ? > policy.limit_value * CASE WHEN EXISTS (
           SELECT 1 FROM quota_overrides AS overrides
           WHERE overrides.run_id = policy.run_id
             AND overrides.status = 'approved' AND overrides.expires_at > ?
             AND EXISTS (
               SELECT 1 FROM json_each(overrides.resources_json)
               WHERE value = policy.resource_type
             )
         ) THEN 2 ELSE 1 END
       ORDER BY CASE policy.scope_type WHEN 'run' THEN 0 WHEN 'user' THEN 1
         WHEN 'repository' THEN 2 ELSE 3 END
       LIMIT 1`,
    ).bind(
      ...bindings,
      occurredAt,
      runId,
      resource,
      ...bindings,
      requestedUnits,
      occurredAt,
    ).first<ExceededPolicyRow>();
  }
}
