import { canonicalSha256 } from '../domain/digest.js';
import {
  ProtectedPathChangeReportV1Schema,
  computeProtectedPathDiffDigest,
  type ProtectedPathChangeReportV1,
} from '../domain/protected-path-change.js';
import type { RunnerAuthorization } from './runner-attempt-store.js';

export type ProtectedPathApprovalErrorCode =
  | 'invalid_request'
  | 'state_conflict'
  | 'report_conflict';

export class ProtectedPathApprovalError extends Error {
  constructor(readonly code: ProtectedPathApprovalErrorCode) {
    super(`protected path approval operation failed: ${code}`);
    this.name = 'ProtectedPathApprovalError';
  }
}

export interface ProtectedPathApprovalResult {
  gateId: string;
  created: boolean;
  state: 'awaiting_approval';
  runVersion: number;
  report: ProtectedPathChangeReportV1;
}

interface GateContextRow {
  attempt_id: string;
  run_id: string;
  attempt_status: string;
  attempt_version: number;
  lease_generation: number;
  lease_expires_at: string | null;
  attempt_base_sha: string;
  repository: string | null;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  run_state: string;
  run_version: number;
  run_base_sha: string | null;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  plan_digest: string | null;
  plan_status: string | null;
  progress_status: string | null;
  progress_version: number | null;
  active_attempt_id: string | null;
  protected_path_gate_id: string | null;
  target_repository: string;
  allow_repository_write: number;
  has_repo_write_effect: number;
  has_active_write_credential: number;
}

interface GateRow {
  gate_id: string;
  run_id: string;
  attempt_id: string;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  lease_generation: number;
  base_sha: string;
  staged_tree_sha: string;
  delivery_policy_digest: string;
  diff_digest: string;
  total_changed_files: number;
  protected_change_count: number;
  status: string;
}

interface GateEntryRow {
  position: number;
  path: string;
  previous_path: string | null;
  change_type: ProtectedPathChangeReportV1['protectedChanges'][number]['changeType'];
  additions: number | null;
  deletions: number | null;
}

/** Atomically fences a running repo_write Attempt on an exact protected-path tree. */
export class ProtectedPathApprovalStore {
  constructor(private readonly db: D1Database) {}

