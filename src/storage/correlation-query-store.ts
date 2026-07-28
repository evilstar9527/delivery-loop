import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const RESULT_LIMIT = 200;

export const CORRELATION_LOOKUP_KINDS = [
  'task',
  'run',
  'attempt',
  'trace',
  'github_run',
  'github_pr',
  'test_deployment',
  'production_deployment',
  'github_deployment',
  'test_acceptance',
  'test_rollback',
] as const;

export type CorrelationLookupKind = typeof CORRELATION_LOOKUP_KINDS[number];

export const CorrelationLookupSchema = z.object({
  kind: z.enum(CORRELATION_LOOKUP_KINDS),
  id: z.string().min(1).max(256),
  repository: z.string().regex(REPOSITORY_PATTERN).optional(),
}).strict().superRefine((lookup, context) => {
  const scoped = lookup.kind === 'github_pr' || lookup.kind === 'github_deployment';
  if (scoped !== (lookup.repository !== undefined)) {
    context.addIssue({ code: 'custom', message: 'correlation scope is invalid' });
  }
  const pattern = lookup.kind.startsWith('github_') ? GITHUB_ID_PATTERN : ID_PATTERN;
  if (!pattern.test(lookup.id)) {
    context.addIssue({ code: 'custom', message: 'correlation identifier is invalid' });
  }
});

export type CorrelationLookup = z.infer<typeof CorrelationLookupSchema>;

export interface CorrelationView {
  schemaVersion: '1';
  correlationId: string;
  matchedBy: CorrelationLookup;
  task: { id: string };
  run: { id: string; state: string; version: number };
  attempts: Array<Record<string, unknown>>;
  githubRuns: Array<Record<string, unknown>>;
  pullRequests: Array<Record<string, unknown>>;
  deployments: Array<Record<string, unknown>>;
  traces: Array<Record<string, unknown>>;
  truncated: {
    attempts: boolean;
    githubRuns: boolean;
    pullRequests: boolean;
    deployments: boolean;
    traces: boolean;
  };
}

interface LinkRow {
  correlation_id: string;
  task_id: string;
}

interface RunRow {
  run_id: string;
  task_id: string;
  state: string;
  version: number;
}

function safeUrl(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function optional(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) target[key] = value;
}

function bounded<T>(values: T[]): { values: T[]; truncated: boolean } {
  return { values: values.slice(0, RESULT_LIMIT), truncated: values.length > RESULT_LIMIT };
}

/** Read-only correlation projection rooted in authoritative D1 fact views. */
export class CorrelationQueryStore {
  constructor(private readonly db: D1Database) {}

