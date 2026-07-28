import { canonicalSha256 } from '../domain/digest.js';
import {
  VerificationCommandResultV1Schema,
  VerificationSuiteManifestV1Schema,
  verificationSuiteCommands,
  type VerificationCommandResultV1,
  type VerificationSuiteCommand,
  type VerificationSuiteManifestV1,
} from '../domain/verification-evidence.js';
import type { RunnerAuthorization } from './runner-attempt-store.js';

export type VerificationEvidenceErrorCode =
  | 'invalid_request'
  | 'state_conflict'
  | 'binding_conflict'
  | 'result_conflict';

export class VerificationEvidenceError extends Error {
  constructor(readonly code: VerificationEvidenceErrorCode) {
    super(`verification Evidence operation failed: ${code}`);
    this.name = 'VerificationEvidenceError';
  }
}

export interface VerificationSuiteStartResult {
  suiteId: string;
  created: boolean;
  status: 'running' | 'failed' | 'completed';
  commands: VerificationSuiteCommand[];
}

export interface VerificationEvidenceResult {
  evidenceId: string;
  created: boolean;
  suiteStatus: 'running' | 'failed' | 'completed';
}

interface VerificationContextRow {
  attempt_id: string;
  run_id: string;
  attempt_status: string;
  attempt_mode: string;
  attempt_version: number;
  lease_generation: number;
  lease_expires_at: string | null;
  head_sha: string | null;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  run_state: string;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  plan_digest: string | null;
  plan_status: string | null;
  item_kind: string | null;
  item_required: number | null;
  progress_status: string | null;
  active_attempt_id: string | null;
  protected_path_gate_id: string | null;
  has_test_evidence_kind: number;
}

interface SuiteRow {
  suite_id: string;
  run_id: string;
  attempt_id: string;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  lease_generation: number;
  head_sha: string;
  delivery_policy_digest: string;
  targeted_command_count: number;
  required_command_count: number;
  status: 'running' | 'failed' | 'completed';
}

interface SuiteCommandRow {
  position: number;
  phase: 'targeted' | 'required_verify';
  command_ref: string;
  result_status: 'pending' | 'passed' | 'failed';
  evidence_id: string | null;
}

interface EvidenceRow {
  evidence_id: string;
  status: string;
  command_ref: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  sha: string | null;
}

/** D1 boundary for an ordered, head-bound verification suite. */
export class VerificationEvidenceStore {
  constructor(private readonly db: D1Database) {}