  async request(
    authorization: RunnerAuthorization,
    rawReport: unknown,
    now = new Date(),
  ): Promise<ProtectedPathApprovalResult> {
    const parsed = ProtectedPathChangeReportV1Schema.safeParse(rawReport);
    if (!parsed.success) throw new ProtectedPathApprovalError('invalid_request');
    const report = parsed.data;
    if (
      await computeProtectedPathDiffDigest(report.baseSha, report.stagedTreeSha) !==
      report.diffDigest
    ) {
      throw new ProtectedPathApprovalError('report_conflict');
    }
    const gateId = await this.gateId(authorization, report.diffDigest);
    const existing = await this.readGate(gateId);
    if (existing !== null) {
      return await this.existingResult(existing, authorization, report, false);
    }

    const nowIso = now.toISOString();
    const context = await this.context(authorization, nowIso);
    this.assertContext(context, authorization, report, nowIso);
    const workflowPauseOutboxId = `workflow-pause-${gateId}`;
    const commands: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO protected_path_change_gates (
             gate_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
             lease_generation, base_sha, staged_tree_sha, delivery_policy_digest,
             diff_digest, total_changed_files, protected_change_count, status,
             created_at, updated_at
           )
           SELECT ?, attempts.run_id, attempts.attempt_id, attempts.plan_id,
                  attempts.plan_version, attempts.plan_item_id, attempts.lease_generation,
                  attempts.base_sha, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?
           FROM attempts
           JOIN runs ON runs.run_id = attempts.run_id
           JOIN tasks ON tasks.task_id = runs.task_id
           JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
           JOIN plan_item_progress
             ON plan_item_progress.plan_id = attempts.plan_id
            AND plan_item_progress.item_id = attempts.plan_item_id
           WHERE attempts.attempt_id = ? AND attempts.run_id = ?
             AND attempts.status = 'running' AND attempts.version = ?
             AND attempts.lease_generation = ? AND attempts.lease_expires_at > ?
             AND attempts.base_sha = ? AND runs.base_sha = attempts.base_sha
             AND attempts.repository = tasks.target_repository
             AND runs.state = 'executing' AND runs.version = ?
             AND runs.active_plan_id = attempts.plan_id
             AND runs.active_plan_version = attempts.plan_version
             AND runs.active_plan_digest = execution_plans.digest
             AND execution_plans.status = 'active'
             AND plan_item_progress.status = 'in_progress'
             AND plan_item_progress.active_attempt_id = attempts.attempt_id
             AND plan_item_progress.protected_path_gate_id IS NULL
             AND tasks.allow_repository_write = 1
             AND EXISTS (
               SELECT 1 FROM plan_item_effects
               WHERE plan_item_effects.plan_id = attempts.plan_id
                 AND plan_item_effects.item_id = attempts.plan_item_id
                 AND plan_item_effects.effect = 'repo_write'
             )
             AND EXISTS (
               SELECT 1 FROM github_write_credentials
               WHERE github_write_credentials.attempt_id = attempts.attempt_id
                 AND github_write_credentials.run_id = attempts.run_id
                 AND github_write_credentials.plan_id = attempts.plan_id
                 AND github_write_credentials.plan_version = attempts.plan_version
                 AND github_write_credentials.plan_item_id = attempts.plan_item_id
                 AND github_write_credentials.repository = attempts.repository
                 AND github_write_credentials.lease_generation = attempts.lease_generation
                 AND github_write_credentials.status = 'active'
                 AND github_write_credentials.authorization_expires_at > ?
             )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          gateId,
          report.stagedTreeSha,
          report.policyDigest,
          report.diffDigest,
          report.totalChangedFiles,
          report.protectedChanges.length,
          nowIso,
          nowIso,
          authorization.attemptId,
          authorization.runId,
          authorization.version,
          authorization.leaseGeneration,
          nowIso,
          report.baseSha,
          context!.run_version,
          nowIso,
        ),
      ...report.protectedChanges.map((change, position) =>
        this.db
          .prepare(
            `INSERT INTO protected_path_change_entries (
               gate_id, position, path, previous_path, change_type, additions, deletions
             )
             SELECT ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM protected_path_change_gates
               WHERE gate_id = ? AND attempt_id = ? AND lease_generation = ?
                 AND diff_digest = ? AND status = 'awaiting_approval'
             )
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            gateId,
            position,
            change.path,
            change.previousPath ?? null,
            change.changeType,
            change.additions,
            change.deletions,
            gateId,
            authorization.attemptId,
            authorization.leaseGeneration,
            report.diffDigest,
          ),
      ),
      this.db
        .prepare(
          `UPDATE runs
           SET state = 'awaiting_approval', version = version + 1, updated_at = ?
           WHERE run_id = ? AND state = 'executing' AND version = ?
             AND EXISTS (
               SELECT 1 FROM protected_path_change_gates
               WHERE gate_id = ? AND run_id = runs.run_id AND status = 'awaiting_approval'
             )`,
        )
        .bind(nowIso, authorization.runId, context!.run_version, gateId),
      this.db
        .prepare(
          `UPDATE attempts
           SET status = 'cancelled', version = version + 1,
               lease_generation = lease_generation + 1,
               lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE attempt_id = ? AND run_id = ? AND status = 'running'
             AND version = ? AND lease_generation = ?
             AND EXISTS (
               SELECT 1 FROM runs
               WHERE run_id = attempts.run_id AND state = 'awaiting_approval'
                 AND version = ?
             )
             AND EXISTS (
               SELECT 1 FROM protected_path_change_gates
               WHERE gate_id = ? AND attempt_id = attempts.attempt_id
             )`,
        )
        .bind(
          nowIso,
          authorization.attemptId,
          authorization.runId,
          authorization.version,
          authorization.leaseGeneration,
          context!.run_version + 1,
          gateId,
        ),
      this.db
        .prepare(
          `UPDATE attempt_tokens
           SET revoked_at = ?
           WHERE attempt_id = ? AND lease_generation = ? AND revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM attempts
               WHERE attempt_id = attempt_tokens.attempt_id AND status = 'cancelled'
                 AND version = ? AND lease_generation = ?
             )`,
        )
        .bind(
          nowIso,
          authorization.attemptId,
          authorization.leaseGeneration,
          authorization.version + 1,
          authorization.leaseGeneration + 1,
        ),
      this.db
        .prepare(
          `UPDATE plan_item_progress
           SET protected_path_gate_id = ?, version = version + 1, updated_at = ?
           WHERE plan_id = ? AND item_id = ? AND status = 'in_progress'
             AND active_attempt_id = ? AND version = ?
             AND protected_path_gate_id IS NULL
             AND EXISTS (
               SELECT 1 FROM attempts
               WHERE attempt_id = plan_item_progress.active_attempt_id
                 AND status = 'cancelled' AND version = ?
             )`,
        )
        .bind(
          gateId,
          nowIso,
          context!.plan_id,
          context!.plan_item_id,
          authorization.attemptId,
          context!.progress_version,
          authorization.version + 1,
        ),
      this.db
        .prepare(
          `UPDATE github_write_credentials
           SET status = 'revocation_pending', updated_at = ?
           WHERE attempt_id = ? AND lease_generation = ? AND status = 'active'
             AND EXISTS (
               SELECT 1 FROM protected_path_change_gates
               WHERE gate_id = ? AND attempt_id = github_write_credentials.attempt_id
             )`,
        )
        .bind(nowIso, authorization.attemptId, authorization.leaseGeneration, gateId),
      this.db
        .prepare(
          `INSERT INTO outbox (
             outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
             delivery_state, created_at, updated_at
           )
           SELECT ?, ?, 'workflow_pause', 'cloudflare_workflows', ?, ?, 'pending', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM protected_path_change_gates
             JOIN runs ON runs.run_id = protected_path_change_gates.run_id
             JOIN attempts ON attempts.attempt_id = protected_path_change_gates.attempt_id
             WHERE protected_path_change_gates.gate_id = ?
               AND protected_path_change_gates.status = 'awaiting_approval'
               AND runs.state = 'awaiting_approval' AND attempts.status = 'cancelled'
           )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          workflowPauseOutboxId,
          authorization.runId,
          `d1://protected-path-gates/${gateId}`,
          `workflow-pause:${gateId}`,
          nowIso,
          nowIso,
          gateId,
        ),
    ];
    const results = await this.db.batch(commands);
    const persisted = await this.readGate(gateId);
    if (persisted === null) throw new ProtectedPathApprovalError('state_conflict');
    const result = await this.existingResult(
      persisted,
      authorization,
      report,
      results[0]?.meta.changes === 1,
    );
    const state = await this.db
      .prepare(
        `SELECT runs.state, runs.version AS run_version, attempts.status,
                attempts.version AS attempt_version, attempts.lease_generation,
                plan_item_progress.protected_path_gate_id,
                github_write_credentials.status AS credential_status,
                outbox.delivery_state
         FROM protected_path_change_gates
         JOIN runs ON runs.run_id = protected_path_change_gates.run_id
         JOIN attempts ON attempts.attempt_id = protected_path_change_gates.attempt_id
         JOIN plan_item_progress
           ON plan_item_progress.plan_id = protected_path_change_gates.plan_id
          AND plan_item_progress.item_id = protected_path_change_gates.plan_item_id
         JOIN github_write_credentials
           ON github_write_credentials.attempt_id = protected_path_change_gates.attempt_id
          AND github_write_credentials.lease_generation = protected_path_change_gates.lease_generation
         JOIN outbox ON outbox.outbox_id = ?
         WHERE protected_path_change_gates.gate_id = ?`,
      )
      .bind(workflowPauseOutboxId, gateId)
      .first<{
        state: string;
        run_version: number;
        status: string;
        attempt_version: number;
        lease_generation: number;
        protected_path_gate_id: string | null;
        credential_status: string;
        delivery_state: string;
      }>();
    if (
      state?.state !== 'awaiting_approval' ||
      state.run_version !== context!.run_version + 1 ||
      state.status !== 'cancelled' ||
      state.attempt_version !== authorization.version + 1 ||
      state.lease_generation !== authorization.leaseGeneration + 1 ||
      state.protected_path_gate_id !== gateId ||
      state.credential_status !== 'revocation_pending' ||
      state.delivery_state !== 'pending'
    ) {
      throw new ProtectedPathApprovalError('state_conflict');
    }
    return result;
  }

  private async context(
    authorization: RunnerAuthorization,
    nowIso: string,
  ): Promise<GateContextRow | null> {
    return await this.db
      .prepare(
        `SELECT attempts.attempt_id, attempts.run_id,
                attempts.status AS attempt_status, attempts.version AS attempt_version,
                attempts.lease_generation, attempts.lease_expires_at,
                attempts.base_sha AS attempt_base_sha, attempts.repository,
                attempts.plan_id, attempts.plan_version, attempts.plan_item_id,
                runs.state AS run_state, runs.version AS run_version,
                runs.base_sha AS run_base_sha, runs.active_plan_id,
                runs.active_plan_version, runs.active_plan_digest,
                execution_plans.digest AS plan_digest,
                execution_plans.status AS plan_status,
                plan_item_progress.status AS progress_status,
                plan_item_progress.version AS progress_version,
                plan_item_progress.active_attempt_id,
                plan_item_progress.protected_path_gate_id,
                tasks.target_repository, tasks.allow_repository_write,
                EXISTS (
                  SELECT 1 FROM plan_item_effects
                  WHERE plan_item_effects.plan_id = attempts.plan_id
                    AND plan_item_effects.item_id = attempts.plan_item_id
                    AND plan_item_effects.effect = 'repo_write'
                ) AS has_repo_write_effect,
                EXISTS (
                  SELECT 1 FROM github_write_credentials
                  WHERE github_write_credentials.attempt_id = attempts.attempt_id
                    AND github_write_credentials.run_id = attempts.run_id
                    AND github_write_credentials.plan_id = attempts.plan_id
                    AND github_write_credentials.plan_version = attempts.plan_version
                    AND github_write_credentials.plan_item_id = attempts.plan_item_id
                    AND github_write_credentials.repository = attempts.repository
                    AND github_write_credentials.lease_generation = attempts.lease_generation
                    AND github_write_credentials.status = 'active'
                    AND github_write_credentials.authorization_expires_at > ?
                ) AS has_active_write_credential
         FROM attempts
         JOIN runs ON runs.run_id = attempts.run_id
         JOIN tasks ON tasks.task_id = runs.task_id
         LEFT JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
         LEFT JOIN plan_item_progress
           ON plan_item_progress.plan_id = attempts.plan_id
          AND plan_item_progress.item_id = attempts.plan_item_id
         WHERE attempts.attempt_id = ? AND attempts.run_id = ?`,
      )
      .bind(nowIso, authorization.attemptId, authorization.runId)
      .first<GateContextRow>();
  }

  private assertContext(
    context: GateContextRow | null,
    authorization: RunnerAuthorization,
    report: ProtectedPathChangeReportV1,
    nowIso: string,
  ): asserts context is GateContextRow {
    if (
      context === null ||
      context.attempt_status !== 'running' ||
      context.attempt_version !== authorization.version ||
      context.lease_generation !== authorization.leaseGeneration ||
      context.lease_expires_at !== authorization.leaseExpiresAt ||
      (context.lease_expires_at ?? '') <= nowIso ||
      context.attempt_base_sha !== report.baseSha ||
      context.run_base_sha !== report.baseSha ||
      context.repository !== context.target_repository ||
      context.run_state !== 'executing' ||
      context.active_plan_id !== context.plan_id ||
      context.active_plan_version !== context.plan_version ||
      context.active_plan_digest !== context.plan_digest ||
      context.plan_status !== 'active' ||
      context.progress_status !== 'in_progress' ||
      context.active_attempt_id !== context.attempt_id ||
      context.protected_path_gate_id !== null ||
      context.allow_repository_write !== 1 ||
      context.has_repo_write_effect !== 1 ||
      context.has_active_write_credential !== 1 ||
      context.plan_id === null ||
      context.plan_version === null ||
      context.plan_item_id === null ||
      context.progress_version === null
    ) {
      throw new ProtectedPathApprovalError('state_conflict');
    }
  }

  private async gateId(
    authorization: RunnerAuthorization,
    diffDigest: string,
  ): Promise<string> {
    const digest = await canonicalSha256({
      attemptId: authorization.attemptId,
      leaseGeneration: authorization.leaseGeneration,
      diffDigest,
    });
    return `protected_path_${digest.slice('sha256:'.length, 'sha256:'.length + 40)}`;
  }

  private async readGate(gateId: string): Promise<GateRow | null> {
    return await this.db
      .prepare('SELECT * FROM protected_path_change_gates WHERE gate_id = ?')
      .bind(gateId)
      .first<GateRow>();
  }

  private async existingResult(
    row: GateRow,
    authorization: RunnerAuthorization,
    report: ProtectedPathChangeReportV1,
    created: boolean,
  ): Promise<ProtectedPathApprovalResult> {
    const entries = await this.db
      .prepare(
        `SELECT position, path, previous_path, change_type, additions, deletions
         FROM protected_path_change_entries WHERE gate_id = ? ORDER BY position`,
      )
      .bind(row.gate_id)
      .all<GateEntryRow>();
    const persistedReport: ProtectedPathChangeReportV1 = {
      schemaVersion: '1',
      baseSha: row.base_sha,
      stagedTreeSha: row.staged_tree_sha,
      policyDigest: row.delivery_policy_digest,
      diffDigest: row.diff_digest,
      totalChangedFiles: row.total_changed_files,
      protectedChanges: entries.results.map((entry) => ({
        path: entry.path,
        ...(entry.previous_path === null ? {} : { previousPath: entry.previous_path }),
        changeType: entry.change_type,
        additions: entry.additions,
        deletions: entry.deletions,
      })),
    };
    if (
      row.attempt_id !== authorization.attemptId ||
      row.run_id !== authorization.runId ||
      row.lease_generation !== authorization.leaseGeneration ||
      row.status !== 'awaiting_approval' ||
      row.protected_change_count !== persistedReport.protectedChanges.length ||
      await canonicalSha256(persistedReport) !== await canonicalSha256(report)
    ) {
      throw new ProtectedPathApprovalError('report_conflict');
    }
    const run = await this.db
      .prepare('SELECT state, version FROM runs WHERE run_id = ?')
      .bind(row.run_id)
      .first<{ state: string; version: number }>();
    if (run?.state !== 'awaiting_approval') {
      throw new ProtectedPathApprovalError('state_conflict');
    }
    return {
      gateId: row.gate_id,
      created,
      state: 'awaiting_approval',
      runVersion: run.version,
      report: persistedReport,
    };
  }
}
