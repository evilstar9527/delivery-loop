import { z } from 'zod';
import {
  TEST_ACCEPTANCE_OIDC_AUDIENCE,
  TEST_ACCEPTANCE_WORKFLOW_PATH,
} from '../domain/delivery-policy.js';
import { canonicalSha256 } from '../domain/digest.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

const ScheduleTestAcceptanceInputSchema = z.object({
  runId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
  planVersion: z.number().int().positive(),
  planItemId: z.string().regex(ID_PATTERN),
  expectedProgressVersion: z.number().int().positive(),
}).strict();

export type ScheduleTestAcceptanceInput = z.infer<typeof ScheduleTestAcceptanceInputSchema>;

export type TestAcceptanceStoreErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'state_conflict'
  | 'policy_denied';

export class TestAcceptanceStoreError extends Error {
  constructor(readonly code: TestAcceptanceStoreErrorCode) {
    super(`test acceptance scheduling failed: ${code}`);
    this.name = 'TestAcceptanceStoreError';
  }
}

export interface TestAcceptanceScheduleResult {
  acceptanceId: string;
  deploymentId: string;
  attemptId: string;
  outboxId: string;
  runId: string;
  planId: string;
  planVersion: number;
  planItemId: string;
  commandRef: string;
  refSha: string;
  environmentUrl: string;
  created: boolean;
}

interface CandidateRow {
  run_id: string;
  run_state: string;
  run_version: number;
  base_sha: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_status: string;
  item_id: string;
  item_kind: string;
  item_required: number;
  progress_status: string;
  progress_version: number;
  active_attempt_id: string | null;
  repository: string;
  base_branch: string;
  target_environment: string;
  incomplete_dependency_count: number;
  forbidden_effect_count: number;
  repo_read_effect_count: number;
  command_ref_count: number;
  command_ref: string | null;
  test_evidence_count: number;
  forbidden_evidence_kind_count: number;
  external_fact_count: number;
  done_when_count: number;
  deployment_id: string | null;
  deployment_ref_sha: string | null;
  deployment_url: string | null;
  deployment_evidence_verified: number;
}

interface ExistingRow {
  acceptance_id: string;
  deployment_id: string;
  attempt_id: string;
  run_id: string;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  command_ref: string;
  ref_sha: string;
  environment_url: string;
  outbox_id: string | null;
}

function validEnvironmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' &&
      url.search === '' && url.hash === '' && value.length <= 2_000;
  } catch {
    return false;
  }
}

/** Claims an acceptance-only Item after a verified test deployment has passed. */
export class TestAcceptanceStore {
  constructor(private readonly db: D1Database) {}

