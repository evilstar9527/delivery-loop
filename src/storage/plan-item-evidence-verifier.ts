import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import type { EvidenceKind } from '../domain/plan.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;

const DoneWhenEvidenceSchema = z
  .object({
    position: z.number().int().nonnegative().max(49),
    evidenceIds: z
      .array(z.string().regex(IDENTIFIER_PATTERN))
      .min(1)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, 'Evidence IDs must be unique'),
  })
  .strict();

export const VerifyPlanItemInputSchema = z
  .object({
    runId: z.string().regex(IDENTIFIER_PATTERN),
    expectedRunVersion: z.number().int().nonnegative(),
    planVersion: z.number().int().positive(),
    planItemId: z.string().regex(IDENTIFIER_PATTERN),
    expectedProgressVersion: z.number().int().nonnegative(),
    attemptId: z.string().regex(IDENTIFIER_PATTERN),
    expectedAttemptVersion: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
    headSha: z.string().regex(SHA_PATTERN),
    doneWhenEvidence: z
      .array(DoneWhenEvidenceSchema)
      .min(1)
      .max(50)
      .refine(
        (entries) => new Set(entries.map((entry) => entry.position)).size === entries.length,
        'doneWhen positions must be unique',
      ),
  })
  .strict();

export const VerifyPlanItemRequestBodySchema = VerifyPlanItemInputSchema.omit({
  runId: true,
  planItemId: true,
});

export type VerifyPlanItemInput = z.infer<typeof VerifyPlanItemInputSchema>;

export type PlanItemEvidenceVerificationErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'state_conflict'
  | 'evidence_incomplete'
  | 'evidence_conflict';

export class PlanItemEvidenceVerificationError extends Error {
  constructor(readonly code: PlanItemEvidenceVerificationErrorCode) {
    super(`Plan Item Evidence verification failed: ${code}`);
    this.name = 'PlanItemEvidenceVerificationError';
  }
}

export interface PlanItemEvidenceVerificationResult {
  verificationId: string;
  created: boolean;
  runId: string;
  planId: string;
  planVersion: number;
  planItemId: string;
  attemptId: string;
  headSha: string;
  status: 'passed';
  progressVersion: number;
  evidenceSetDigest: string;
  evidenceIds: string[];
}

interface VerificationContextRow {
  run_id: string;
  run_state: string;
  run_version: number;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_status: string;
  item_id: string;
  item_required: number;
  progress_status: string;
  progress_version: number;
  active_attempt_id: string | null;
  attempt_id: string | null;
  attempt_mode: string | null;
  attempt_status: string | null;
  attempt_version: number | null;
  lease_generation: number | null;
  lease_expires_at: string | null;
  github_status: string | null;
  github_conclusion: string | null;
  head_sha: string | null;
}

interface EvidenceRow {
  evidence_id: string;
  run_id: string;
  attempt_id: string | null;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  kind: EvidenceKind;
  status: string;
  command_ref: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  sha: string | null;
  external_url: string | null;
  artifact_digest: string | null;
  verification_status: string;
  suite_status: string | null;
  suite_result_status: string | null;
}

interface DecisionRow {
  verification_id: string;
  run_id: string;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  attempt_id: string;
  head_sha: string;
  progress_version: number;
  evidence_set_digest: string;
  status: 'passed';
}

interface MappingRow {
  done_when_position: number;
  evidence_position: number;
  evidence_id: string;
}

const EXTERNAL_FACT_KIND = {
  github_pr: 'pull_request',
  github_check: 'check',
  deployment: 'deployment',
} as const;

/** The sole production path that can close a required Plan Item as passed. */
export class PlanItemEvidenceVerifier {
  constructor(private readonly db: D1Database) {}