  async resolve(rawLookup: unknown): Promise<CorrelationView | null> {
    const lookup = CorrelationLookupSchema.parse(rawLookup);
    const linkRows = await Promise.all(this.linkViews(lookup.kind).map(async (view) =>
      await this.db.prepare(
        `SELECT DISTINCT correlation_id, task_id FROM ${view}
         WHERE identifier_kind = ? AND identifier_scope = ? AND identifier_value = ?`,
      ).bind(lookup.kind, lookup.repository ?? '', lookup.id).all<LinkRow>()
    ));
    const unique = new Map(
      linkRows.flatMap((rows) => rows.results)
        .map((row) => [`${row.correlation_id}\0${row.task_id}`, row]),
    );
    if (unique.size === 0) return null;
    if (unique.size !== 1) throw new Error('correlation identifier is ambiguous');
    const link = [...unique.values()][0]!;
    const run = await this.db.prepare(
      `SELECT run_id, task_id, state, version FROM runs
       WHERE run_id = ? AND task_id = ?`,
    ).bind(link.correlation_id, link.task_id).first<RunRow>();
    if (run === null) throw new Error('correlation projection is invalid');

    const [attemptRows, traceRows, pullRequestRows, testDeploymentRows,
      productionDeploymentRows, acceptanceRows, rollbackRows,
      testDeploymentRunRows, productionDeploymentRunRows] = await Promise.all([
      this.db.prepare(
        `SELECT attempt_id, mode, status, github_run_id, github_status,
                github_conclusion, created_at, updated_at
         FROM attempts WHERE run_id = ? ORDER BY ordinal, attempt_id LIMIT ?`,
      ).bind(run.run_id, RESULT_LIMIT + 1).all<Record<string, unknown>>(),
      this.db.prepare(
        `SELECT trace_id, attempt_id, tool_path, action, effect, duration_ms,
                result_category, occurred_at
         FROM tool_call_traces WHERE run_id = ?
         ORDER BY occurred_at, trace_id LIMIT ?`,
      ).bind(run.run_id, RESULT_LIMIT + 1).all<Record<string, unknown>>(),
      this.db.prepare(
        `SELECT publication_id, status, github_pr_number, github_pr_url, evidence_id,
                created_at, updated_at
         FROM pull_request_publications WHERE run_id = ?
         ORDER BY created_at, publication_id LIMIT ?`,
      ).bind(run.run_id, RESULT_LIMIT + 1).all<Record<string, unknown>>(),
      this.db.prepare(
        `SELECT deployment_id, status, ref_sha, github_deployment_id,
                external_url, evidence_id, created_at, updated_at
         FROM test_deployments WHERE run_id = ?
         ORDER BY created_at, deployment_id LIMIT ?`,
      ).bind(run.run_id, RESULT_LIMIT + 1).all<Record<string, unknown>>(),
      this.db.prepare(
        `SELECT deployment_id, status, merge_sha, github_deployment_id,
                external_url, evidence_id, created_at, updated_at
         FROM production_deployments WHERE run_id = ?
         ORDER BY created_at, deployment_id LIMIT ?`,
      ).bind(run.run_id, RESULT_LIMIT + 1).all<Record<string, unknown>>(),
      this.db.prepare(
        `SELECT acceptance_id, attempt_id, status, github_run_id,
                external_state, external_conclusion, evidence_id, created_at, updated_at
         FROM test_acceptances WHERE run_id = ?
         ORDER BY created_at, acceptance_id LIMIT ?`,
      ).bind(run.run_id, RESULT_LIMIT + 1).all<Record<string, unknown>>(),
      this.db.prepare(
        `SELECT rollback_id, attempt_id, status, github_run_id,
                external_state, external_conclusion, evidence_id, created_at, updated_at
         FROM test_rollbacks WHERE run_id = ?
         ORDER BY created_at, rollback_id LIMIT ?`,
      ).bind(run.run_id, RESULT_LIMIT + 1).all<Record<string, unknown>>(),
      this.db.prepare(
        `SELECT attestations.github_run_id, deployments.deployment_id,
                attestations.created_at
         FROM test_deployment_oidc_attestations AS attestations
         JOIN test_deployments AS deployments
           ON deployments.deployment_id = attestations.deployment_id
         WHERE deployments.run_id = ? ORDER BY attestations.created_at LIMIT ?`,
      ).bind(run.run_id, RESULT_LIMIT + 1).all<Record<string, unknown>>(),
      this.db.prepare(
        `SELECT attestations.github_run_id, deployments.deployment_id,
                attestations.created_at
         FROM production_deployment_oidc_attestations AS attestations
         JOIN production_deployments AS deployments
           ON deployments.deployment_id = attestations.deployment_id
         WHERE deployments.run_id = ? ORDER BY attestations.created_at LIMIT ?`,
      ).bind(run.run_id, RESULT_LIMIT + 1).all<Record<string, unknown>>(),
    ]);

    const attempts = bounded(attemptRows.results.map((row) => {
      const value: Record<string, unknown> = {
        id: row.attempt_id,
        mode: row.mode,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      optional(value, 'githubRunId', row.github_run_id);
      optional(value, 'githubStatus', row.github_status);
      optional(value, 'githubConclusion', row.github_conclusion);
      return value;
    }));
    const traces = bounded(traceRows.results.map((row) => ({
      id: row.trace_id,
      attemptId: row.attempt_id,
      toolPath: row.tool_path,
      action: row.action,
      effect: row.effect,
      durationMs: row.duration_ms,
      resultCategory: row.result_category,
      occurredAt: row.occurred_at,
    })));
    const pullRequests = bounded(pullRequestRows.results.map((row) => {
      const value: Record<string, unknown> = {
        publicationId: row.publication_id,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      optional(value, 'number', row.github_pr_number);
      optional(value, 'url', safeUrl(row.github_pr_url as string | null));
      optional(value, 'evidenceId', row.evidence_id);
      return value;
    }));
    const testDeployments = testDeploymentRows.results.map((row) => {
      const value: Record<string, unknown> = {
        kind: 'test',
        id: row.deployment_id,
        status: row.status,
        sha: row.ref_sha,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      optional(value, 'githubDeploymentId', row.github_deployment_id);
      optional(value, 'url', safeUrl(row.external_url as string | null));
      optional(value, 'evidenceId', row.evidence_id);
      return value;
    });
    const productionDeployments = productionDeploymentRows.results.map((row) => {
      const value: Record<string, unknown> = {
        kind: 'production',
        id: row.deployment_id,
        status: row.status,
        sha: row.merge_sha,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      optional(value, 'githubDeploymentId', row.github_deployment_id);
      optional(value, 'url', safeUrl(row.external_url as string | null));
      optional(value, 'evidenceId', row.evidence_id);
      return value;
    });
    const deployments = bounded([...testDeployments, ...productionDeployments]);

    const githubRuns = bounded([
      ...attemptRows.results.flatMap((row) => row.github_run_id === null
        ? []
        : [{
            kind: 'agent',
            id: row.github_run_id,
            attemptId: row.attempt_id,
            status: row.github_status,
            conclusion: row.github_conclusion,
          }]),
      ...acceptanceRows.results.flatMap((row) => row.github_run_id === null
        ? []
        : [{
            kind: 'test_acceptance',
            id: row.github_run_id,
            acceptanceId: row.acceptance_id,
            attemptId: row.attempt_id,
            status: row.external_state,
            conclusion: row.external_conclusion,
          }]),
      ...rollbackRows.results.flatMap((row) => row.github_run_id === null
        ? []
        : [{
            kind: 'test_rollback',
            id: row.github_run_id,
            rollbackId: row.rollback_id,
            attemptId: row.attempt_id,
            status: row.external_state,
            conclusion: row.external_conclusion,
          }]),
      ...testDeploymentRunRows.results.map((row) => ({
        kind: 'test_deployment',
        id: row.github_run_id,
        deploymentId: row.deployment_id,
      })),
      ...productionDeploymentRunRows.results.map((row) => ({
        kind: 'production_deployment',
        id: row.github_run_id,
        deploymentId: row.deployment_id,
      })),
    ]);

    return {
      schemaVersion: '1',
      correlationId: run.run_id,
      matchedBy: lookup,
      task: { id: run.task_id },
      run: { id: run.run_id, state: run.state, version: run.version },
      attempts: attempts.values,
      githubRuns: githubRuns.values,
      pullRequests: pullRequests.values,
      deployments: deployments.values,
      traces: traces.values,
      truncated: {
        attempts: attempts.truncated,
        githubRuns: githubRuns.truncated,
        pullRequests: pullRequests.truncated,
        deployments: deployments.truncated,
        traces: traces.truncated,
      },
    };
  }

  private linkViews(kind: CorrelationLookupKind): string[] {
    if (kind === 'github_run') {
      return [
        'correlation_links_identity',
        'correlation_links_workflow_runs',
        'correlation_links_deployment_runs',
      ];
    }
    if (
      kind === 'test_deployment' || kind === 'production_deployment' ||
      kind === 'github_deployment'
    ) return ['correlation_links_deployments'];
    if (kind === 'test_acceptance' || kind === 'test_rollback') {
      return ['correlation_links_workflow_runs'];
    }
    if (kind === 'trace' || kind === 'github_pr') {
      return ['correlation_links_trace_pr'];
    }
    return ['correlation_links_identity'];
  }
}
