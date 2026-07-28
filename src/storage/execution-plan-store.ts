import {
  validateExecutionPlanProposal,
  type ExecutionPlanV1,
  type ExecutionPlanValidationContext,
} from '../domain/plan.js';

type ExecutionPlanPersistenceErrorCode =
  | 'run_mismatch'
  | 'attempt_mismatch'
  | 'version_conflict'
  | 'plan_conflict';

export class ExecutionPlanPersistenceError extends Error {
  constructor(readonly code: ExecutionPlanPersistenceErrorCode) {
    super(`ExecutionPlan persistence failed: ${code}`);
    this.name = 'ExecutionPlanPersistenceError';
  }
}

interface PersistedPlanRow {
  plan_id: string;
  run_id: string;
  plan_version: number;
  digest: string;
  status: string;
}

interface PlanRunRow {
  task_revision: string;
  base_sha: string | null;
  state: string;
}

interface AnalysisAttemptRow {
  run_id: string;
  base_sha: string;
  mode: string;
  status: string;
}

function persistedStatus(status: string): ExecutionPlanV1['status'] {
  switch (status) {
    case 'validated':
    case 'active':
      return status;
    default:
      throw new ExecutionPlanPersistenceError('plan_conflict');
  }
}

/** Persists only proposals that the domain validator binds to trusted policy and Run context. */
export class ExecutionPlanStore {
  constructor(private readonly db: D1Database) {}

  async saveValidatedProposal(
    input: unknown,
    context: ExecutionPlanValidationContext,
    now: string,
  ): Promise<ExecutionPlanV1> {
    const plan = await validateExecutionPlanProposal(input, context);

    const existing = await this.db
      .prepare(
        `SELECT plan_id, run_id, plan_version, digest, status
         FROM execution_plans
         WHERE plan_id = ? OR (run_id = ? AND plan_version = ?)
         LIMIT 1`,
      )
      .bind(plan.id, plan.runId, plan.version)
      .first<PersistedPlanRow>();
    if (existing !== null) {
      if (
        existing.plan_id === plan.id &&
        existing.run_id === plan.runId &&
        existing.plan_version === plan.version &&
        existing.digest === plan.digest
      ) {
        return { ...plan, status: persistedStatus(existing.status) };
      }
      throw new ExecutionPlanPersistenceError('plan_conflict');
    }

    const run = await this.db
      .prepare('SELECT task_revision, base_sha, state FROM runs WHERE run_id = ?')
      .bind(plan.runId)
      .first<PlanRunRow>();
    if (
      run === null ||
      run.state !== 'planning' ||
      run.task_revision !== plan.taskRevision ||
      run.base_sha !== plan.baseSha
    ) {
      throw new ExecutionPlanPersistenceError('run_mismatch');
    }

    const attempt = await this.db
      .prepare(
        `SELECT run_id, base_sha, mode, status
         FROM attempts
         WHERE attempt_id = ?`,
      )
      .bind(plan.createdByAttemptId)
      .first<AnalysisAttemptRow>();
    if (
      attempt === null ||
      attempt.run_id !== plan.runId ||
      attempt.base_sha !== plan.baseSha ||
      attempt.mode !== 'analysis' ||
      (attempt.status !== 'pending' && attempt.status !== 'running')
    ) {
      throw new ExecutionPlanPersistenceError('attempt_mismatch');
    }

    const versionRow = await this.db
      .prepare(
        `SELECT COALESCE(MAX(plan_version), 0) + 1 AS next_version
         FROM execution_plans
         WHERE run_id = ?`,
      )
      .bind(plan.runId)
      .first<{ next_version: number }>();
    if (versionRow === null || versionRow.next_version !== plan.version) {
      throw new ExecutionPlanPersistenceError('version_conflict');
    }

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO execution_plans (
             plan_id, run_id, plan_version, task_revision, base_sha, digest,
             status, created_by_attempt_id, objective, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'validated', ?, ?, ?, ?)`,
        )
        .bind(
          plan.id,
          plan.runId,
          plan.version,
          plan.taskRevision,
          plan.baseSha,
          plan.digest,
          plan.createdByAttemptId,
          plan.objective,
          now,
          now,
        ),
    ];

    for (const [position, assumption] of plan.assumptions.entries()) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO execution_plan_assumptions (plan_id, position, assumption)
             VALUES (?, ?, ?)`,
          )
          .bind(plan.id, position, assumption),
      );
    }
    for (const [position, evidenceRef] of plan.evidenceRefs.entries()) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO execution_plan_evidence_refs (plan_id, position, evidence_ref)
             VALUES (?, ?, ?)`,
          )
          .bind(plan.id, position, evidenceRef),
      );
    }
    for (const [position, item] of plan.items.entries()) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO plan_items (
               plan_id, item_id, kind, title, objective, required, position
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            plan.id,
            item.id,
            item.kind,
            item.title,
            item.objective,
            item.required ? 1 : 0,
            position,
          ),
        this.db
          .prepare(
            `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
             VALUES (?, ?, 'pending', 0, ?)`,
          )
          .bind(plan.id, item.id, now),
      );
    }

    // Persist relationships only after every item exists; a valid DAG may depend on a later item.
    for (const item of plan.items) {
      for (const criterionIndex of item.acceptanceCriteriaIndexes) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO plan_item_acceptance_criteria (
                 plan_id, item_id, acceptance_criterion_index
               ) VALUES (?, ?, ?)`,
            )
            .bind(plan.id, item.id, criterionIndex),
        );
      }
      for (const [donePosition, condition] of item.doneWhen.entries()) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
               VALUES (?, ?, ?, ?)`,
            )
            .bind(plan.id, item.id, donePosition, condition),
        );
      }
      for (const dependency of item.dependsOn) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO plan_item_dependencies (plan_id, item_id, depends_on_item_id)
               VALUES (?, ?, ?)`,
            )
            .bind(plan.id, item.id, dependency),
        );
      }
      for (const effect of item.effects) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO plan_item_effects (plan_id, item_id, effect)
               VALUES (?, ?, ?)`,
            )
            .bind(plan.id, item.id, effect),
        );
      }
      for (const commandRef of item.verification.commandRefs ?? []) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
               VALUES (?, ?, ?)`,
            )
            .bind(plan.id, item.id, commandRef),
        );
      }
      for (const evidenceKind of item.verification.evidenceKinds) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
               VALUES (?, ?, ?)`,
            )
            .bind(plan.id, item.id, evidenceKind),
        );
      }
      for (const externalFact of item.verification.externalFacts ?? []) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO plan_item_external_facts (plan_id, item_id, external_fact)
               VALUES (?, ?, ?)`,
            )
            .bind(plan.id, item.id, externalFact),
        );
      }
    }

    await this.db.batch(statements);
    return { ...plan, status: 'validated' };
  }
}
