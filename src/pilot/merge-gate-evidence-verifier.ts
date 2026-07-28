import { canonicalSha256 } from '../domain/digest.js';
import {
  MergeGateEvidenceManifestV1Schema,
  type MergeGateEvidenceManifestV1,
} from '../domain/merge-gate-evidence.js';
import {
  GitHubMergeGateApiClient,
  type GitHubMergeGateExternalFactClient,
} from '../reconciliation/github-merge-gate-reconciler.js';
import type { GitHubMergeGateFact } from '../domain/github-merge-gate.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

export type MergeGateEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_fact_mismatch'
  | 'merge_effect_mismatch';

export class MergeGateEvidenceVerificationError extends Error {
  constructor(readonly code: MergeGateEvidenceVerificationErrorCode) {
    super(`Merge gate evidence verification failed: ${code}`);
    this.name = 'MergeGateEvidenceVerificationError';
  }
}

export interface MergeGateEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface MergeGateEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  caseCount: number;
  readyToMergeCases: number;
  rejectedCases: number;
  rejectionReasons: string[];
  mergeEffects: 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rows(parent: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = parent[key];
  return Array.isArray(value)
    ? value.map(record).filter((row): row is Record<string, unknown> => row !== null)
    : [];
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MergeGateEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new MergeGateEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

async function readBounded(response: Response): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function controlPlaneJson(
  fetcher: typeof fetch,
  origin: string,
  token: string,
  runId: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(`${origin}/v1/runs/${runId}/audit`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
    });
  } catch {
    throw new MergeGateEvidenceVerificationError('control_plane_unavailable');
  }
  if (!response.ok || /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new MergeGateEvidenceVerificationError('control_plane_unavailable');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new MergeGateEvidenceVerificationError('control_plane_response_invalid');
  }
  let text: string | null;
  try {
    text = await readBounded(response);
  } catch {
    throw new MergeGateEvidenceVerificationError('control_plane_response_invalid');
  }
  if (text === null) throw new MergeGateEvidenceVerificationError('control_plane_response_invalid');
  try {
    const body = record(JSON.parse(text) as unknown);
    if (body === null) throw new Error('invalid');
    return body;
  } catch {
    throw new MergeGateEvidenceVerificationError('control_plane_response_invalid');
  }
}

function canonicalEqual(left: unknown, right: unknown): Promise<boolean> {
  return Promise.all([canonicalSha256(left), canonicalSha256(right)]).then(([a, b]) => a === b);
}

function projection(audit: Record<string, unknown>): {
  run: Record<string, unknown>;
  answers: Record<string, unknown>;
  checks: Record<string, unknown>;
  approvals: Array<Record<string, unknown>>;
  changes: Array<Record<string, unknown>>;
} {
  const run = record(audit.run);
  const answers = record(audit.answers);
  const checks = answers === null ? null : record(answers.checks);
  if (run === null || answers === null || checks === null) {
    throw new MergeGateEvidenceVerificationError('control_plane_projection_mismatch');
  }
  return {
    run,
    answers,
    checks,
    approvals: rows(answers, 'approvals'),
    changes: rows(answers, 'changes'),
  };
}

function factMismatch(
  actual: GitHubMergeGateFact,
  expected: GitHubMergeGateFact,
): Promise<boolean> {
  return canonicalEqual(actual, expected);
}

function assertReason(caseItem: MergeGateEvidenceManifestV1['cases'][number]): void {
  const fact = caseItem.fact;
  switch (caseItem.rejectionReason) {
    case 'required_checks_incomplete':
      if (!fact.requiredChecks.some((check) => check.state === 'missing' || check.state === 'pending')) {
        throw new MergeGateEvidenceVerificationError('github_fact_mismatch');
      }
      break;
    case 'required_checks_failed':
      if (!fact.requiredChecks.some((check) => check.state === 'failed')) {
        throw new MergeGateEvidenceVerificationError('github_fact_mismatch');
      }
      break;
    case 'review_insufficient':
      if (fact.reviewDecision === 'approved' && fact.approvedReviewCount >= fact.requiredApprovals) {
        throw new MergeGateEvidenceVerificationError('github_fact_mismatch');
      }
      break;
    case 'base_not_latest':
      if (fact.baseSha === caseItem.fact.pullRequestBaseSha) {
        throw new MergeGateEvidenceVerificationError('github_fact_mismatch');
      }
      break;
    case 'approval_required':
      if (caseItem.approval === null || Date.parse(caseItem.approval.expiresAt) > Date.parse(caseItem.evaluation.createdAt)) {
        throw new MergeGateEvidenceVerificationError('control_plane_projection_mismatch');
      }
      break;
    default:
      break;
  }
}