  async schedule(
    rawInput: unknown,
    now = new Date(),
  ): Promise<TestAcceptanceScheduleResult> {
    const parsed = ScheduleTestAcceptanceInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new TestAcceptanceStoreError('invalid_request');
    const input = parsed.data;
    const candidate = await this.candidate(input);
    if (candidate === null) throw new TestAcceptanceStoreError('not_found');
    this.assertCandidate(candidate, input);
    if (
      candidate.command_ref === null || candidate.deployment_id === null ||
      candidate.deployment_ref_sha === null || candidate.deployment_url === null
    ) throw new TestAcceptanceStoreError('state_conflict');

    const identity = await canonicalSha256({
      runId: candidate.run_id,
      runVersion: candidate.run_version,
      planId: candidate.plan_id,
      planVersion: candidate.plan_version,
      planDigest: candidate.plan_digest,
      planItemId: candidate.item_id,
      progressVersion: candidate.progress_version,
      deploymentId: candidate.deployment_id,
      refSha: candidate.deployment_ref_sha,
      commandRef: candidate.command_ref,
      environmentUrl: candidate.deployment_url,
    });
    const suffix = identity.slice('sha256:'.length, 'sha256:'.length + 40);
    const acceptanceId = `acceptance_test_${suffix}`;
    const attemptId = `attempt_test_acceptance_${suffix}`;
    const outboxId = `outbox_test_acceptance_${suffix}`;
    const existing = await this.existing(acceptanceId);
    if (existing !== null) return this.result(existing, outboxId, false);

    const nowIso = now.toISOString();
    const workflowRef =
      `${candidate.repository}/${TEST_ACCEPTANCE_WORKFLOW_PATH}@refs/heads/${candidate.base_branch}`;
    const statements = [
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, head_sha,
           repository, workflow_ref, plan_id, plan_version, plan_item_id,
           claimed_progress_version, version, lease_generation, created_at, updated_at
         )
         SELECT ?, runs.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = runs.run_id),
                'deploy', 'pending', runs.base_sha, ?, tasks.target_repository, ?,
                plans.plan_id, plans.plan_version, items.item_id, ?, 0, 0, ?, ?
         FROM runs
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
         JOIN plan_items AS items ON items.plan_id = plans.plan_id
         JOIN plan_item_progress AS progress
           ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
         WHERE runs.run_id = ? AND runs.version = ? AND runs.state = 'executing'
           AND tasks.target_environment = 'test' AND tasks.allow_test_deploy = 1
           AND plans.plan_version = ? AND plans.status = 'active'
           AND plans.digest = ? AND plans.base_sha = runs.base_sha
           AND items.item_id = ? AND items.kind = 'verification' AND items.required = 1
           AND progress.status = 'ready' AND progress.version = ?
           AND progress.active_attempt_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM plan_item_dependencies
             LEFT JOIN plan_item_progress AS dependency_progress
               ON dependency_progress.plan_id = plan_item_dependencies.plan_id
              AND dependency_progress.item_id = plan_item_dependencies.depends_on_item_id
             WHERE plan_item_dependencies.plan_id = items.plan_id
               AND plan_item_dependencies.item_id = items.item_id
               AND (dependency_progress.status IS NULL OR dependency_progress.status <> 'passed')
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        attemptId,
        candidate.deployment_ref_sha,
        workflowRef,
        candidate.progress_version,
        nowIso,
        nowIso,
        candidate.run_id,
        candidate.run_version,
        candidate.plan_version,
        candidate.plan_digest,
        candidate.item_id,
        candidate.progress_version,
      ),
      this.db.prepare(
        `UPDATE plan_item_progress
         SET status = 'in_progress', active_attempt_id = ?,
             version = version + 1, updated_at = ?
         WHERE plan_id = ? AND item_id = ? AND status = 'ready' AND version = ?
           AND active_attempt_id IS NULL
           AND EXISTS (
             SELECT 1 FROM attempts
             WHERE attempt_id = ? AND mode = 'deploy' AND status = 'pending'
               AND plan_id = plan_item_progress.plan_id
               AND plan_item_id = plan_item_progress.item_id
           )`,
      ).bind(
        attemptId,
        nowIso,
        candidate.plan_id,
        candidate.item_id,
        candidate.progress_version,
        attemptId,
      ),
      this.db.prepare(
        `INSERT INTO test_acceptances (
           acceptance_id, deployment_id, run_id, run_version, plan_id,
           plan_version, plan_digest, plan_item_id, attempt_id, repository,
           base_branch, base_sha, ref_sha, workflow_path, environment,
           oidc_audience, command_ref, environment_url, status, created_at, updated_at
         )
         SELECT ?, deployments.deployment_id, runs.run_id, runs.version,
                plans.plan_id, plans.plan_version, plans.digest, items.item_id,
                attempts.attempt_id, tasks.target_repository, tasks.target_base_branch,
                runs.base_sha, deployments.ref_sha, ?, 'test', ?, ?,
                deployments.external_url, 'scheduled', ?, ?
         FROM attempts
         JOIN runs ON runs.run_id = attempts.run_id
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans AS plans ON plans.plan_id = attempts.plan_id
         JOIN plan_items AS items
           ON items.plan_id = attempts.plan_id AND items.item_id = attempts.plan_item_id
         JOIN plan_item_progress AS progress
           ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
         JOIN plan_item_dependencies AS dependencies
           ON dependencies.plan_id = items.plan_id AND dependencies.item_id = items.item_id
         JOIN test_deployments AS deployments
           ON deployments.plan_id = dependencies.plan_id
          AND deployments.plan_item_id = dependencies.depends_on_item_id
          AND deployments.run_id = runs.run_id
         JOIN evidence ON evidence.evidence_id = deployments.evidence_id
         WHERE attempts.attempt_id = ? AND attempts.status = 'pending'
           AND attempts.mode = 'deploy' AND attempts.head_sha = deployments.ref_sha
           AND runs.run_id = ? AND runs.version = ? AND runs.state = 'executing'
           AND runs.active_plan_id = plans.plan_id
           AND runs.active_plan_version = plans.plan_version
           AND runs.active_plan_digest = plans.digest AND plans.status = 'active'
           AND progress.status = 'in_progress'
           AND progress.active_attempt_id = attempts.attempt_id
           AND deployments.deployment_id = ? AND deployments.status = 'succeeded'
           AND deployments.external_url IS NOT NULL
           AND evidence.kind = 'deployment' AND evidence.status = 'passed'
           AND evidence.verification_status = 'verified'
         ON CONFLICT DO NOTHING`,
      ).bind(
        acceptanceId,
        TEST_ACCEPTANCE_WORKFLOW_PATH,
        TEST_ACCEPTANCE_OIDC_AUDIENCE,
        candidate.command_ref,
        nowIso,
        nowIso,
        attemptId,
        candidate.run_id,
        candidate.run_version,
        candidate.deployment_id,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, run_id, 'test_acceptance_dispatch', 'github_acceptance', ?, ?,
                'pending', ?, ?
         FROM test_acceptances WHERE acceptance_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId,
        `d1://test-acceptances/${acceptanceId}`,
        `test-acceptance:${acceptanceId}`,
        nowIso,
        nowIso,
        acceptanceId,
      ),
    ];
    const results = await this.db.batch(statements);
    const persisted = await this.existing(acceptanceId);
    if (persisted === null || persisted.outbox_id === null) {
      throw new TestAcceptanceStoreError('state_conflict');
    }
    return this.result(
      persisted,
      outboxId,
      results[2]?.meta.changes === 1 && results[3]?.meta.changes === 1,
    );
  }

  private assertCandidate(
    row: CandidateRow,
    input: ScheduleTestAcceptanceInput,
  ): void {
    if (
      row.run_state !== 'executing' || row.run_version !== input.expectedRunVersion ||
      row.plan_version !== input.planVersion || row.plan_status !== 'active' ||
      row.item_id !== input.planItemId || row.item_kind !== 'verification' ||
      row.item_required !== 1 || row.progress_status !== 'ready' ||
      row.progress_version !== input.expectedProgressVersion ||
      row.active_attempt_id !== null || row.target_environment !== 'test' ||
      row.incomplete_dependency_count !== 0 || row.forbidden_effect_count !== 0 ||
      row.repo_read_effect_count !== 1 || row.command_ref_count !== 1 ||
      row.command_ref === null || !/^acceptance:[a-z][a-z0-9_-]{0,63}$/.test(row.command_ref) ||
      row.test_evidence_count !== 1 || row.forbidden_evidence_kind_count !== 0 ||
      row.external_fact_count !== 0 ||
      row.done_when_count < 1 || row.deployment_id === null ||
      row.deployment_ref_sha === null || row.deployment_url === null ||
      !validEnvironmentUrl(row.deployment_url) ||
      row.deployment_evidence_verified !== 1
    ) throw new TestAcceptanceStoreError('policy_denied');
  }

  private async candidate(input: ScheduleTestAcceptanceInput): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT runs.run_id, runs.state AS run_state, runs.version AS run_version,
              runs.base_sha, plans.plan_id, plans.plan_version,
              plans.digest AS plan_digest, plans.status AS plan_status,
              items.item_id, items.kind AS item_kind, items.required AS item_required,
              progress.status AS progress_status, progress.version AS progress_version,
              progress.active_attempt_id, tasks.target_repository AS repository,
              tasks.target_base_branch AS base_branch, tasks.target_environment,
              (SELECT COUNT(*) FROM plan_item_dependencies
               LEFT JOIN plan_item_progress AS dependency_progress
                 ON dependency_progress.plan_id = plan_item_dependencies.plan_id
                AND dependency_progress.item_id = plan_item_dependencies.depends_on_item_id
               WHERE plan_item_dependencies.plan_id = items.plan_id
                 AND plan_item_dependencies.item_id = items.item_id
                 AND (dependency_progress.status IS NULL OR dependency_progress.status <> 'passed'))
                AS incomplete_dependency_count,
              (SELECT COUNT(*) FROM plan_item_effects
               WHERE plan_item_effects.plan_id = items.plan_id
                 AND plan_item_effects.item_id = items.item_id
                 AND plan_item_effects.effect <> 'repo_read') AS forbidden_effect_count,
              (SELECT COUNT(*) FROM plan_item_effects
               WHERE plan_item_effects.plan_id = items.plan_id
                 AND plan_item_effects.item_id = items.item_id
                 AND plan_item_effects.effect = 'repo_read') AS repo_read_effect_count,
              (SELECT COUNT(*) FROM plan_item_command_refs
               WHERE plan_item_command_refs.plan_id = items.plan_id
                 AND plan_item_command_refs.item_id = items.item_id) AS command_ref_count,
              (SELECT command_ref FROM plan_item_command_refs
               WHERE plan_item_command_refs.plan_id = items.plan_id
                 AND plan_item_command_refs.item_id = items.item_id LIMIT 1) AS command_ref,
              (SELECT COUNT(*) FROM plan_item_evidence_kinds
               WHERE plan_item_evidence_kinds.plan_id = items.plan_id
                 AND plan_item_evidence_kinds.item_id = items.item_id
                 AND plan_item_evidence_kinds.evidence_kind = 'test') AS test_evidence_count,
              (SELECT COUNT(*) FROM plan_item_evidence_kinds
               WHERE plan_item_evidence_kinds.plan_id = items.plan_id
                 AND plan_item_evidence_kinds.item_id = items.item_id
                 AND plan_item_evidence_kinds.evidence_kind <> 'test')
                AS forbidden_evidence_kind_count,
              (SELECT COUNT(*) FROM plan_item_external_facts
               WHERE plan_item_external_facts.plan_id = items.plan_id
                 AND plan_item_external_facts.item_id = items.item_id) AS external_fact_count,
              (SELECT COUNT(*) FROM plan_item_done_when
               WHERE plan_item_done_when.plan_id = items.plan_id
                 AND plan_item_done_when.item_id = items.item_id) AS done_when_count,
              (SELECT deployments.deployment_id
               FROM plan_item_dependencies AS dependencies
               JOIN test_deployments AS deployments
                 ON deployments.plan_id = dependencies.plan_id
                AND deployments.plan_item_id = dependencies.depends_on_item_id
                AND deployments.run_id = runs.run_id
               WHERE dependencies.plan_id = items.plan_id
                 AND dependencies.item_id = items.item_id
                 AND deployments.status = 'succeeded'
               ORDER BY deployments.created_at DESC LIMIT 1) AS deployment_id,
              (SELECT deployments.ref_sha
               FROM plan_item_dependencies AS dependencies
               JOIN test_deployments AS deployments
                 ON deployments.plan_id = dependencies.plan_id
                AND deployments.plan_item_id = dependencies.depends_on_item_id
                AND deployments.run_id = runs.run_id
               WHERE dependencies.plan_id = items.plan_id
                 AND dependencies.item_id = items.item_id
                 AND deployments.status = 'succeeded'
               ORDER BY deployments.created_at DESC LIMIT 1) AS deployment_ref_sha,
              (SELECT deployments.external_url
               FROM plan_item_dependencies AS dependencies
               JOIN test_deployments AS deployments
                 ON deployments.plan_id = dependencies.plan_id
                AND deployments.plan_item_id = dependencies.depends_on_item_id
                AND deployments.run_id = runs.run_id
               WHERE dependencies.plan_id = items.plan_id
                 AND dependencies.item_id = items.item_id
                 AND deployments.status = 'succeeded'
               ORDER BY deployments.created_at DESC LIMIT 1) AS deployment_url,
              EXISTS (
                SELECT 1 FROM plan_item_dependencies AS dependencies
                JOIN test_deployments AS deployments
                  ON deployments.plan_id = dependencies.plan_id
                 AND deployments.plan_item_id = dependencies.depends_on_item_id
                 AND deployments.run_id = runs.run_id
                JOIN evidence ON evidence.evidence_id = deployments.evidence_id
                WHERE dependencies.plan_id = items.plan_id
                  AND dependencies.item_id = items.item_id
                  AND deployments.status = 'succeeded'
                  AND evidence.kind = 'deployment' AND evidence.status = 'passed'
                  AND evidence.verification_status = 'verified'
              ) AS deployment_evidence_verified
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN plan_items AS items ON items.plan_id = plans.plan_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
       WHERE runs.run_id = ? AND plans.plan_version = ? AND items.item_id = ?`,
    ).bind(input.runId, input.planVersion, input.planItemId).first<CandidateRow>();
  }

  private async existing(acceptanceId: string): Promise<ExistingRow | null> {
    return await this.db.prepare(
      `SELECT acceptances.acceptance_id, acceptances.deployment_id,
              acceptances.attempt_id, acceptances.run_id, acceptances.plan_id,
              acceptances.plan_version, acceptances.plan_item_id,
              acceptances.command_ref, acceptances.ref_sha,
              acceptances.environment_url, outbox.outbox_id
       FROM test_acceptances AS acceptances
       LEFT JOIN outbox
         ON outbox.payload_ref = 'd1://test-acceptances/' || acceptances.acceptance_id
        AND outbox.kind = 'test_acceptance_dispatch'
        AND outbox.destination = 'github_acceptance'
       WHERE acceptances.acceptance_id = ?`,
    ).bind(acceptanceId).first<ExistingRow>();
  }

  private result(
    row: ExistingRow,
    expectedOutboxId: string,
    created: boolean,
  ): TestAcceptanceScheduleResult {
    if (row.outbox_id !== expectedOutboxId) {
      throw new TestAcceptanceStoreError('state_conflict');
    }
    return {
      acceptanceId: row.acceptance_id,
      deploymentId: row.deployment_id,
      attemptId: row.attempt_id,
      outboxId: row.outbox_id,
      runId: row.run_id,
      planId: row.plan_id,
      planVersion: row.plan_version,
      planItemId: row.plan_item_id,
      commandRef: row.command_ref,
      refSha: row.ref_sha,
      environmentUrl: row.environment_url,
      created,
    };
  }
}