  async verify(
    rawInput: unknown,
    now = new Date(),
  ): Promise<PlanItemEvidenceVerificationResult> {
    const parsed = VerifyPlanItemInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PlanItemEvidenceVerificationError('invalid_request');
    const input = parsed.data;
    const verificationId = await this.verificationId(input);
    const existing = await this.readDecision(verificationId);
    if (existing !== null) return await this.decisionResult(existing, input, false);

    const nowIso = now.toISOString();
    const context = await this.context(input);
    this.assertContext(context, input, nowIso);
    const [doneWhenPositions, commandRefs, evidenceKinds, externalFacts] = await Promise.all([
      this.doneWhenPositions(context.plan_id, context.item_id),
      this.itemValues('plan_item_command_refs', 'command_ref', context.plan_id, context.item_id),
      this.itemValues('plan_item_evidence_kinds', 'evidence_kind', context.plan_id, context.item_id),
      this.itemValues('plan_item_external_facts', 'external_fact', context.plan_id, context.item_id),
    ]);
    this.assertDoneWhenCoverage(doneWhenPositions, input.doneWhenEvidence);

    const evidenceIds = this.uniqueEvidenceIds(input);
    const evidence = await this.evidenceRows(evidenceIds);
    this.assertEvidenceBindings(
      context,
      input,
      evidence,
      commandRefs,
      evidenceKinds,
      externalFacts,
    );
    const evidenceSetDigest = await canonicalSha256({
      schemaVersion: '1',
      runId: input.runId,
      planId: context.plan_id,
      planVersion: input.planVersion,
      planItemId: input.planItemId,
      attemptId: input.attemptId,
      headSha: input.headSha,
      doneWhenEvidence: input.doneWhenEvidence,
      evidence: evidence.map((row) => this.evidenceDigestProjection(row)),
    });

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO plan_item_verifications (
             verification_id, run_id, plan_id, plan_version, plan_item_id,
             attempt_id, head_sha, progress_version, evidence_set_digest,
             status, created_at
           )
           SELECT ?, runs.run_id, execution_plans.plan_id, execution_plans.plan_version,
                  plan_items.item_id, attempts.attempt_id, attempts.head_sha,
                  plan_item_progress.version, ?, 'passed', ?
           FROM runs
           JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
           JOIN plan_items ON plan_items.plan_id = execution_plans.plan_id
           JOIN plan_item_progress
             ON plan_item_progress.plan_id = plan_items.plan_id
            AND plan_item_progress.item_id = plan_items.item_id
           JOIN attempts ON attempts.attempt_id = plan_item_progress.active_attempt_id
           WHERE runs.run_id = ? AND runs.version = ?
             AND runs.state IN ('executing', 'verifying')
             AND runs.active_plan_version = ?
             AND runs.active_plan_digest = execution_plans.digest
             AND execution_plans.status = 'active'
             AND plan_items.item_id = ? AND plan_items.required = 1
             AND plan_item_progress.status = 'in_progress'
             AND plan_item_progress.version = ?
             AND attempts.attempt_id = ? AND attempts.status = 'running'
             AND attempts.version = ? AND attempts.lease_generation = ?
             AND (
               attempts.lease_expires_at > ?
               OR (attempts.github_status = 'completed' AND attempts.github_conclusion = 'success')
             )
             AND attempts.head_sha = ?
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          verificationId,
          evidenceSetDigest,
          nowIso,
          input.runId,
          input.expectedRunVersion,
          input.planVersion,
          input.planItemId,
          input.expectedProgressVersion,
          input.attemptId,
          input.expectedAttemptVersion,
          input.leaseGeneration,
          nowIso,
          input.headSha,
        ),
      ...input.doneWhenEvidence.flatMap((entry) =>
        entry.evidenceIds.map((evidenceId, evidencePosition) =>
          this.db
            .prepare(
              `INSERT INTO plan_item_done_when_evidence (
                 verification_id, plan_id, item_id, done_when_position,
                 evidence_position, evidence_id
               )
               SELECT verification_id, plan_id, plan_item_id, ?, ?, ?
               FROM plan_item_verifications
               WHERE verification_id = ? AND status = 'passed'
               ON CONFLICT DO NOTHING`,
            )
            .bind(
              entry.position,
              evidencePosition,
              evidenceId,
              verificationId,
            ),
        ),
      ),
      ...evidence.map((row) =>
        this.db
          .prepare(
            `UPDATE evidence SET verification_status = 'verified'
             WHERE evidence_id = ? AND run_id = ? AND plan_id = ?
               AND plan_version = ? AND plan_item_id = ? AND kind = ?
               AND status = 'passed' AND command_ref IS ? AND exit_code IS ?
               AND duration_ms IS ? AND sha = ? AND external_url IS ?
               AND artifact_digest IS ?
               AND verification_status IN ('unverified', 'verified')
               AND EXISTS (
                 SELECT 1 FROM plan_item_verifications
                 WHERE verification_id = ? AND head_sha = evidence.sha
               )`,
          )
          .bind(
            row.evidence_id,
            input.runId,
            context.plan_id,
            input.planVersion,
            input.planItemId,
            row.kind,
            row.command_ref,
            row.exit_code,
            row.duration_ms,
            input.headSha,
            row.external_url,
            row.artifact_digest,
            verificationId,
          ),
      ),
      this.db
        .prepare(
          `UPDATE attempts
           SET status = 'completed', version = version + 1,
               lease_generation = lease_generation + 1,
               lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE attempt_id = ? AND run_id = ? AND status = 'running'
             AND version = ? AND lease_generation = ? AND head_sha = ?
             AND EXISTS (
               SELECT 1 FROM plan_item_verifications
               WHERE verification_id = ? AND attempt_id = attempts.attempt_id
             )`,
        )
        .bind(
          nowIso,
          input.attemptId,
          input.runId,
          input.expectedAttemptVersion,
          input.leaseGeneration,
          input.headSha,
          verificationId,
        ),
      this.db
        .prepare(
          `UPDATE attempt_tokens SET revoked_at = ?
           WHERE attempt_id = ? AND lease_generation = ? AND revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM attempts
               WHERE attempt_id = attempt_tokens.attempt_id
                 AND status = 'completed' AND version = ? AND lease_generation = ?
             )`,
        )
        .bind(
          nowIso,
          input.attemptId,
          input.leaseGeneration,
          input.expectedAttemptVersion + 1,
          input.leaseGeneration + 1,
        ),
      this.db
        .prepare(
          `INSERT INTO attempt_revocations (
             revocation_id, run_id, attempt_id, reason, revoked_lease_generation,
             attempt_version, occurred_at, created_at
           )
           SELECT ?, run_id, attempt_id, 'completed', ?, version, ?, ?
           FROM attempts
           WHERE attempt_id = ? AND status = 'completed' AND version = ?
             AND lease_generation = ?
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          `revoke_item_verified_${input.attemptId}_${input.leaseGeneration}`,
          input.leaseGeneration,
          nowIso,
          nowIso,
          input.attemptId,
          input.expectedAttemptVersion + 1,
          input.leaseGeneration + 1,
        ),
      this.db
        .prepare(
          `UPDATE github_write_credentials
           SET status = 'revocation_pending', updated_at = ?
           WHERE attempt_id = ? AND lease_generation = ? AND status = 'active'
             AND EXISTS (
               SELECT 1 FROM attempts
               WHERE attempt_id = github_write_credentials.attempt_id
                 AND status = 'completed'
             )`,
        )
        .bind(nowIso, input.attemptId, input.leaseGeneration),
      this.db
        .prepare(
          `UPDATE plan_item_progress
           SET status = 'passed', active_attempt_id = NULL,
               version = version + 1, updated_at = ?
           WHERE plan_id = ? AND item_id = ? AND status = 'in_progress'
             AND version = ? AND active_attempt_id = ?
             AND EXISTS (
               SELECT 1 FROM attempts
               WHERE attempt_id = plan_item_progress.active_attempt_id
                 AND status = 'completed' AND version = ? AND lease_generation = ?
             )`,
        )
        .bind(
          nowIso,
          context.plan_id,
          input.planItemId,
          input.expectedProgressVersion,
          input.attemptId,
          input.expectedAttemptVersion + 1,
          input.leaseGeneration + 1,
        ),
    ];
    const results = await this.db.batch(statements);
    const decision = await this.readDecision(verificationId);
    if (decision === null) throw new PlanItemEvidenceVerificationError('state_conflict');
    return await this.decisionResult(
      decision,
      input,
      results[0]?.meta.changes === 1,
    );
  }

  private async context(input: VerifyPlanItemInput): Promise<VerificationContextRow | null> {
    return await this.db
      .prepare(
        `SELECT runs.run_id, runs.state AS run_state, runs.version AS run_version,
                runs.active_plan_id, runs.active_plan_version, runs.active_plan_digest,
                execution_plans.plan_id, execution_plans.plan_version,
                execution_plans.digest AS plan_digest, execution_plans.status AS plan_status,
                plan_items.item_id, plan_items.required AS item_required,
                plan_item_progress.status AS progress_status,
                plan_item_progress.version AS progress_version,
                plan_item_progress.active_attempt_id,
                attempts.attempt_id, attempts.mode AS attempt_mode,
                attempts.status AS attempt_status, attempts.version AS attempt_version,
                attempts.lease_generation, attempts.lease_expires_at,
                attempts.github_status, attempts.github_conclusion, attempts.head_sha
         FROM runs
         JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
         JOIN plan_items ON plan_items.plan_id = execution_plans.plan_id
         JOIN plan_item_progress
           ON plan_item_progress.plan_id = plan_items.plan_id
          AND plan_item_progress.item_id = plan_items.item_id
         LEFT JOIN attempts ON attempts.attempt_id = plan_item_progress.active_attempt_id
         WHERE runs.run_id = ? AND execution_plans.plan_version = ?
           AND plan_items.item_id = ?`,
      )
      .bind(input.runId, input.planVersion, input.planItemId)
      .first<VerificationContextRow>();
  }

  private assertContext(
    context: VerificationContextRow | null,
    input: VerifyPlanItemInput,
    nowIso: string,
  ): asserts context is VerificationContextRow {
    if (context === null) throw new PlanItemEvidenceVerificationError('not_found');
    if (
      (context.run_state !== 'executing' && context.run_state !== 'verifying') ||
      context.run_version !== input.expectedRunVersion ||
      context.active_plan_id !== context.plan_id ||
      context.active_plan_version !== input.planVersion ||
      context.active_plan_digest !== context.plan_digest ||
      context.plan_status !== 'active' ||
      context.item_required !== 1 ||
      context.progress_status !== 'in_progress' ||
      context.progress_version !== input.expectedProgressVersion ||
      context.active_attempt_id !== input.attemptId ||
      context.attempt_id !== input.attemptId ||
      !['implement', 'review_fix', 'deploy'].includes(context.attempt_mode ?? '') ||
      context.attempt_status !== 'running' ||
      context.attempt_version !== input.expectedAttemptVersion ||
      context.lease_generation !== input.leaseGeneration ||
      (
        (context.lease_expires_at ?? '') <= nowIso &&
        (context.github_status !== 'completed' || context.github_conclusion !== 'success')
      ) ||
      context.head_sha !== input.headSha
    ) {
      throw new PlanItemEvidenceVerificationError('state_conflict');
    }
  }

  private async doneWhenPositions(planId: string, itemId: string): Promise<number[]> {
    const rows = await this.db
      .prepare(
        `SELECT position FROM plan_item_done_when
         WHERE plan_id = ? AND item_id = ? ORDER BY position`,
      )
      .bind(planId, itemId)
      .all<{ position: number }>();
    return rows.results.map((row) => row.position);
  }

  private async itemValues(
    table: string,
    column: string,
    planId: string,
    itemId: string,
  ): Promise<string[]> {
    const allowed = new Map([
      ['plan_item_command_refs', 'command_ref'],
      ['plan_item_evidence_kinds', 'evidence_kind'],
      ['plan_item_external_facts', 'external_fact'],
    ]);
    if (allowed.get(table) !== column) throw new Error('invalid Plan Item value query');
    const rows = await this.db
      .prepare(`SELECT ${column} AS value FROM ${table} WHERE plan_id = ? AND item_id = ? ORDER BY ${column}`)
      .bind(planId, itemId)
      .all<{ value: string }>();
    return rows.results.map((row) => row.value);
  }

  private assertDoneWhenCoverage(
    positions: readonly number[],
    assignments: VerifyPlanItemInput['doneWhenEvidence'],
  ): void {
    if (
      positions.length === 0 ||
      positions.length !== assignments.length ||
      positions.some((position, index) => position !== assignments[index]?.position)
    ) {
      throw new PlanItemEvidenceVerificationError('evidence_incomplete');
    }
  }

  private uniqueEvidenceIds(input: VerifyPlanItemInput): string[] {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const assignment of input.doneWhenEvidence) {
      for (const evidenceId of assignment.evidenceIds) {
        if (!seen.has(evidenceId)) {
          seen.add(evidenceId);
          ids.push(evidenceId);
        }
      }
    }
    return ids;
  }

  private async evidenceRows(evidenceIds: readonly string[]): Promise<EvidenceRow[]> {
    const placeholders = evidenceIds.map(() => '?').join(', ');
    const rows = await this.db
      .prepare(
        `SELECT evidence.evidence_id, evidence.run_id, evidence.attempt_id,
                evidence.plan_id, evidence.plan_version, evidence.plan_item_id,
                evidence.kind, evidence.status, evidence.command_ref,
                evidence.exit_code, evidence.duration_ms, evidence.sha,
                evidence.external_url, evidence.artifact_digest,
                evidence.verification_status,
                verification_suites.status AS suite_status,
                verification_suite_commands.result_status AS suite_result_status
         FROM evidence
         LEFT JOIN verification_suite_commands
           ON verification_suite_commands.evidence_id = evidence.evidence_id
         LEFT JOIN verification_suites
           ON verification_suites.suite_id = verification_suite_commands.suite_id
         WHERE evidence.evidence_id IN (${placeholders})`,
      )
      .bind(...evidenceIds)
      .all<EvidenceRow>();
    if (rows.results.length !== evidenceIds.length) {
      throw new PlanItemEvidenceVerificationError('evidence_conflict');
    }
    const byId = new Map(rows.results.map((row) => [row.evidence_id, row]));
    return evidenceIds.map((id) => byId.get(id)!).filter(Boolean);
  }

  private assertEvidenceBindings(
    context: VerificationContextRow,
    input: VerifyPlanItemInput,
    evidence: readonly EvidenceRow[],
    commandRefs: readonly string[],
    evidenceKinds: readonly string[],
    externalFacts: readonly string[],
  ): void {
    const byId = new Map(evidence.map((row) => [row.evidence_id, row]));
    for (const row of evidence) {
      if (
        row.run_id !== input.runId ||
        row.attempt_id !== input.attemptId ||
        row.plan_id !== context.plan_id ||
        row.plan_version !== input.planVersion ||
        row.plan_item_id !== input.planItemId ||
        row.sha !== input.headSha ||
        row.status !== 'passed' ||
        (row.verification_status !== 'unverified' && row.verification_status !== 'verified') ||
        (
          row.command_ref !== null &&
          (row.exit_code !== 0 || row.duration_ms === null)
        ) ||
        (
          row.command_ref !== null &&
          /^(?:test|verify):/.test(row.command_ref) &&
          (row.suite_status !== 'completed' || row.suite_result_status !== 'passed')
        )
      ) {
        throw new PlanItemEvidenceVerificationError('evidence_conflict');
      }
    }
    for (const assignment of input.doneWhenEvidence) {
      const assigned = assignment.evidenceIds.map((id) => byId.get(id)!);
      const kinds = new Set(assigned.map((row) => row.kind));
      const commands = new Set(assigned.map((row) => row.command_ref).filter(Boolean));
      if (
        evidenceKinds.some((kind) => !kinds.has(kind as EvidenceKind)) ||
        commandRefs.some((commandRef) => !commands.has(commandRef)) ||
        externalFacts.some((fact) =>
          !kinds.has(EXTERNAL_FACT_KIND[fact as keyof typeof EXTERNAL_FACT_KIND]))
      ) {
        throw new PlanItemEvidenceVerificationError('evidence_incomplete');
      }
    }
  }

  private evidenceDigestProjection(row: EvidenceRow): Record<string, unknown> {
    return {
      evidenceId: row.evidence_id,
      runId: row.run_id,
      planId: row.plan_id,
      planVersion: row.plan_version,
      planItemId: row.plan_item_id,
      kind: row.kind,
      status: row.status,
      commandRef: row.command_ref,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      sha: row.sha,
      externalUrl: row.external_url,
      artifactDigest: row.artifact_digest,
    };
  }

  private async verificationId(input: VerifyPlanItemInput): Promise<string> {
    const digest = await canonicalSha256({
      runId: input.runId,
      planVersion: input.planVersion,
      planItemId: input.planItemId,
      attemptId: input.attemptId,
      headSha: input.headSha,
      progressVersion: input.expectedProgressVersion,
    });
    return `item_verification_${digest.slice('sha256:'.length, 'sha256:'.length + 40)}`;
  }

  private async readDecision(verificationId: string): Promise<DecisionRow | null> {
    return await this.db
      .prepare('SELECT * FROM plan_item_verifications WHERE verification_id = ?')
      .bind(verificationId)
      .first<DecisionRow>();
  }

  private async mappings(verificationId: string): Promise<MappingRow[]> {
    return (await this.db
      .prepare(
        `SELECT done_when_position, evidence_position, evidence_id
         FROM plan_item_done_when_evidence
         WHERE verification_id = ? ORDER BY done_when_position, evidence_position`,
      )
      .bind(verificationId)
      .all<MappingRow>()).results;
  }

  private async decisionResult(
    row: DecisionRow,
    input: VerifyPlanItemInput,
    created: boolean,
  ): Promise<PlanItemEvidenceVerificationResult> {
    const mappings = await this.mappings(row.verification_id);
    const expectedMappings = input.doneWhenEvidence.flatMap((entry) =>
      entry.evidenceIds.map((evidenceId, evidencePosition) => ({
        done_when_position: entry.position,
        evidence_position: evidencePosition,
        evidence_id: evidenceId,
      })),
    );
    if (
      row.run_id !== input.runId ||
      row.plan_version !== input.planVersion ||
      row.plan_item_id !== input.planItemId ||
      row.attempt_id !== input.attemptId ||
      row.head_sha !== input.headSha ||
      row.progress_version !== input.expectedProgressVersion ||
      mappings.length !== expectedMappings.length ||
      mappings.some((mapping, index) =>
        mapping.done_when_position !== expectedMappings[index]?.done_when_position ||
        mapping.evidence_position !== expectedMappings[index]?.evidence_position ||
        mapping.evidence_id !== expectedMappings[index]?.evidence_id)
    ) {
      throw new PlanItemEvidenceVerificationError('evidence_conflict');
    }
    const progress = await this.db
      .prepare(
        `SELECT status, version FROM plan_item_progress
         WHERE plan_id = ? AND item_id = ?`,
      )
      .bind(row.plan_id, row.plan_item_id)
      .first<{ status: string; version: number }>();
    if (progress?.status !== 'passed' || progress.version !== row.progress_version + 1) {
      throw new PlanItemEvidenceVerificationError('state_conflict');
    }
    return {
      verificationId: row.verification_id,
      created,
      runId: row.run_id,
      planId: row.plan_id,
      planVersion: row.plan_version,
      planItemId: row.plan_item_id,
      attemptId: row.attempt_id,
      headSha: row.head_sha,
      status: 'passed',
      progressVersion: progress.version,
      evidenceSetDigest: row.evidence_set_digest,
      evidenceIds: this.uniqueEvidenceIds(input),
    };
  }
}