  async start(
    authorization: RunnerAuthorization,
    rawManifest: unknown,
    now = new Date(),
  ): Promise<VerificationSuiteStartResult> {
    const parsed = VerificationSuiteManifestV1Schema.safeParse(rawManifest);
    if (!parsed.success) throw new VerificationEvidenceError('invalid_request');
    const manifest = parsed.data;
    const suiteId = await this.suiteId(authorization, manifest);
    const existing = await this.readSuite(suiteId);
    if (existing !== null) return await this.startResult(existing, authorization, manifest, false);

    const nowIso = now.toISOString();
    const context = await this.context(authorization);
    this.assertContext(context, authorization, manifest.headSha, nowIso);
    await this.assertCommandBinding(context, manifest);
    const commands = verificationSuiteCommands(manifest);
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO verification_suites (
             suite_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
             lease_generation, head_sha, delivery_policy_digest,
             targeted_command_count, required_command_count, status, created_at, updated_at
           )
           SELECT ?, attempts.run_id, attempts.attempt_id, attempts.plan_id,
                  attempts.plan_version, attempts.plan_item_id, attempts.lease_generation,
                  attempts.head_sha, ?, ?, ?, 'running', ?, ?
           FROM attempts
           JOIN runs ON runs.run_id = attempts.run_id
           JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
           JOIN plan_items
             ON plan_items.plan_id = attempts.plan_id
            AND plan_items.item_id = attempts.plan_item_id
           JOIN plan_item_progress
             ON plan_item_progress.plan_id = attempts.plan_id
            AND plan_item_progress.item_id = attempts.plan_item_id
           WHERE attempts.attempt_id = ? AND attempts.run_id = ?
             AND attempts.status = 'running' AND attempts.version = ?
             AND attempts.lease_generation = ? AND attempts.lease_expires_at > ?
             AND attempts.head_sha = ?
             AND runs.state = 'executing'
             AND runs.active_plan_id = attempts.plan_id
             AND runs.active_plan_version = attempts.plan_version
             AND runs.active_plan_digest = execution_plans.digest
             AND execution_plans.status = 'active'
             AND plan_items.kind = 'verification' AND plan_items.required = 1
             AND plan_item_progress.status = 'in_progress'
             AND plan_item_progress.active_attempt_id = attempts.attempt_id
             AND plan_item_progress.protected_path_gate_id IS NULL
             AND EXISTS (
               SELECT 1 FROM plan_item_evidence_kinds
               WHERE plan_item_evidence_kinds.plan_id = attempts.plan_id
                 AND plan_item_evidence_kinds.item_id = attempts.plan_item_id
                 AND plan_item_evidence_kinds.evidence_kind = 'test'
             )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          suiteId,
          manifest.policyDigest,
          manifest.targetedCommandRefs.length,
          manifest.requiredVerifyCommandRefs.length,
          nowIso,
          nowIso,
          authorization.attemptId,
          authorization.runId,
          authorization.version,
          authorization.leaseGeneration,
          nowIso,
          manifest.headSha,
        ),
      ...commands.map((command) =>
        this.db
          .prepare(
            `INSERT INTO verification_suite_commands (
               suite_id, position, phase, command_ref, result_status, updated_at
             )
             SELECT ?, ?, ?, ?, 'pending', ?
             WHERE EXISTS (
               SELECT 1 FROM verification_suites
               WHERE suite_id = ? AND attempt_id = ? AND lease_generation = ?
                 AND head_sha = ? AND delivery_policy_digest = ?
             )
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            suiteId,
            command.position,
            command.phase,
            command.commandRef,
            nowIso,
            suiteId,
            authorization.attemptId,
            authorization.leaseGeneration,
            manifest.headSha,
            manifest.policyDigest,
          ),
      ),
    ];
    const results = await this.db.batch(statements);
    const persisted = await this.readSuite(suiteId);
    if (persisted === null) throw new VerificationEvidenceError('state_conflict');
    return await this.startResult(
      persisted,
      authorization,
      manifest,
      results[0]?.meta.changes === 1,
    );
  }

  async record(
    authorization: RunnerAuthorization,
    suiteId: string,
    rawResult: unknown,
    now = new Date(),
  ): Promise<VerificationEvidenceResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(suiteId)) {
      throw new VerificationEvidenceError('invalid_request');
    }
    const parsed = VerificationCommandResultV1Schema.safeParse(rawResult);
    if (!parsed.success) throw new VerificationEvidenceError('invalid_request');
    const result = parsed.data;
    const evidenceId = await this.evidenceId(suiteId, result.position);
    const existing = await this.readEvidence(evidenceId);
    if (existing !== null) {
      return await this.existingEvidence(
        existing,
        suiteId,
        result,
        authorization,
        false,
      );
    }

    const nowIso = now.toISOString();
    const suite = await this.readSuite(suiteId);
    if (
      suite === null ||
      suite.status !== 'running' ||
      suite.attempt_id !== authorization.attemptId ||
      suite.run_id !== authorization.runId ||
      suite.lease_generation !== authorization.leaseGeneration ||
      suite.head_sha !== result.headSha
    ) {
      throw new VerificationEvidenceError('state_conflict');
    }
    const context = await this.context(authorization);
    this.assertContext(context, authorization, result.headSha, nowIso);
    if (
      context.plan_id !== suite.plan_id ||
      context.plan_version !== suite.plan_version ||
      context.plan_item_id !== suite.plan_item_id
    ) {
      throw new VerificationEvidenceError('binding_conflict');
    }
    const pending = await this.db
      .prepare(
        `SELECT position, phase, command_ref, result_status, evidence_id
         FROM verification_suite_commands
         WHERE suite_id = ? AND result_status = 'pending'
         ORDER BY position LIMIT 1`,
      )
      .bind(suiteId)
      .first<SuiteCommandRow>();
    if (
      pending === null ||
      pending.position !== result.position ||
      pending.phase !== result.phase ||
      pending.command_ref !== result.commandRef
    ) {
      throw new VerificationEvidenceError('state_conflict');
    }

    const evidenceStatus = result.exitCode === 0 ? 'passed' : 'failed';
    const summary = result.phase === 'targeted'
      ? `targeted verification command ${evidenceStatus}`
      : `required verification command ${evidenceStatus}`;
    const commands = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO evidence (
             evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
             kind, status, command_ref, exit_code, duration_ms, sha, summary,
             verification_status, observed_at, created_at
           )
           SELECT ?, verification_suites.run_id, verification_suites.attempt_id,
                  verification_suites.plan_id, verification_suites.plan_version,
                  verification_suites.plan_item_id, 'test', ?, ?, ?, ?, ?, ?,
                  'unverified', ?, ?
           FROM verification_suites
           JOIN attempts ON attempts.attempt_id = verification_suites.attempt_id
           JOIN runs ON runs.run_id = verification_suites.run_id
           JOIN execution_plans ON execution_plans.plan_id = verification_suites.plan_id
           JOIN plan_item_progress
             ON plan_item_progress.plan_id = verification_suites.plan_id
            AND plan_item_progress.item_id = verification_suites.plan_item_id
           JOIN verification_suite_commands
             ON verification_suite_commands.suite_id = verification_suites.suite_id
            AND verification_suite_commands.position = ?
           WHERE verification_suites.suite_id = ?
             AND verification_suites.status = 'running'
             AND verification_suites.attempt_id = ?
             AND verification_suites.lease_generation = ?
             AND verification_suites.head_sha = ?
             AND attempts.status = 'running' AND attempts.version = ?
             AND attempts.lease_generation = ? AND attempts.lease_expires_at > ?
             AND attempts.head_sha = verification_suites.head_sha
             AND runs.state = 'executing'
             AND runs.active_plan_id = verification_suites.plan_id
             AND runs.active_plan_version = verification_suites.plan_version
             AND runs.active_plan_digest = execution_plans.digest
             AND execution_plans.status = 'active'
             AND plan_item_progress.status = 'in_progress'
             AND plan_item_progress.active_attempt_id = attempts.attempt_id
             AND verification_suite_commands.phase = ?
             AND verification_suite_commands.command_ref = ?
             AND verification_suite_commands.result_status = 'pending'
             AND verification_suite_commands.evidence_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM verification_suite_commands AS earlier
               WHERE earlier.suite_id = verification_suites.suite_id
                 AND earlier.position < verification_suite_commands.position
                 AND earlier.result_status <> 'passed'
             )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          evidenceId,
          evidenceStatus,
          result.commandRef,
          result.exitCode,
          result.durationMs,
          result.headSha,
          summary,
          nowIso,
          nowIso,
          result.position,
          suiteId,
          authorization.attemptId,
          authorization.leaseGeneration,
          result.headSha,
          authorization.version,
          authorization.leaseGeneration,
          nowIso,
          result.phase,
          result.commandRef,
        ),
      this.db
        .prepare(
          `UPDATE verification_suite_commands
           SET result_status = ?, evidence_id = ?, updated_at = ?
           WHERE suite_id = ? AND position = ? AND phase = ? AND command_ref = ?
             AND result_status = 'pending' AND evidence_id IS NULL
             AND EXISTS (
               SELECT 1 FROM evidence
               WHERE evidence_id = ? AND attempt_id = ? AND command_ref = ?
                 AND exit_code = ? AND duration_ms = ? AND sha = ? AND status = ?
             )`,
        )
        .bind(
          evidenceStatus,
          evidenceId,
          nowIso,
          suiteId,
          result.position,
          result.phase,
          result.commandRef,
          evidenceId,
          authorization.attemptId,
          result.commandRef,
          result.exitCode,
          result.durationMs,
          result.headSha,
          evidenceStatus,
        ),
      this.db
        .prepare(
          `UPDATE verification_suites
           SET status = CASE
                 WHEN ? <> 0 THEN 'failed'
                 WHEN NOT EXISTS (
                   SELECT 1 FROM verification_suite_commands
                   WHERE verification_suite_commands.suite_id = verification_suites.suite_id
                     AND verification_suite_commands.result_status = 'pending'
                 ) THEN 'completed'
                 ELSE 'running'
               END,
               updated_at = ?
           WHERE suite_id = ? AND status = 'running'
             AND EXISTS (
               SELECT 1 FROM verification_suite_commands
               WHERE verification_suite_commands.suite_id = verification_suites.suite_id
                 AND verification_suite_commands.position = ?
                 AND verification_suite_commands.evidence_id = ?
                 AND verification_suite_commands.result_status = ?
             )`,
        )
        .bind(
          result.exitCode,
          nowIso,
          suiteId,
          result.position,
          evidenceId,
          evidenceStatus,
        ),
    ]);
    const persisted = await this.readEvidence(evidenceId);
    if (persisted === null) throw new VerificationEvidenceError('state_conflict');
    return await this.existingEvidence(
      persisted,
      suiteId,
      result,
      authorization,
      commands[0]?.meta.changes === 1,
    );
  }

  private async context(
    authorization: RunnerAuthorization,
  ): Promise<VerificationContextRow | null> {
    return await this.db
      .prepare(
        `SELECT attempts.attempt_id, attempts.run_id, attempts.mode AS attempt_mode,
                attempts.status AS attempt_status, attempts.version AS attempt_version,
                attempts.lease_generation, attempts.lease_expires_at, attempts.head_sha,
                attempts.plan_id, attempts.plan_version, attempts.plan_item_id,
                runs.state AS run_state, runs.active_plan_id, runs.active_plan_version,
                runs.active_plan_digest, execution_plans.digest AS plan_digest,
                execution_plans.status AS plan_status, plan_items.kind AS item_kind,
                plan_items.required AS item_required,
                plan_item_progress.status AS progress_status,
                plan_item_progress.active_attempt_id,
                plan_item_progress.protected_path_gate_id,
                EXISTS (
                  SELECT 1 FROM plan_item_evidence_kinds
                  WHERE plan_item_evidence_kinds.plan_id = attempts.plan_id
                    AND plan_item_evidence_kinds.item_id = attempts.plan_item_id
                    AND plan_item_evidence_kinds.evidence_kind = 'test'
                ) AS has_test_evidence_kind
         FROM attempts
         JOIN runs ON runs.run_id = attempts.run_id
         LEFT JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
         LEFT JOIN plan_items
           ON plan_items.plan_id = attempts.plan_id
          AND plan_items.item_id = attempts.plan_item_id
         LEFT JOIN plan_item_progress
           ON plan_item_progress.plan_id = attempts.plan_id
          AND plan_item_progress.item_id = attempts.plan_item_id
         WHERE attempts.attempt_id = ? AND attempts.run_id = ?`,
      )
      .bind(authorization.attemptId, authorization.runId)
      .first<VerificationContextRow>();
  }

  private assertContext(
    context: VerificationContextRow | null,
    authorization: RunnerAuthorization,
    headSha: string,
    nowIso: string,
  ): asserts context is VerificationContextRow {
    if (
      context === null ||
      context.attempt_status !== 'running' ||
      (context.attempt_mode !== 'implement' && context.attempt_mode !== 'review_fix') ||
      context.attempt_version !== authorization.version ||
      context.lease_generation !== authorization.leaseGeneration ||
      context.lease_expires_at !== authorization.leaseExpiresAt ||
      (context.lease_expires_at ?? '') <= nowIso ||
      context.head_sha !== headSha ||
      context.run_state !== 'executing' ||
      context.active_plan_id !== context.plan_id ||
      context.active_plan_version !== context.plan_version ||
      context.active_plan_digest !== context.plan_digest ||
      context.plan_status !== 'active' ||
      context.item_kind !== 'verification' ||
      context.item_required !== 1 ||
      context.progress_status !== 'in_progress' ||
      context.active_attempt_id !== context.attempt_id ||
      context.protected_path_gate_id !== null ||
      context.has_test_evidence_kind !== 1 ||
      context.plan_id === null ||
      context.plan_version === null ||
      context.plan_item_id === null
    ) {
      throw new VerificationEvidenceError('state_conflict');
    }
  }

  private async assertCommandBinding(
    context: VerificationContextRow,
    manifest: VerificationSuiteManifestV1,
  ): Promise<void> {
    const rows = await this.db
      .prepare(
        `SELECT command_ref FROM plan_item_command_refs
         WHERE plan_id = ? AND item_id = ? ORDER BY command_ref`,
      )
      .bind(context.plan_id, context.plan_item_id)
      .all<{ command_ref: string }>();
    const declared = rows.results.map((row) => row.command_ref).sort();
    const requested = [
      ...manifest.targetedCommandRefs,
      ...manifest.requiredVerifyCommandRefs,
    ].sort();
    if (
      declared.length !== requested.length ||
      declared.some((ref, index) => ref !== requested[index])
    ) {
      throw new VerificationEvidenceError('binding_conflict');
    }
  }

  private async suiteId(
    authorization: RunnerAuthorization,
    manifest: VerificationSuiteManifestV1,
  ): Promise<string> {
    const digest = await canonicalSha256({
      attemptId: authorization.attemptId,
      leaseGeneration: authorization.leaseGeneration,
      manifest,
    });
    return `verification_${digest.slice('sha256:'.length, 'sha256:'.length + 40)}`;
  }

  private async evidenceId(suiteId: string, position: number): Promise<string> {
    const digest = await canonicalSha256({ suiteId, position });
    return `evidence_verification_${digest.slice('sha256:'.length, 'sha256:'.length + 40)}`;
  }

  private async readSuite(suiteId: string): Promise<SuiteRow | null> {
    return await this.db
      .prepare('SELECT * FROM verification_suites WHERE suite_id = ?')
      .bind(suiteId)
      .first<SuiteRow>();
  }

  private async readCommands(suiteId: string): Promise<SuiteCommandRow[]> {
    return (await this.db
      .prepare(
        `SELECT position, phase, command_ref, result_status, evidence_id
         FROM verification_suite_commands WHERE suite_id = ? ORDER BY position`,
      )
      .bind(suiteId)
      .all<SuiteCommandRow>()).results;
  }

  private async startResult(
    row: SuiteRow,
    authorization: RunnerAuthorization,
    manifest: VerificationSuiteManifestV1,
    created: boolean,
  ): Promise<VerificationSuiteStartResult> {
    const commands = await this.readCommands(row.suite_id);
    const expected = verificationSuiteCommands(manifest);
    if (
      row.run_id !== authorization.runId ||
      row.attempt_id !== authorization.attemptId ||
      row.lease_generation !== authorization.leaseGeneration ||
      row.head_sha !== manifest.headSha ||
      row.delivery_policy_digest !== manifest.policyDigest ||
      row.targeted_command_count !== manifest.targetedCommandRefs.length ||
      row.required_command_count !== manifest.requiredVerifyCommandRefs.length ||
      commands.length !== expected.length ||
      commands.some((command, index) =>
        command.position !== expected[index]?.position ||
        command.phase !== expected[index]?.phase ||
        command.command_ref !== expected[index]?.commandRef)
    ) {
      throw new VerificationEvidenceError('binding_conflict');
    }
    return {
      suiteId: row.suite_id,
      created,
      status: row.status,
      commands: commands.map((command) => ({
        position: command.position,
        phase: command.phase,
        commandRef: command.command_ref,
      })),
    };
  }

  private async readEvidence(evidenceId: string): Promise<EvidenceRow | null> {
    return await this.db
      .prepare(
        `SELECT evidence_id, status, command_ref, exit_code, duration_ms, sha
         FROM evidence WHERE evidence_id = ?`,
      )
      .bind(evidenceId)
      .first<EvidenceRow>();
  }

  private async existingEvidence(
    evidence: EvidenceRow,
    suiteId: string,
    result: VerificationCommandResultV1,
    authorization: RunnerAuthorization,
    created: boolean,
  ): Promise<VerificationEvidenceResult> {
    const expectedStatus = result.exitCode === 0 ? 'passed' : 'failed';
    const command = await this.db
      .prepare(
        `SELECT position, phase, command_ref, result_status, evidence_id
         FROM verification_suite_commands WHERE suite_id = ? AND position = ?`,
      )
      .bind(suiteId, result.position)
      .first<SuiteCommandRow>();
    const suite = await this.readSuite(suiteId);
    if (
      suite === null ||
      suite.run_id !== authorization.runId ||
      suite.attempt_id !== authorization.attemptId ||
      suite.lease_generation !== authorization.leaseGeneration ||
      suite.head_sha !== result.headSha ||
      command === null ||
      command.phase !== result.phase ||
      command.command_ref !== result.commandRef ||
      command.result_status !== expectedStatus ||
      command.evidence_id !== evidence.evidence_id ||
      evidence.status !== expectedStatus ||
      evidence.command_ref !== result.commandRef ||
      evidence.exit_code !== result.exitCode ||
      evidence.duration_ms !== result.durationMs ||
      evidence.sha !== result.headSha
    ) {
      throw new VerificationEvidenceError('result_conflict');
    }
    return {
      evidenceId: evidence.evidence_id,
      created,
      suiteStatus: suite.status,
    };
  }
}
