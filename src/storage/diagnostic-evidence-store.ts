import { canonicalSha256 } from '../domain/digest.js';
import {
  DiagnosticEvidenceV1Schema,
  computeDiagnosticEvidenceDigest,
  computeDiagnosticRootCauseDigest,
  type DiagnosticEvidenceV1,
} from '../domain/diagnostic-evidence.js';
import { SecretScanner } from '../security/redaction.js';
import type { RunnerAuthorization } from './runner-attempt-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;

export type DiagnosticEvidenceErrorCode =
  | 'invalid_request'
  | 'secret_detected'
  | 'state_conflict'
  | 'source_trace_conflict'
  | 'evidence_conflict';

export class DiagnosticEvidenceError extends Error {
  constructor(readonly code: DiagnosticEvidenceErrorCode) {
    super(`diagnostic Evidence operation failed: ${code}`);
    this.name = 'DiagnosticEvidenceError';
  }
}

export interface DiagnosticEvidenceCreateResult {
  evidenceId: string;
  evidenceRef: string;
  evidenceDigest: string;
  rootCauseDigest: string;
  created: boolean;
}

interface DiagnosticContextRow {
  attempt_id: string;
  run_id: string;
  mode: string;
  status: string;
  version: number;
  lease_generation: number;
  lease_expires_at: string | null;
  run_state: string;
  intent_kind: string;
}

interface ToolTraceRow {
  trace_id: string;
  run_id: string;
  attempt_id: string;
  tool_path: string;
  action: string;
  effect: string;
  result_category: string;
  occurred_at: string;
}

interface ExistingEvidenceRow {
  evidence_id: string;
  run_id: string;
  attempt_id: string;
  kind: string;
  status: string;
  verification_status: string;
  artifact_digest: string | null;
  locator_kinds_json: string;
  locator_digest: string;
  root_cause_digest: string;
  evidence_digest: string;
}

export interface DiagnosticEvidenceProjection {
  schemaVersion: '1';
  runId: string;
  task: {
    id: string;
    intentKind: 'bug';
    revision: string;
    digest: string;
    repository: string;
  };
  plan: {
    id: string;
    version: number;
    digest: string;
    status: string;
    diagnosticEvidenceRefs: string[];
  };
  evidence: Array<{
    evidenceId: string;
    evidenceRef: string;
    attemptId: string;
    locatorKinds: Array<'uid' | 'cid' | 'path'>;
    locatorDigest: string;
    rootCauseDigest: string;
    evidenceDigest: string;
    observedAt: string;
    sourceTraces: Array<{
      traceId: string;
      toolPath: 'logs/search' | 'traces/get';
      action: 'logs:read' | 'trace:read';
      effect: 'read';
      resultCategory: 'success';
      occurredAt: string;
    }>;
  }>;
}

interface ProjectionRow {
  task_id: string;
  task_revision: string;
  task_digest: string;
  target_repository: string;
  intent_kind: string;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  plan_status: string | null;
}

interface ProjectionEvidenceRow {
  evidence_id: string;
  attempt_id: string;
  locator_kinds_json: string;
  locator_digest: string;
  root_cause_digest: string;
  evidence_digest: string;
  observed_at: string;
  position: number;
  trace_id: string;
  tool_path: string;
  action: string;
  effect: string;
  result_category: string;
  occurred_at: string;
}

function placeholders(values: readonly string[]): string {
  return values.map(() => '?').join(', ');
}

/** Creates one immutable, sanitized root-cause Evidence from successful read-only calls. */
export class DiagnosticEvidenceStore {
  constructor(private readonly db: D1Database) {}

