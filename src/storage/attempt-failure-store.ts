import {
  AttemptFailureReportV1Schema,
  DEFAULT_MAX_ATTEMPTS,
  REPEATED_FAILURE_LIMIT,
  failureClassFor,
  failureFingerprint,
  retryScopeMode,
  retryScopeDigest,
  shouldRetry,
  type AttemptFailureBlockerReason,
  type AttemptFailureReportV1,
} from '../domain/attempt-failure.js';
import { canonicalSha256 } from '../domain/digest.js';
import type { RunnerAuthorization } from './runner-attempt-store.js';

export type AttemptFailureErrorCode = 'state_conflict' | 'event_conflict';

export class AttemptFailureError extends Error {
  constructor(readonly code: AttemptFailureErrorCode) {
    super(`Attempt failure operation failed: ${code}`);
    this.name = 'AttemptFailureError';
  }
}

interface FailureCandidateRow {
  attempt_id: string;
  run_id: string;
  ordinal: number;
  mode: string;
  status: string;
  version: number;
  lease_generation: number;
  lease_expires_at: string | null;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  head_branch: string | null;
  head_sha: string | null;
  repository: string | null;
  workflow_ref: string | null;
  run_state: string;
  active_plan_id: string | null;
  active_plan_version: number | null;
  plan_status: string | null;
  progress_status: string | null;
  progress_version: number | null;
  active_attempt_id: string | null;
  protected_path_gate_id: string | null;
}

interface VerificationFailureFact {
  suite_id: string;
  evidence_id: string;
  phase: 'targeted' | 'required_verify';
  command_ref: string;
  exit_code: number;
  head_sha: string;
  fact_digest: string;
}

interface RepairIdentity {
  repairId: string;
  attemptId: string;
  outboxId: string;
}

interface PreviousFailureRow {
  fingerprint_digest: string;
  consecutive_fingerprint_count: number;
}

interface FailureProjectionRow {
  failure_id: string;
  run_id: string;
  attempt_id: string;
  attempt_ordinal: number;
  event_id: string;
  sequence: number;
  retry_scope_digest: string;
  fingerprint_digest: string;
  failure_class: string;
  failure_code: string;
  failure_site: string;
  needed_human_input: string;
  scope_attempt_count: number;
  consecutive_fingerprint_count: number;
  revoked_lease_generation: number;
  occurred_at: string;
  run_state: string;
  blocker_id: string | null;
  blocker_reason: AttemptFailureBlockerReason | null;
  repair_id: string | null;
  repair_attempt_id: string | null;
  repair_ordinal: number | null;
  repair_mode: 'review_fix' | null;
  failed_attempt_id: string | null;
  source_suite_id: string | null;
  source_evidence_id: string | null;
  repair_outbox_id: string | null;
  fact_suite_id: string | null;
  fact_evidence_id: string | null;
  fact_head_sha: string | null;
  failure_fact_digest: string | null;
}

export interface AttemptFailureResult {
  failureId: string;
  fingerprintDigest: string;
  attemptCount: number;
  consecutiveFingerprintCount: number;
  blocked: boolean;
  retryAllowed: boolean;
  blocker?: {
    id: string;
    reason: AttemptFailureBlockerReason;
  };
  verificationFailure?: {
    sourceSuiteId: string;
    sourceEvidenceId: string;
    headSha: string;
    factDigest: string;
  };
  repair?: {
    id: string;
    attemptId: string;
    ordinal: number;
    mode: 'review_fix';
    failedAttemptId: string;
    sourceSuiteId: string;
    sourceEvidenceId: string;
    dispatchOutboxId: string;
    created: boolean;
  };
}

const FAILURE_RUN_STATES = new Set([
  'triaging',
  'awaiting_approval',
  'planning',
  'executing',
  'verifying',
  'awaiting_review',
  'deploying',
]);

function stableSuffix(digest: string): string {
  return digest.slice('sha256:'.length, 'sha256:'.length + 56);
}

/** Records one terminal Attempt failure and atomically applies the bounded retry policy. */
export class AttemptFailureStore {
  constructor(private readonly db: D1Database) {}

