import { canonicalSha256 } from '../domain/digest.js';
import {
  ProductionApprovalEvidenceManifestV1Schema,
  type ProductionApprovalEvidenceManifestV1,
} from '../domain/production-approval-evidence.js';
import {
  GitHubMergeStatusApiClient,
  type GitHubMergeStatusExternalFactClient,
} from '../reconciliation/github-merge-status-reconciler.js';
import type { GitHubPullRequestMergeFact } from '../domain/github-merge-status.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

export type ProductionApprovalEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_fact_mismatch'
  | 'identity_binding_mismatch'
  | 'production_effect_mismatch';

export class ProductionApprovalEvidenceVerificationError extends Error {
  constructor(readonly code: ProductionApprovalEvidenceVerificationErrorCode) {
    super(`production approval evidence verification failed: ${code}`);
    this.name = 'ProductionApprovalEvidenceVerificationError';
  }
}

export interface ProductionApprovalEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface ProductionApprovalEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  caseCount: number;
  acceptedCases: number;
  rejectedCases: number;
  verifiedMergeFacts: number;
  productionEffects: 0;
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
    throw new ProductionApprovalEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new ProductionApprovalEvidenceVerificationError('configuration_invalid');
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
    throw new ProductionApprovalEvidenceVerificationError('control_plane_unavailable');
  }
  if (!response.ok || /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new ProductionApprovalEvidenceVerificationError('control_plane_unavailable');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ProductionApprovalEvidenceVerificationError('control_plane_response_invalid');
  }
  let text: string | null;
  try {
    text = await readBounded(response);
  } catch {
    throw new ProductionApprovalEvidenceVerificationError('control_plane_response_invalid');
  }
  if (text === null) throw new ProductionApprovalEvidenceVerificationError('control_plane_response_invalid');
  try {
    const body = record(JSON.parse(text) as unknown);
    if (body === null) throw new Error('invalid');
    return body;
  } catch {
    throw new ProductionApprovalEvidenceVerificationError('control_plane_response_invalid');
  }
}

function projection(audit: Record<string, unknown>): {
  run: Record<string, unknown>;
  task: Record<string, unknown>;
  answers: Record<string, unknown>;
  checks: Record<string, unknown>;
} {
  const run = record(audit.run);
  const task = record(audit.task);
  const answers = record(audit.answers);
  const checks = answers === null ? null : record(answers.checks);
  if (run === null || task === null || answers === null || checks === null) {
    throw new ProductionApprovalEvidenceVerificationError('control_plane_projection_mismatch');
  }
  return { run, task, answers, checks };
}

async function verifyMergeFact(
  item: ProductionApprovalEvidenceManifestV1['cases'][number],
  github: GitHubMergeStatusExternalFactClient,
): Promise<void> {
  let actual: GitHubPullRequestMergeFact | null;
  try {
    actual = await github.getMergeStatus({
      repository: item.mergeFact.repository,
      number: item.mergeFact.number,
      url: item.mergeFact.url,
      headBranch: item.mergeFact.headBranch,
      headSha: item.mergeFact.headSha,
      baseBranch: item.mergeFact.baseBranch,
    });
  } catch {
    throw new ProductionApprovalEvidenceVerificationError('github_api_unavailable');
  }
  if (actual === null || await canonicalSha256(actual) !== await canonicalSha256(item.mergeFact)) {
    throw new ProductionApprovalEvidenceVerificationError('github_fact_mismatch');
  }
}