  async create(
    authorization: RunnerAuthorization,
    rawInput: unknown,
    now = new Date(),
    secrets: readonly string[] = [],
  ): Promise<DiagnosticEvidenceCreateResult> {
    const parsed = DiagnosticEvidenceV1Schema.safeParse(rawInput);
    if (!parsed.success || !Number.isFinite(now.getTime())) {
      throw new DiagnosticEvidenceError('invalid_request');
    }
    const input = parsed.data;
    if (new SecretScanner({ secrets }).scan(input).length > 0) {
      throw new DiagnosticEvidenceError('secret_detected');
    }
    const nowIso = now.toISOString();
    const context = await this.context(authorization);
    if (
      context.mode !== 'analysis' || context.status !== 'running' ||
      context.version !== authorization.version ||
      context.lease_generation !== authorization.leaseGeneration ||
      context.lease_expires_at === null || context.lease_expires_at <= nowIso ||
      context.run_state !== 'planning' || context.intent_kind !== 'bug'
    ) throw new DiagnosticEvidenceError('state_conflict');

    const traces = await this.traces(input.sourceTraceIds);
    this.assertTraceSources(authorization, input, traces);
    const evidenceDigest = await computeDiagnosticEvidenceDigest(input);
    const rootCauseDigest = await computeDiagnosticRootCauseDigest(input.rootCause);
    const identityDigest = await canonicalSha256({
      attemptId: authorization.attemptId,
      evidenceDigest,
    });
    const evidenceId = `diagnostic_${identityDigest.slice('sha256:'.length, 63)}`;
    const existing = await this.existing(evidenceId);
    if (existing !== null) {
      await this.assertExisting(existing, authorization, input, evidenceDigest, rootCauseDigest);
      return this.result(evidenceId, evidenceDigest, rootCauseDigest, false);
    }

    const statements: D1PreparedStatement[] = [
      this.db.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, artifact_digest, summary, verification_status,
           observed_at, created_at
         )
         SELECT ?, attempts.run_id, attempts.attempt_id, NULL, NULL, NULL,
                'diagnostic', 'passed', ?, ?, 'verified', ?, ?
         FROM attempts JOIN runs ON runs.run_id = attempts.run_id
         JOIN tasks ON tasks.task_id = runs.task_id
         WHERE attempts.attempt_id = ? AND attempts.run_id = ?
           AND attempts.mode = 'analysis' AND attempts.status = 'running'
           AND attempts.version = ? AND attempts.lease_generation = ?
           AND attempts.lease_expires_at > ? AND runs.state = 'planning'
           AND tasks.intent_kind = 'bug'
         ON CONFLICT DO NOTHING`,
      ).bind(
        evidenceId,
        evidenceDigest,
        input.rootCause.summary,
        nowIso,
        nowIso,
        authorization.attemptId,
        authorization.runId,
        authorization.version,
        authorization.leaseGeneration,
        nowIso,
      ),
      this.db.prepare(
        `INSERT INTO diagnostic_evidence_bindings (
           evidence_id, run_id, attempt_id, locator_kinds_json, locator_digest,
           root_cause_digest, evidence_digest, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM evidence WHERE evidence_id = ? AND run_id = ? AND attempt_id = ?
         )
         ON CONFLICT DO NOTHING`,
      ).bind(
        evidenceId,
        authorization.runId,
        authorization.attemptId,
        JSON.stringify(input.locatorKinds),
        input.locatorDigest,
        rootCauseDigest,
        evidenceDigest,
        nowIso,
        evidenceId,
        authorization.runId,
        authorization.attemptId,
      ),
      ...input.sourceTraceIds.map((traceId, position) => this.db.prepare(
        `INSERT INTO diagnostic_evidence_trace_sources (evidence_id, position, trace_id)
         SELECT ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM diagnostic_evidence_bindings WHERE evidence_id = ?
         ) ON CONFLICT DO NOTHING`,
      ).bind(evidenceId, position, traceId, evidenceId)),
    ];
    const results = await this.db.batch(statements);
    const persisted = await this.existing(evidenceId);
    if (persisted === null) throw new DiagnosticEvidenceError('state_conflict');
    await this.assertExisting(persisted, authorization, input, evidenceDigest, rootCauseDigest);
    return this.result(
      evidenceId,
      evidenceDigest,
      rootCauseDigest,
      results[0]?.meta.changes === 1,
    );
  }

  private async context(authorization: RunnerAuthorization): Promise<DiagnosticContextRow> {
    const row = await this.db.prepare(
      `SELECT attempts.attempt_id, attempts.run_id, attempts.mode, attempts.status,
              attempts.version, attempts.lease_generation, attempts.lease_expires_at,
              runs.state AS run_state, tasks.intent_kind
       FROM attempts JOIN runs ON runs.run_id = attempts.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       WHERE attempts.attempt_id = ? AND attempts.run_id = ?`,
    ).bind(authorization.attemptId, authorization.runId).first<DiagnosticContextRow>();
    if (row === null) throw new DiagnosticEvidenceError('state_conflict');
    return row;
  }

  private async traces(traceIds: string[]): Promise<ToolTraceRow[]> {
    const result = await this.db.prepare(
      `SELECT trace_id, run_id, attempt_id, tool_path, action, effect,
              result_category, occurred_at
       FROM tool_call_traces WHERE trace_id IN (${placeholders(traceIds)})
       ORDER BY trace_id`,
    ).bind(...traceIds).all<ToolTraceRow>();
    return result.results;
  }

  private assertTraceSources(
    authorization: RunnerAuthorization,
    input: DiagnosticEvidenceV1,
    traces: ToolTraceRow[],
  ): void {
    const expected = [...input.sourceTraceIds].sort();
    if (
      traces.length !== expected.length ||
      traces.some((trace, index) => trace.trace_id !== expected[index]) ||
      traces.some((trace) =>
        trace.run_id !== authorization.runId || trace.attempt_id !== authorization.attemptId ||
        trace.effect !== 'read' || trace.result_category !== 'success' ||
        !['logs/search', 'traces/get'].includes(trace.tool_path)) ||
      !traces.some((trace) => trace.tool_path === 'logs/search' && trace.action === 'logs:read') ||
      !traces.some((trace) => trace.tool_path === 'traces/get' && trace.action === 'trace:read')
    ) throw new DiagnosticEvidenceError('source_trace_conflict');
  }

  private async existing(evidenceId: string): Promise<ExistingEvidenceRow | null> {
    return await this.db.prepare(
      `SELECT evidence.evidence_id, evidence.run_id, evidence.attempt_id,
              evidence.kind, evidence.status, evidence.verification_status,
              evidence.artifact_digest, binding.locator_kinds_json,
              binding.locator_digest, binding.root_cause_digest, binding.evidence_digest
       FROM evidence JOIN diagnostic_evidence_bindings AS binding
         ON binding.evidence_id = evidence.evidence_id
       WHERE evidence.evidence_id = ?`,
    ).bind(evidenceId).first<ExistingEvidenceRow>();
  }

  private async assertExisting(
    existing: ExistingEvidenceRow,
    authorization: RunnerAuthorization,
    input: DiagnosticEvidenceV1,
    evidenceDigest: string,
    rootCauseDigest: string,
  ): Promise<void> {
    const sourceResult = await this.db.prepare(
      `SELECT trace_id FROM diagnostic_evidence_trace_sources
       WHERE evidence_id = ? ORDER BY position`,
    ).bind(existing.evidence_id).all<{ trace_id: string }>();
    if (
      existing.run_id !== authorization.runId ||
      existing.attempt_id !== authorization.attemptId ||
      existing.kind !== 'diagnostic' || existing.status !== 'passed' ||
      existing.verification_status !== 'verified' ||
      existing.artifact_digest !== evidenceDigest || existing.evidence_digest !== evidenceDigest ||
      existing.root_cause_digest !== rootCauseDigest ||
      existing.locator_digest !== input.locatorDigest ||
      existing.locator_kinds_json !== JSON.stringify(input.locatorKinds) ||
      sourceResult.results.length !== input.sourceTraceIds.length ||
      sourceResult.results.some((row, index) => row.trace_id !== input.sourceTraceIds[index])
    ) throw new DiagnosticEvidenceError('evidence_conflict');
  }

  private result(
    evidenceId: string,
    evidenceDigest: string,
    rootCauseDigest: string,
    created: boolean,
  ): DiagnosticEvidenceCreateResult {
    return {
      evidenceId,
      evidenceRef: `d1://evidence/${evidenceId}`,
      evidenceDigest,
      rootCauseDigest,
      created,
    };
  }
}