async function verifyCase(
  caseItem: MergeGateEvidenceManifestV1['cases'][number],
  audit: Record<string, unknown>,
  github: GitHubMergeGateExternalFactClient,
): Promise<void> {
  const { run, checks, approvals, changes } = projection(audit);
  const gates = rows(checks, 'mergeGates').filter((gate) =>
    record(gate.evaluation)?.evaluationId === caseItem.evaluation.evaluationId);
  if (gates.length !== 1 || run.id !== caseItem.runId ||
    run.state !== caseItem.runState || run.version !== caseItem.currentRunVersion) {
    throw new MergeGateEvidenceVerificationError('control_plane_projection_mismatch');
  }
  const gate = gates[0]!;
  const fact = record(gate.fact);
  const evaluation = record(gate.evaluation);
  if (fact === null || evaluation === null ||
    gate.observationId !== caseItem.observation.observationId ||
    gate.factDigest !== caseItem.observation.factDigest ||
    gate.runVersion !== caseItem.runVersion ||
    evaluation.evaluationId !== caseItem.evaluation.evaluationId ||
    evaluation.status !== caseItem.evaluation.status ||
    evaluation.rejectionReason !== caseItem.evaluation.rejectionReason ||
    evaluation.createdAt !== caseItem.evaluation.createdAt ||
    (gate.decisionId ?? null) !== caseItem.decisionId ||
    !await canonicalEqual(fact, caseItem.fact) ||
    await canonicalSha256(caseItem.fact) !== caseItem.observation.factDigest
  ) throw new MergeGateEvidenceVerificationError('control_plane_projection_mismatch');

  let externalFact: GitHubMergeGateFact;
  try {
    externalFact = await github.observeMergeGate({
      repository: caseItem.repository,
      number: caseItem.pullRequestNumber,
      headBranch: caseItem.fact.headBranch,
      baseBranch: caseItem.fact.baseBranch,
    });
  } catch {
    throw new MergeGateEvidenceVerificationError('github_api_unavailable');
  }
  if (await factMismatch(externalFact, caseItem.fact) === false) {
    throw new MergeGateEvidenceVerificationError('github_fact_mismatch');
  }
  assertReason(caseItem);

  const approval = caseItem.approval;
  if (approval !== null) {
    const approvalRows = approvals.filter((row) => row.approvalId === approval.approvalId);
    if (approvalRows.length !== 1 || approvalRows[0]!.effect !== 'merge' ||
      approvalRows[0]!.decision !== 'approve' || approvalRows[0]!.expiresAt !== approval.expiresAt ||
      approvalRows[0]!.invalidated !== false || evaluation.approvalId !== approval.approvalId) {
      throw new MergeGateEvidenceVerificationError('control_plane_projection_mismatch');
    }
  } else if (evaluation.approvalId !== null) {
    throw new MergeGateEvidenceVerificationError('control_plane_projection_mismatch');
  }
  const mergeChanges = changes.filter((change) => change.kind === 'merge');
  const effectOutboxes = rows(checks, 'effectOutboxes');
  if (mergeChanges.length !== 0 || effectOutboxes.some((outbox) => outbox.kind === 'merge')) {
    throw new MergeGateEvidenceVerificationError('merge_effect_mismatch');
  }
  if (caseItem.outcome === 'ready_to_merge') {
    if (caseItem.decisionId === null || evaluation.status !== 'passed' ||
      caseItem.fact.state !== 'open' || caseItem.fact.draft ||
      caseItem.fact.baseSha !== caseItem.fact.pullRequestBaseSha ||
      caseItem.fact.mergeability !== 'mergeable' ||
      !['clean', 'unstable'].includes(caseItem.fact.mergeState) ||
      caseItem.fact.reviewDecision !== 'approved' ||
      caseItem.fact.approvedReviewCount < caseItem.fact.requiredApprovals ||
      caseItem.fact.requiredChecks.length === 0 ||
      caseItem.fact.requiredChecks.some((check) => check.state !== 'passed') ||
      caseItem.approval === null ||
      Date.parse(caseItem.approval.expiresAt) <= Date.parse(caseItem.evaluation.createdAt)) {
      throw new MergeGateEvidenceVerificationError('control_plane_projection_mismatch');
    }
  } else if (evaluation.status !== 'rejected' || caseItem.rejectionReason === null) {
    throw new MergeGateEvidenceVerificationError('control_plane_projection_mismatch');
  }
}

export async function verifyMergeGateEvidence(
  input: MergeGateEvidenceManifestV1,
  options: MergeGateEvidenceVerifierOptions,
): Promise<MergeGateEvidenceVerificationSummary> {
  const parsed = MergeGateEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new MergeGateEvidenceVerificationError('manifest_invalid');
  if (!TOKEN_PATTERN.test(options.controlPlaneToken) || !TOKEN_PATTERN.test(options.githubToken)) {
    throw new MergeGateEvidenceVerificationError('configuration_invalid');
  }
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubApiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const github = new GitHubMergeGateApiClient(
    { getMergeObservationToken: async () => options.githubToken },
    { apiBaseUrl: githubApiOrigin, fetch: fetcher },
  );
  const audits = new Map<string, Record<string, unknown>>();
  for (const caseItem of input.cases) {
    const audit = audits.get(caseItem.runId) ?? await controlPlaneJson(
      fetcher, controlPlaneOrigin, options.controlPlaneToken, caseItem.runId,
    );
    audits.set(caseItem.runId, audit);
    await verifyCase(caseItem, audit, github);
  }
  return {
    schemaVersion: '1', evidenceId: input.evidenceId, repository: input.repository,
    caseCount: input.cases.length,
    readyToMergeCases: input.cases.filter((item) => item.outcome === 'ready_to_merge').length,
    rejectedCases: input.cases.filter((item) => item.outcome === 'rejected').length,
    rejectionReasons: [...new Set(input.cases.flatMap((item) =>
      item.rejectionReason === null ? [] : [item.rejectionReason]))].sort(),
    mergeEffects: 0,
  };
}