async function verifyCase(
  item: ProductionApprovalEvidenceManifestV1['cases'][number],
  audit: Record<string, unknown>,
  github: GitHubMergeStatusExternalFactClient,
): Promise<void> {
  const { run, task, answers, checks } = projection(audit);
  if (
    run.id !== item.runId || run.version !== item.currentRunVersion || run.state !== item.runState ||
    task.repository !== item.repository
  ) throw new ProductionApprovalEvidenceVerificationError('control_plane_projection_mismatch');

  const sourceRows = rows(checks, 'identityApprovals').filter((row) =>
    row.sourceId === item.source.sourceId);
  if (sourceRows.length !== 1) {
    throw new ProductionApprovalEvidenceVerificationError('control_plane_projection_mismatch');
  }
  const source = sourceRows[0]!;
  const rolesDigest = await canonicalSha256(item.identity.approverRoles);
  if (
    source.provider !== item.source.provider || source.tenantKey !== item.source.tenantKey ||
    source.externalEventId !== item.source.externalEventId || source.eventDigest !== item.source.eventDigest ||
    source.channel !== item.source.channel || source.channelUserId !== item.source.channelUserId ||
    source.sourceOccurredAt !== item.source.occurredAt || source.outcome !== item.outcome ||
    source.runId !== item.runId || source.taskRevision !== item.taskRevision ||
    source.planId !== item.planId || source.planVersion !== item.planVersion ||
    source.planDigest !== item.planDigest || source.baseSha !== item.baseSha ||
    source.effect !== 'production_deploy' || source.decision !== 'approve' ||
    source.approverPrincipal !== item.identity.approverPrincipal ||
    source.authorPrincipal !== item.identity.authorPrincipal || source.authorLogin !== item.identity.authorLogin ||
    source.rolesDigest !== rolesDigest || source.separationVerified !== item.identity.separationVerified ||
    (source.approvalId ?? null) !== item.approvalId ||
    (source.lineageId ?? null) !== item.lineageId ||
    (source.rejectionId ?? null) !== item.rejectionId ||
    (source.reason ?? null) !== item.rejectionReason ||
    (source.expiresAt ?? null) !== item.expiresAt
  ) throw new ProductionApprovalEvidenceVerificationError('control_plane_projection_mismatch');

  const approvals = rows(answers, 'approvals').filter((row) =>
    row.approvalId === item.approvalId);
  const bindings = rows(checks, 'productionApprovals').filter((row) =>
    row.approvalId === item.approvalId);
  if (item.outcome === 'accepted') {
    if (
      approvals.length !== 1 || bindings.length !== 1 ||
      approvals[0]!.effect !== 'production_deploy' || approvals[0]!.decision !== 'approve' ||
      approvals[0]!.planId !== item.planId || approvals[0]!.planVersion !== item.planVersion ||
      approvals[0]!.planDigest !== item.planDigest || approvals[0]!.baseSha !== item.baseSha ||
      approvals[0]!.lineageId !== item.lineageId || approvals[0]!.invalidated !== false
    ) throw new ProductionApprovalEvidenceVerificationError('identity_binding_mismatch');
    const binding = bindings[0]!;
    if (
      binding.runId !== item.runId || binding.taskRevision !== item.taskRevision ||
      binding.planId !== item.planId || binding.planVersion !== item.planVersion ||
      binding.planDigest !== item.planDigest || binding.baseSha !== item.baseSha ||
      binding.mergeId !== item.mergeId || binding.mergeSha !== item.mergeSha ||
      binding.environment !== 'production' || binding.decision !== 'approve' ||
      binding.expiresAt !== item.expiresAt || binding.sourceId !== item.source.sourceId ||
      binding.provider !== item.source.provider || binding.eventDigest !== item.source.eventDigest ||
      binding.approverPrincipal !== item.identity.approverPrincipal ||
      binding.rolesDigest !== rolesDigest || binding.separationVerified !== true
    ) throw new ProductionApprovalEvidenceVerificationError('identity_binding_mismatch');
  } else if (approvals.length !== 0 || bindings.length !== 0) {
    throw new ProductionApprovalEvidenceVerificationError('identity_binding_mismatch');
  }

  const productionOutboxes = rows(checks, 'effectOutboxes').filter((row) =>
    row.kind === 'production_deploy');
  const productionDeployments = rows(answers, 'deployments').filter((row) =>
    row.kind === 'production');
  const who = record(answers.who);
  const productionAttempts = rows(who ?? {}, 'attempts').filter((attempt) =>
    attempt.mode === 'deploy' &&
    typeof attempt.workflowRef === 'string' &&
    attempt.workflowRef.includes('delivery-production-deploy.yml'),
  ).length;
  if (
    productionOutboxes.length !== 0 || productionDeployments.length !== 0 || productionAttempts !== 0 ||
    item.noEffect.productionOutboxes !== 0 || item.noEffect.productionDeployments !== 0 ||
    item.noEffect.productionAttempts !== 0
  ) throw new ProductionApprovalEvidenceVerificationError('production_effect_mismatch');
  await verifyMergeFact(item, github);
}

export async function verifyProductionApprovalEvidence(
  input: ProductionApprovalEvidenceManifestV1,
  options: ProductionApprovalEvidenceVerifierOptions,
): Promise<ProductionApprovalEvidenceVerificationSummary> {
  const parsed = ProductionApprovalEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new ProductionApprovalEvidenceVerificationError('manifest_invalid');
  if (!TOKEN_PATTERN.test(options.controlPlaneToken) || !TOKEN_PATTERN.test(options.githubToken)) {
    throw new ProductionApprovalEvidenceVerificationError('configuration_invalid');
  }
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubApiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const github = new GitHubMergeStatusApiClient(
    { getMergeObservationToken: async () => options.githubToken },
    { apiBaseUrl: githubApiOrigin, fetch: fetcher },
  );
  const audits = new Map<string, Record<string, unknown>>();
  for (const item of parsed.data.cases) {
    const audit = audits.get(item.runId) ?? await controlPlaneJson(
      fetcher, controlPlaneOrigin, options.controlPlaneToken, item.runId,
    );
    audits.set(item.runId, audit);
    await verifyCase(item, audit, github);
  }
  return {
    schemaVersion: '1', evidenceId: parsed.data.evidenceId, repository: parsed.data.repository,
    caseCount: parsed.data.cases.length,
    acceptedCases: parsed.data.cases.filter((item) => item.outcome === 'accepted').length,
    rejectedCases: parsed.data.cases.filter((item) => item.outcome === 'rejected').length,
    verifiedMergeFacts: parsed.data.cases.length,
    productionEffects: 0,
  };
}