/** Operations-only, summary-free projection used by E2E-2 and incident audit. */
export class DiagnosticEvidenceQueryStore {
  constructor(private readonly db: D1Database) {}

  async get(runId: string): Promise<DiagnosticEvidenceProjection | null> {
    if (!ID_PATTERN.test(runId)) throw new DiagnosticEvidenceError('invalid_request');
    const subject = await this.db.prepare(
      `SELECT tasks.task_id, tasks.task_revision, tasks.task_digest,
              tasks.target_repository, tasks.intent_kind,
              runs.active_plan_id, runs.active_plan_version, runs.active_plan_digest,
              plans.status AS plan_status
       FROM runs JOIN tasks ON tasks.task_id = runs.task_id
       LEFT JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       WHERE runs.run_id = ?`,
    ).bind(runId).first<ProjectionRow>();
    if (subject === null) return null;
    if (
      subject.intent_kind !== 'bug' || subject.active_plan_id === null ||
      subject.active_plan_version === null || subject.active_plan_digest === null ||
      subject.plan_status === null
    ) throw new DiagnosticEvidenceError('evidence_conflict');
    const sourceResult = await this.db.prepare(
      `SELECT binding.evidence_id, binding.attempt_id, binding.locator_kinds_json,
              binding.locator_digest, binding.root_cause_digest, binding.evidence_digest,
              evidence.observed_at, sources.position, traces.trace_id, traces.tool_path,
              traces.action, traces.effect, traces.result_category, traces.occurred_at
       FROM diagnostic_evidence_bindings AS binding
       JOIN evidence ON evidence.evidence_id = binding.evidence_id
       JOIN diagnostic_evidence_trace_sources AS sources
         ON sources.evidence_id = binding.evidence_id
       JOIN tool_call_traces AS traces ON traces.trace_id = sources.trace_id
       WHERE binding.run_id = ?
       ORDER BY evidence.observed_at, binding.evidence_id, sources.position LIMIT 501`,
    ).bind(runId).all<ProjectionEvidenceRow>();
    if (sourceResult.results.length > 500) throw new DiagnosticEvidenceError('evidence_conflict');
    const refResult = await this.db.prepare(
      `SELECT refs.evidence_ref
       FROM execution_plan_evidence_refs AS refs
       JOIN diagnostic_evidence_bindings AS binding
         ON refs.evidence_ref = 'd1://evidence/' || binding.evidence_id
       WHERE refs.plan_id = ? ORDER BY refs.position LIMIT 201`,
    ).bind(subject.active_plan_id).all<{ evidence_ref: string }>();
    if (refResult.results.length > 200) throw new DiagnosticEvidenceError('evidence_conflict');

    const grouped = new Map<string, DiagnosticEvidenceProjection['evidence'][number]>();
    for (const row of sourceResult.results) {
      let locatorKinds: unknown;
      try { locatorKinds = JSON.parse(row.locator_kinds_json) as unknown; }
      catch { throw new DiagnosticEvidenceError('evidence_conflict'); }
      const parsedKinds = DiagnosticEvidenceV1Schema.shape.locatorKinds.safeParse(locatorKinds);
      if (
        !parsedKinds.success || !['logs/search', 'traces/get'].includes(row.tool_path) ||
        !['logs:read', 'trace:read'].includes(row.action) || row.effect !== 'read' ||
        row.result_category !== 'success'
      ) throw new DiagnosticEvidenceError('evidence_conflict');
      const current = grouped.get(row.evidence_id) ?? {
        evidenceId: row.evidence_id,
        evidenceRef: `d1://evidence/${row.evidence_id}`,
        attemptId: row.attempt_id,
        locatorKinds: parsedKinds.data,
        locatorDigest: row.locator_digest,
        rootCauseDigest: row.root_cause_digest,
        evidenceDigest: row.evidence_digest,
        observedAt: row.observed_at,
        sourceTraces: [],
      };
      if (
        current.attemptId !== row.attempt_id ||
        current.locatorDigest !== row.locator_digest ||
        current.rootCauseDigest !== row.root_cause_digest ||
        current.evidenceDigest !== row.evidence_digest ||
        row.position !== current.sourceTraces.length
      ) throw new DiagnosticEvidenceError('evidence_conflict');
      current.sourceTraces.push({
        traceId: row.trace_id,
        toolPath: row.tool_path as 'logs/search' | 'traces/get',
        action: row.action as 'logs:read' | 'trace:read',
        effect: 'read',
        resultCategory: 'success',
        occurredAt: row.occurred_at,
      });
      grouped.set(row.evidence_id, current);
    }
    for (const item of grouped.values()) {
      if (
        !item.sourceTraces.some((trace) => trace.toolPath === 'logs/search') ||
        !item.sourceTraces.some((trace) => trace.toolPath === 'traces/get')
      ) throw new DiagnosticEvidenceError('evidence_conflict');
    }
    const refs = refResult.results.map((row) => row.evidence_ref);
    if (refs.some((ref) => !grouped.has(ref.slice('d1://evidence/'.length)))) {
      throw new DiagnosticEvidenceError('evidence_conflict');
    }
    return {
      schemaVersion: '1',
      runId,
      task: {
        id: subject.task_id,
        intentKind: 'bug',
        revision: subject.task_revision,
        digest: subject.task_digest,
        repository: subject.target_repository,
      },
      plan: {
        id: subject.active_plan_id,
        version: subject.active_plan_version,
        digest: subject.active_plan_digest,
        status: subject.plan_status,
        diagnosticEvidenceRefs: refs,
      },
      evidence: [...grouped.values()],
    };
  }
}