  async report(
    authorization: RunnerAuthorization,
    rawToken: string,
    input: AttemptFailureReportV1,
    now = new Date(),
  ): Promise<AttemptFailureResult> {
    const report = AttemptFailureReportV1Schema.parse(input);
    if (
      report.expectedVersion !== authorization.version ||
      report.leaseGeneration !== authorization.leaseGeneration
    ) {
      throw new AttemptFailureError('state_conflict');
    }
    const candidate = await this.candidate(authorization);
    if (
      candidate === null ||
      candidate.status !== 'running' ||
      candidate.version !== report.expectedVersion ||
      candidate.lease_generation !== report.leaseGeneration ||
      candidate.lease_expires_at === null ||
      candidate.lease_expires_at <= now.toISOString() ||
      !FAILURE_RUN_STATES.has(candidate.run_state)
    ) {
      throw new AttemptFailureError('state_conflict');
    }

    const verificationFact = await this.verificationFailureFact(candidate, report);
    const scopeMode = retryScopeMode(candidate.mode);
    const scopeDigest = await retryScopeDigest({
      runId: candidate.run_id,
      mode: scopeMode,
      planId: candidate.plan_id,
      planVersion: candidate.plan_version,
      planItemId: candidate.plan_item_id,
    });
    const fingerprintDigest = await failureFingerprint({
      retryScopeDigest: scopeDigest,
      failureCode: report.failureCode,
      failureSite: report.failureSite,
      ...(verificationFact === null
        ? {}
        : { failureFactDigest: verificationFact.fact_digest }),
    });
    const identityDigest = await canonicalSha256({
      runId: candidate.run_id,
      eventId: report.eventId,
    });
    const failureId = `failure_${stableSuffix(identityDigest)}`;
    const attemptCount = await this.scopeAttemptCount(candidate);
    const previous = await this.db
      .prepare(
        `SELECT fingerprint_digest, consecutive_fingerprint_count
         FROM attempt_failures
         WHERE run_id = ? AND retry_scope_digest = ? AND attempt_ordinal < ?
         ORDER BY attempt_ordinal DESC LIMIT 1`,
      )
      .bind(candidate.run_id, scopeDigest, candidate.ordinal)
      .first<PreviousFailureRow>();
    const consecutiveFingerprintCount =
      previous?.fingerprint_digest === fingerprintDigest
        ? previous.consecutive_fingerprint_count + 1
        : 1;
    const externalDependency =
      report.failureCode === 'tool_unavailable' &&
      report.failureSite === 'external_reconciliation' &&
      report.neededHumanInput === 'resolve_external_dependency';
    const blockerReason =
      externalDependency
        ? 'external_dependency' as const
        : consecutiveFingerprintCount >= REPEATED_FAILURE_LIMIT
        ? 'repeated_fingerprint' as const
        : attemptCount >= DEFAULT_MAX_ATTEMPTS
          ? 'attempt_limit' as const
          : null;
    const failureClass = failureClassFor(report.failureCode);
    const nowIso = now.toISOString();
    const tokenDigest = await canonicalSha256(rawToken);
    const shouldScheduleRepair = blockerReason === null && verificationFact !== null;
    let repairIdentity: RepairIdentity | null = null;
    if (shouldScheduleRepair) {
      const repairDigest = await canonicalSha256({
        schemaVersion: '1',
        failureId,
        failedAttemptId: candidate.attempt_id,
        sourceEvidenceId: verificationFact.evidence_id,
      });
      const suffix = stableSuffix(repairDigest);
      repairIdentity = {
        repairId: `repair_${suffix}`,
        attemptId: `attempt_repair_${suffix}`,
        outboxId: `dispatch_repair_${suffix}`,
      };
    }
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO attempt_failures (
             failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
             retry_scope_digest, fingerprint_digest, failure_class, failure_code,
             failure_site, needed_human_input, scope_attempt_count,
             consecutive_fingerprint_count, revoked_lease_generation,
             occurred_at, created_at
           )
           SELECT ?, attempts.run_id, attempts.attempt_id, attempts.ordinal, ?, ?,
                  ?, ?, ?, ?, ?, ?, ?, ?, attempts.lease_generation, ?, ?
           FROM attempts
           JOIN runs ON runs.run_id = attempts.run_id
           WHERE attempts.attempt_id = ? AND attempts.run_id = ?
             AND attempts.status = 'running' AND attempts.version = ?
             AND attempts.lease_generation = ? AND attempts.lease_expires_at > ?
             AND runs.state IN (
               'triaging', 'awaiting_approval', 'planning', 'executing',
               'verifying', 'awaiting_review', 'deploying'
             )
             AND EXISTS (
               SELECT 1 FROM attempt_tokens
               WHERE attempt_id = attempts.attempt_id AND token_digest = ?
                 AND lease_generation = attempts.lease_generation
                 AND revoked_at IS NULL AND expires_at > ?
             )
             AND (
               ? = 0
               OR (
                 attempts.mode IN ('implement', 'review_fix')
                 AND attempts.plan_id = ? AND attempts.plan_version = ?
                 AND attempts.plan_item_id = ? AND attempts.head_sha = ?
                 AND runs.state IN ('executing', 'verifying')
                 AND runs.active_plan_id = attempts.plan_id
                 AND runs.active_plan_version = attempts.plan_version
                 AND EXISTS (
                   SELECT 1
                   FROM execution_plans
                   JOIN plan_item_progress
                     ON plan_item_progress.plan_id = attempts.plan_id
                    AND plan_item_progress.item_id = attempts.plan_item_id
                   JOIN verification_suites
                     ON verification_suites.suite_id = ?
                    AND verification_suites.attempt_id = attempts.attempt_id
                    AND verification_suites.plan_id = attempts.plan_id
                    AND verification_suites.plan_version = attempts.plan_version
                    AND verification_suites.plan_item_id = attempts.plan_item_id
                    AND verification_suites.head_sha = attempts.head_sha
                    AND verification_suites.status = 'failed'
                   JOIN verification_suite_commands
                     ON verification_suite_commands.suite_id = verification_suites.suite_id
                    AND verification_suite_commands.evidence_id = ?
                    AND verification_suite_commands.result_status = 'failed'
                   JOIN evidence
                     ON evidence.evidence_id = verification_suite_commands.evidence_id
                    AND evidence.attempt_id = attempts.attempt_id
                    AND evidence.plan_id = attempts.plan_id
                    AND evidence.plan_version = attempts.plan_version
                    AND evidence.plan_item_id = attempts.plan_item_id
                    AND evidence.sha = attempts.head_sha
                    AND evidence.status = 'failed'
                   WHERE execution_plans.plan_id = attempts.plan_id
                     AND execution_plans.status = 'active'
                     AND plan_item_progress.status = 'in_progress'
                     AND plan_item_progress.active_attempt_id = attempts.attempt_id
                     AND plan_item_progress.protected_path_gate_id IS NULL
                 )
               )
             )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          failureId,
          report.eventId,
          report.sequence,
          scopeDigest,
          fingerprintDigest,
          failureClass,
          report.failureCode,
          report.failureSite,
          report.neededHumanInput,
          attemptCount,
          consecutiveFingerprintCount,
          report.occurredAt,
          nowIso,
          candidate.attempt_id,
          candidate.run_id,
          report.expectedVersion,
          report.leaseGeneration,
          nowIso,
          tokenDigest,
          nowIso,
          verificationFact === null ? 0 : 1,
          candidate.plan_id ?? '',
          candidate.plan_version ?? 0,
          candidate.plan_item_id ?? '',
          candidate.head_sha ?? '',
          verificationFact?.suite_id ?? '',
          verificationFact?.evidence_id ?? '',
        ),
      ...report.attemptedPaths.map((path, position) =>
        this.db
          .prepare(
            `INSERT INTO attempt_failure_paths (failure_id, position, path_code)
             SELECT ?, ?, ? WHERE EXISTS (
               SELECT 1 FROM attempt_failures
               WHERE failure_id = ? AND run_id = ? AND attempt_id = ?
             )
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            failureId,
            position,
            path,
            failureId,
            candidate.run_id,
            candidate.attempt_id,
          ),
      ),
      ...(verificationFact === null
        ? []
        : [
            this.db
              .prepare(
                `INSERT INTO attempt_failure_verification_facts (
                   failure_id, source_suite_id, source_evidence_id,
                   source_head_sha, failure_fact_digest, created_at
                 )
                 SELECT attempt_failures.failure_id,
                        verification_suites.suite_id, evidence.evidence_id,
                        evidence.sha, ?, ?
                 FROM attempt_failures
                 JOIN verification_suites
                   ON verification_suites.suite_id = ?
                  AND verification_suites.attempt_id = attempt_failures.attempt_id
                  AND verification_suites.status = 'failed'
                 JOIN verification_suite_commands
                   ON verification_suite_commands.suite_id = verification_suites.suite_id
                  AND verification_suite_commands.evidence_id = ?
                  AND verification_suite_commands.result_status = 'failed'
                 JOIN evidence
                   ON evidence.evidence_id = verification_suite_commands.evidence_id
                  AND evidence.attempt_id = attempt_failures.attempt_id
                  AND evidence.run_id = attempt_failures.run_id
                  AND evidence.status = 'failed'
                  AND evidence.sha = verification_suites.head_sha
                 WHERE attempt_failures.failure_id = ?
                   AND attempt_failures.fingerprint_digest = ?
                 ON CONFLICT DO NOTHING`,
              )
              .bind(
                verificationFact.fact_digest,
                nowIso,
                verificationFact.suite_id,
                verificationFact.evidence_id,
                failureId,
                fingerprintDigest,
              ),
          ]),
      this.db
        .prepare(
          `UPDATE attempts
           SET status = 'failed', version = version + 1,
               lease_generation = lease_generation + 1,
               lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE attempt_id = ? AND run_id = ? AND status = 'running'
             AND version = ? AND lease_generation = ?
             AND EXISTS (
               SELECT 1 FROM attempt_failures
               WHERE failure_id = ? AND attempt_id = attempts.attempt_id
                 AND fingerprint_digest = ?
             )`,
        )
        .bind(
          nowIso,
          candidate.attempt_id,
          candidate.run_id,
          report.expectedVersion,
          report.leaseGeneration,
          failureId,
          fingerprintDigest,
        ),
      this.db
        .prepare(
          `UPDATE attempt_tokens
           SET revoked_at = ?
           WHERE attempt_id = ? AND token_digest = ? AND lease_generation = ?
             AND revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM attempts
               WHERE attempt_id = ? AND status = 'failed' AND version = ?
                 AND lease_generation = ? AND updated_at = ?
             )`,
        )
        .bind(
          nowIso,
          candidate.attempt_id,
          tokenDigest,
          report.leaseGeneration,
          candidate.attempt_id,
          report.expectedVersion + 1,
          report.leaseGeneration + 1,
          nowIso,
        ),
      this.db
        .prepare(
          `UPDATE github_write_credentials
           SET status = 'revocation_pending', updated_at = ?
           WHERE attempt_id = ? AND lease_generation = ? AND status = 'active'
             AND EXISTS (
               SELECT 1 FROM attempts
               WHERE attempt_id = github_write_credentials.attempt_id
                 AND status = 'failed' AND version = ? AND lease_generation = ?
             )`,
        )
        .bind(
          nowIso,
          candidate.attempt_id,
          report.leaseGeneration,
          report.expectedVersion + 1,
          report.leaseGeneration + 1,
        ),
    ];

    let repairAttemptStatementIndex: number | null = null;
    if (repairIdentity !== null && verificationFact !== null) {
      repairAttemptStatementIndex = statements.length;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO attempts (
               attempt_id, run_id, ordinal, mode, status, base_sha, repository,
               workflow_ref, plan_id, plan_version, plan_item_id,
               claimed_progress_version, head_branch, head_sha,
               version, lease_generation, created_at, updated_at
             )
             SELECT ?, failed.run_id,
                    (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                     FROM attempts AS existing WHERE existing.run_id = failed.run_id),
                    'review_fix', 'pending', failed.base_sha, failed.repository,
                    failed.workflow_ref, failed.plan_id, failed.plan_version,
                    failed.plan_item_id, progress.version, NULL,
                    failed.head_sha, 0, 0, ?, ?
             FROM attempts AS failed
             JOIN attempt_failures
               ON attempt_failures.failure_id = ?
              AND attempt_failures.attempt_id = failed.attempt_id
              AND attempt_failures.retry_scope_digest = ?
              AND attempt_failures.fingerprint_digest = ?
             JOIN runs ON runs.run_id = failed.run_id
             JOIN execution_plans ON execution_plans.plan_id = failed.plan_id
             JOIN plan_item_progress AS progress
              ON progress.plan_id = failed.plan_id
              AND progress.item_id = failed.plan_item_id
             JOIN attempt_failure_verification_facts AS failure_fact
               ON failure_fact.failure_id = attempt_failures.failure_id
              AND failure_fact.source_suite_id = ?
              AND failure_fact.source_evidence_id = ?
              AND failure_fact.failure_fact_digest = ?
             JOIN verification_suites
               ON verification_suites.suite_id = failure_fact.source_suite_id
              AND verification_suites.attempt_id = failed.attempt_id
              AND verification_suites.plan_id = failed.plan_id
              AND verification_suites.plan_version = failed.plan_version
              AND verification_suites.plan_item_id = failed.plan_item_id
              AND verification_suites.head_sha = failed.head_sha
              AND verification_suites.status = 'failed'
             JOIN verification_suite_commands
               ON verification_suite_commands.suite_id = verification_suites.suite_id
              AND verification_suite_commands.evidence_id = failure_fact.source_evidence_id
              AND verification_suite_commands.result_status = 'failed'
             JOIN evidence
               ON evidence.evidence_id = verification_suite_commands.evidence_id
              AND evidence.attempt_id = failed.attempt_id
              AND evidence.plan_id = failed.plan_id
              AND evidence.plan_version = failed.plan_version
              AND evidence.plan_item_id = failed.plan_item_id
              AND evidence.sha = failed.head_sha
              AND evidence.status = 'failed'
             WHERE failed.attempt_id = ? AND failed.run_id = ?
               AND failed.mode IN ('implement', 'review_fix')
               AND failed.status = 'failed' AND failed.version = ?
               AND failed.lease_generation = ?
               AND failed.head_sha IS NOT NULL
               AND runs.state IN ('executing', 'verifying')
               AND runs.active_plan_id = failed.plan_id
               AND runs.active_plan_version = failed.plan_version
               AND execution_plans.status = 'active'
               AND progress.status = 'in_progress'
               AND progress.active_attempt_id = failed.attempt_id
               AND progress.protected_path_gate_id IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM run_blockers
                 WHERE run_blockers.run_id = failed.run_id
                   AND run_blockers.resolved_at IS NULL
               )
               AND NOT EXISTS (
                 SELECT 1 FROM attempt_repairs
                 WHERE attempt_repairs.failure_id = attempt_failures.failure_id
               )
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            repairIdentity.attemptId,
            nowIso,
            nowIso,
            failureId,
            scopeDigest,
            fingerprintDigest,
            verificationFact.suite_id,
            verificationFact.evidence_id,
            verificationFact.fact_digest,
            candidate.attempt_id,
            candidate.run_id,
            report.expectedVersion + 1,
            report.leaseGeneration + 1,
          ),
        this.db
          .prepare(
            `INSERT INTO attempt_repairs (
               repair_id, run_id, plan_id, plan_version, plan_item_id,
               failure_id, failed_attempt_id, repair_attempt_id,
               source_suite_id, source_evidence_id, source_head_sha,
               failure_fact_digest, retry_scope_digest, fingerprint_digest, created_at
             )
             SELECT ?, failed.run_id, failed.plan_id, failed.plan_version,
                    failed.plan_item_id, attempt_failures.failure_id,
                    failed.attempt_id, repair.attempt_id, ?, ?, ?, ?, ?, ?, ?
             FROM attempt_failures
             JOIN attempts AS failed
               ON failed.attempt_id = attempt_failures.attempt_id
             JOIN attempts AS repair
               ON repair.attempt_id = ?
              AND repair.run_id = failed.run_id
              AND repair.plan_id = failed.plan_id
              AND repair.plan_version = failed.plan_version
              AND repair.plan_item_id = failed.plan_item_id
              AND repair.mode = 'review_fix' AND repair.status = 'pending'
             WHERE attempt_failures.failure_id = ?
               AND attempt_failures.retry_scope_digest = ?
               AND attempt_failures.fingerprint_digest = ?
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            repairIdentity.repairId,
            verificationFact.suite_id,
            verificationFact.evidence_id,
            verificationFact.head_sha,
            verificationFact.fact_digest,
            scopeDigest,
            fingerprintDigest,
            nowIso,
            repairIdentity.attemptId,
            failureId,
            scopeDigest,
            fingerprintDigest,
          ),
        this.db
          .prepare(
            `UPDATE plan_item_progress
             SET active_attempt_id = ?, version = version + 1, updated_at = ?
             WHERE plan_id = ? AND item_id = ? AND status = 'in_progress'
               AND active_attempt_id = ?
               AND EXISTS (
                 SELECT 1 FROM attempt_repairs
                 WHERE repair_id = ? AND repair_attempt_id = ?
                   AND failed_attempt_id = plan_item_progress.active_attempt_id
               )`,
          )
          .bind(
            repairIdentity.attemptId,
            nowIso,
            candidate.plan_id,
            candidate.plan_item_id,
            candidate.attempt_id,
            repairIdentity.repairId,
            repairIdentity.attemptId,
          ),
        this.db
          .prepare(
            `INSERT INTO outbox (
               outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
               delivery_state, created_at, updated_at
             )
             SELECT ?, ?, 'execution_dispatch', 'github_actions', ?, ?,
                    'pending', ?, ?
             WHERE EXISTS (
               SELECT 1
               FROM attempt_repairs
               JOIN plan_item_progress
                 ON plan_item_progress.plan_id = attempt_repairs.plan_id
                AND plan_item_progress.item_id = attempt_repairs.plan_item_id
               WHERE attempt_repairs.repair_id = ?
                 AND attempt_repairs.repair_attempt_id = ?
                 AND plan_item_progress.status = 'in_progress'
                 AND plan_item_progress.active_attempt_id = attempt_repairs.repair_attempt_id
             )
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            repairIdentity.outboxId,
            candidate.run_id,
            `d1://attempts/${repairIdentity.attemptId}`,
            `execution-repair:${failureId}`,
            nowIso,
            nowIso,
            repairIdentity.repairId,
            repairIdentity.attemptId,
          ),
      );
    }

    if (blockerReason !== null) {
      const blockerDigest = await canonicalSha256({
        runId: candidate.run_id,
        retryScopeDigest: scopeDigest,
        attemptOrdinal: candidate.ordinal,
      });
      const blockerId = `blocker_${stableSuffix(blockerDigest)}`;
      const cancelOutboxId = `workflow-cancel-${candidate.run_id}`;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO run_blockers (
               blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
               attempt_count, consecutive_fingerprint_count, needed_human_input, created_at
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
             FROM runs
             WHERE runs.run_id = ? AND runs.state IN (
               'triaging', 'awaiting_approval', 'planning', 'executing',
               'verifying', 'awaiting_review', 'deploying'
             ) AND EXISTS (
               SELECT 1 FROM attempt_failures
               WHERE failure_id = ? AND run_id = ? AND attempt_id = ?
             )
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            blockerId,
            candidate.run_id,
            blockerReason,
            scopeDigest,
            fingerprintDigest,
            attemptCount,
            consecutiveFingerprintCount,
            report.neededHumanInput,
            nowIso,
            candidate.run_id,
            failureId,
            candidate.run_id,
            candidate.attempt_id,
          ),
        this.db
          .prepare(
            `UPDATE runs SET state = 'blocked', version = version + 1, updated_at = ?
             WHERE run_id = ? AND state IN (
               'triaging', 'awaiting_approval', 'planning', 'executing',
               'verifying', 'awaiting_review', 'deploying'
             ) AND EXISTS (
               SELECT 1 FROM run_blockers
               WHERE blocker_id = ? AND run_id = ? AND resolved_at IS NULL
             )`,
          )
          .bind(nowIso, candidate.run_id, blockerId, candidate.run_id),
        this.db
          .prepare(
            `UPDATE execution_plans SET status = 'blocked', updated_at = ?
             WHERE plan_id = ? AND status IN ('validated', 'approved', 'active')
               AND EXISTS (
                 SELECT 1 FROM runs
                 WHERE run_id = ? AND state = 'blocked' AND active_plan_id = execution_plans.plan_id
               )`,
          )
          .bind(nowIso, candidate.plan_id, candidate.run_id),
        this.db
          .prepare(
            `UPDATE plan_item_progress
             SET status = 'blocked', version = version + 1, updated_at = ?
             WHERE plan_id = ? AND item_id = ? AND active_attempt_id = ?
               AND status IN ('ready', 'in_progress', 'failed')
               AND EXISTS (SELECT 1 FROM runs WHERE run_id = ? AND state = 'blocked')`,
          )
          .bind(
            nowIso,
            candidate.plan_id,
            candidate.plan_item_id,
            candidate.attempt_id,
            candidate.run_id,
          ),
        this.db
          .prepare(
            `UPDATE attempts
             SET status = 'cancelled', version = version + 1,
                 lease_generation = lease_generation + 1,
                 lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE run_id = ? AND attempt_id <> ?
               AND status IN ('pending', 'starting', 'running', 'cancel_requested')
               AND result_event_id IS NULL
               AND EXISTS (SELECT 1 FROM runs WHERE run_id = ? AND state = 'blocked')`,
          )
          .bind(nowIso, candidate.run_id, candidate.attempt_id, candidate.run_id),
        this.db
          .prepare(
            `UPDATE attempt_tokens SET revoked_at = ?
             WHERE revoked_at IS NULL AND attempt_id IN (
               SELECT attempt_id FROM attempts
               WHERE run_id = ? AND status = 'cancelled' AND updated_at = ?
             )`,
          )
          .bind(nowIso, candidate.run_id, nowIso),
        this.db
          .prepare(
            `UPDATE outbox
             SET delivery_state = 'settled', lease_token = NULL, lease_expires_at = NULL,
                 last_error_code = 'failure_limit_reached', updated_at = ?
             WHERE run_id = ? AND kind IN ('analysis_dispatch', 'execution_dispatch')
               AND delivery_state IN ('pending', 'delivering')
               AND EXISTS (SELECT 1 FROM runs WHERE run_id = ? AND state = 'blocked')`,
          )
          .bind(nowIso, candidate.run_id, candidate.run_id),
        this.db
          .prepare(
            `INSERT INTO outbox (
               outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
               delivery_state, created_at, updated_at
             )
             SELECT ?, ?, 'workflow_cancel', 'cloudflare_workflows', ?, ?, 'pending', ?, ?
             WHERE EXISTS (SELECT 1 FROM runs WHERE run_id = ? AND state = 'blocked')
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            cancelOutboxId,
            candidate.run_id,
            `d1://runs/${candidate.run_id}`,
            `workflow-cancel:${candidate.run_id}`,
            nowIso,
            nowIso,
            candidate.run_id,
          ),
      );
    }

    const results = await this.db.batch(statements);
    return await this.projection(
      candidate,
      report,
      failureId,
      scopeDigest,
      fingerprintDigest,
      blockerReason,
      repairIdentity,
      verificationFact,
      repairAttemptStatementIndex !== null &&
        results[repairAttemptStatementIndex]?.meta.changes === 1,
    );
  }

  private async candidate(
    authorization: RunnerAuthorization,
  ): Promise<FailureCandidateRow | null> {
    return await this.db
      .prepare(
        `SELECT attempts.attempt_id, attempts.run_id, attempts.ordinal, attempts.mode,
                attempts.status, attempts.version, attempts.lease_generation,
                attempts.lease_expires_at, attempts.plan_id, attempts.plan_version,
                attempts.plan_item_id, attempts.head_branch, attempts.head_sha,
                attempts.repository, attempts.workflow_ref,
                runs.state AS run_state, runs.active_plan_id, runs.active_plan_version,
                execution_plans.status AS plan_status,
                plan_item_progress.status AS progress_status,
                plan_item_progress.version AS progress_version,
                plan_item_progress.active_attempt_id,
                plan_item_progress.protected_path_gate_id
         FROM attempts
         JOIN runs ON runs.run_id = attempts.run_id
         LEFT JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
         LEFT JOIN plan_item_progress
           ON plan_item_progress.plan_id = attempts.plan_id
          AND plan_item_progress.item_id = attempts.plan_item_id
         WHERE attempts.attempt_id = ? AND attempts.run_id = ?`,
      )
      .bind(authorization.attemptId, authorization.runId)
      .first<FailureCandidateRow>();
  }

  private async verificationFailureFact(
    candidate: FailureCandidateRow,
    report: AttemptFailureReportV1,
  ): Promise<VerificationFailureFact | null> {
    if (
      report.failureCode !== 'verification_nonzero_exit' ||
      (report.failureSite !== 'targeted_verification' &&
        report.failureSite !== 'full_verification') ||
      (candidate.mode !== 'implement' && candidate.mode !== 'review_fix') ||
      candidate.plan_id === null ||
      candidate.plan_version === null ||
      candidate.plan_item_id === null ||
      candidate.head_sha === null ||
      candidate.active_plan_id !== candidate.plan_id ||
      candidate.active_plan_version !== candidate.plan_version ||
      candidate.plan_status !== 'active' ||
      candidate.progress_status !== 'in_progress' ||
      candidate.active_attempt_id !== candidate.attempt_id ||
      candidate.protected_path_gate_id !== null
    ) {
      return null;
    }
    const expectedPhase = report.failureSite === 'targeted_verification'
      ? 'targeted'
      : 'required_verify';
    const row = await this.db
      .prepare(
        `SELECT verification_suites.suite_id,
                verification_suite_commands.evidence_id,
                verification_suite_commands.phase,
                verification_suite_commands.command_ref,
                evidence.exit_code, evidence.sha AS head_sha
         FROM verification_suites
         JOIN verification_suite_commands
           ON verification_suite_commands.suite_id = verification_suites.suite_id
          AND verification_suite_commands.result_status = 'failed'
         JOIN evidence
           ON evidence.evidence_id = verification_suite_commands.evidence_id
         WHERE verification_suites.attempt_id = ?
           AND verification_suites.run_id = ?
           AND verification_suites.plan_id = ?
           AND verification_suites.plan_version = ?
           AND verification_suites.plan_item_id = ?
           AND verification_suites.lease_generation = ?
           AND verification_suites.head_sha = ?
           AND verification_suites.status = 'failed'
           AND verification_suite_commands.phase = ?
           AND evidence.attempt_id = verification_suites.attempt_id
           AND evidence.plan_id = verification_suites.plan_id
           AND evidence.plan_version = verification_suites.plan_version
           AND evidence.plan_item_id = verification_suites.plan_item_id
           AND evidence.kind = 'test' AND evidence.status = 'failed'
           AND evidence.sha = verification_suites.head_sha
           AND evidence.exit_code IS NOT NULL AND evidence.exit_code <> 0
         ORDER BY verification_suites.updated_at DESC,
                  verification_suite_commands.position
         LIMIT 1`,
      )
      .bind(
        candidate.attempt_id,
        candidate.run_id,
        candidate.plan_id,
        candidate.plan_version,
        candidate.plan_item_id,
        candidate.lease_generation,
        candidate.head_sha,
        expectedPhase,
      )
      .first<Omit<VerificationFailureFact, 'fact_digest'>>();
    if (row === null) return null;
    return {
      ...row,
      fact_digest: await canonicalSha256({
        schemaVersion: '1',
        phase: row.phase,
        commandRef: row.command_ref,
        exitCode: row.exit_code,
      }),
    };
  }

  private async scopeAttemptCount(candidate: FailureCandidateRow): Promise<number> {
    const scopeMode = retryScopeMode(candidate.mode);
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM attempts
         WHERE run_id = ? AND ordinal <= ?
           AND (
             (? = 'execution' AND mode IN ('implement', 'review_fix'))
             OR (? <> 'execution' AND mode = ?)
           )
           AND ((plan_id IS NULL AND ? IS NULL) OR plan_id = ?)
           AND ((plan_version IS NULL AND ? IS NULL) OR plan_version = ?)
           AND ((plan_item_id IS NULL AND ? IS NULL) OR plan_item_id = ?)`,
      )
      .bind(
        candidate.run_id,
        candidate.ordinal,
        scopeMode,
        scopeMode,
        scopeMode,
        candidate.plan_id,
        candidate.plan_id,
        candidate.plan_version,
        candidate.plan_version,
        candidate.plan_item_id,
        candidate.plan_item_id,
      )
      .first<{ count: number }>();
    if (row === null || row.count < 1) throw new AttemptFailureError('state_conflict');
    return row.count;
  }

  private async projection(
    candidate: FailureCandidateRow,
    report: AttemptFailureReportV1,
    failureId: string,
    scopeDigest: string,
    fingerprintDigest: string,
    expectedBlockerReason: AttemptFailureBlockerReason | null,
    expectedRepair: RepairIdentity | null,
    verificationFact: VerificationFailureFact | null,
    repairCreated: boolean,
  ): Promise<AttemptFailureResult> {
    const row = await this.db
      .prepare(
        `SELECT attempt_failures.*, runs.state AS run_state,
                run_blockers.blocker_id,
                run_blockers.reason AS blocker_reason,
                attempt_repairs.repair_id,
                attempt_repairs.repair_attempt_id,
                repair_attempt.ordinal AS repair_ordinal,
                repair_attempt.mode AS repair_mode,
                attempt_repairs.failed_attempt_id,
                attempt_repairs.source_suite_id,
                attempt_repairs.source_evidence_id,
                repair_outbox.outbox_id AS repair_outbox_id,
                failure_fact.source_suite_id AS fact_suite_id,
                failure_fact.source_evidence_id AS fact_evidence_id,
                failure_fact.source_head_sha AS fact_head_sha,
                failure_fact.failure_fact_digest
         FROM attempt_failures
         JOIN runs ON runs.run_id = attempt_failures.run_id
         LEFT JOIN run_blockers
          ON run_blockers.run_id = attempt_failures.run_id
          AND run_blockers.retry_scope_digest = attempt_failures.retry_scope_digest
          AND run_blockers.resolved_at IS NULL
         LEFT JOIN attempt_repairs
           ON attempt_repairs.failure_id = attempt_failures.failure_id
         LEFT JOIN attempt_failure_verification_facts AS failure_fact
           ON failure_fact.failure_id = attempt_failures.failure_id
         LEFT JOIN attempts AS repair_attempt
           ON repair_attempt.attempt_id = attempt_repairs.repair_attempt_id
         LEFT JOIN outbox AS repair_outbox
           ON repair_outbox.run_id = attempt_failures.run_id
          AND repair_outbox.kind = 'execution_dispatch'
          AND repair_outbox.payload_ref = 'd1://attempts/' || attempt_repairs.repair_attempt_id
         WHERE attempt_failures.attempt_id = ?`,
      )
      .bind(candidate.attempt_id)
      .first<FailureProjectionRow>();
    const paths = await this.db
      .prepare(
        `SELECT path_code FROM attempt_failure_paths
         WHERE failure_id = ? ORDER BY position`,
      )
      .bind(failureId)
      .all<{ path_code: string }>();
    if (row === null) throw new AttemptFailureError('state_conflict');
    if (
      row.failure_id !== failureId ||
      row.run_id !== candidate.run_id ||
      row.attempt_ordinal !== candidate.ordinal ||
      row.event_id !== report.eventId ||
      row.sequence !== report.sequence ||
      row.retry_scope_digest !== scopeDigest ||
      row.fingerprint_digest !== fingerprintDigest ||
      row.failure_class !== failureClassFor(report.failureCode) ||
      row.failure_code !== report.failureCode ||
      row.failure_site !== report.failureSite ||
      row.needed_human_input !== report.neededHumanInput ||
      row.revoked_lease_generation !== report.leaseGeneration ||
      row.occurred_at !== report.occurredAt ||
      JSON.stringify(paths.results.map((path) => path.path_code)) !==
        JSON.stringify(report.attemptedPaths)
    ) {
      throw new AttemptFailureError('event_conflict');
    }
    const blocked = row.run_state === 'blocked' && row.blocker_id !== null;
    if (
      expectedBlockerReason !== null &&
      (!blocked || row.blocker_reason !== expectedBlockerReason)
    ) {
      throw new AttemptFailureError('state_conflict');
    }
    if (!blocked && row.scope_attempt_count >= DEFAULT_MAX_ATTEMPTS) {
      throw new AttemptFailureError('state_conflict');
    }
    if (verificationFact !== null) {
      if (
        row.fact_suite_id !== verificationFact.suite_id ||
        row.fact_evidence_id !== verificationFact.evidence_id ||
        row.fact_head_sha !== verificationFact.head_sha ||
        row.failure_fact_digest !== verificationFact.fact_digest
      ) {
        throw new AttemptFailureError('state_conflict');
      }
    } else if (row.fact_suite_id !== null) {
      throw new AttemptFailureError('event_conflict');
    }
    if (expectedRepair !== null) {
      if (
        verificationFact === null ||
        row.repair_id !== expectedRepair.repairId ||
        row.repair_attempt_id !== expectedRepair.attemptId ||
        row.repair_ordinal === null ||
        row.repair_mode !== 'review_fix' ||
        row.failed_attempt_id !== candidate.attempt_id ||
        row.source_suite_id !== verificationFact.suite_id ||
        row.source_evidence_id !== verificationFact.evidence_id ||
        row.repair_outbox_id !== expectedRepair.outboxId ||
        blocked
      ) {
        throw new AttemptFailureError('state_conflict');
      }
    } else if (row.repair_id !== null) {
      throw new AttemptFailureError('state_conflict');
    }
    const result: AttemptFailureResult = {
      failureId: row.failure_id,
      fingerprintDigest: row.fingerprint_digest,
      attemptCount: row.scope_attempt_count,
      consecutiveFingerprintCount: row.consecutive_fingerprint_count,
      blocked,
      retryAllowed: !blocked && shouldRetry(row.scope_attempt_count),
    };
    if (blocked && row.blocker_id !== null && row.blocker_reason !== null) {
      result.blocker = { id: row.blocker_id, reason: row.blocker_reason };
    }
    if (
      row.fact_suite_id !== null &&
      row.fact_evidence_id !== null &&
      row.fact_head_sha !== null &&
      row.failure_fact_digest !== null
    ) {
      result.verificationFailure = {
        sourceSuiteId: row.fact_suite_id,
        sourceEvidenceId: row.fact_evidence_id,
        headSha: row.fact_head_sha,
        factDigest: row.failure_fact_digest,
      };
    }
    if (
      expectedRepair !== null &&
      row.repair_id !== null &&
      row.repair_attempt_id !== null &&
      row.repair_ordinal !== null &&
      row.repair_mode === 'review_fix' &&
      row.failed_attempt_id !== null &&
      row.source_suite_id !== null &&
      row.source_evidence_id !== null &&
      row.repair_outbox_id !== null
    ) {
      result.repair = {
        id: row.repair_id,
        attemptId: row.repair_attempt_id,
        ordinal: row.repair_ordinal,
        mode: row.repair_mode,
        failedAttemptId: row.failed_attempt_id,
        sourceSuiteId: row.source_suite_id,
        sourceEvidenceId: row.source_evidence_id,
        dispatchOutboxId: row.repair_outbox_id,
        created: repairCreated,
      };
    }
    return result;
  }
}
