import { canonicalSha256 } from '../domain/digest.js';
import {
  IdentityApprovalEvidenceManifestV1Schema,
  type IdentityApprovalEvidenceManifestV1,
} from '../domain/identity-approval-evidence.js';
import {
  GitHubMergeGateApiClient,
  type GitHubApprovalIdentityFact,
  type GitHubMergeGateExternalFactClient,
} from '../reconciliation/github-merge-gate-reconciler.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

export type IdentityApprovalEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_fact_mismatch'
  | 'identity_binding_mismatch'
  | 'effect_mismatch';

export class IdentityApprovalEvidenceVerificationError extends Error {
  constructor(readonly code: IdentityApprovalEvidenceVerificationErrorCode) {
    super(`Identity approval evidence verification failed: ${code}`);
    this.name = 'IdentityApprovalEvidenceVerificationError';
  }
}

export interface IdentityApprovalEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface IdentityApprovalEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  caseCount: number;
  acceptedCases: number;
  rejectedCases: number;
  selfApprovalRejections: number;
  mergeEffects: 0;
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
    throw new IdentityApprovalEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new IdentityApprovalEvidenceVerificationError('configuration_invalid');
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
    throw new IdentityApprovalEvidenceVerificationError('control_plane_unavailable');
  }
  if (
    !response.ok || /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')
  ) {
    await response.body?.cancel();
    throw new IdentityApprovalEvidenceVerificationError('control_plane_unavailable');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new IdentityApprovalEvidenceVerificationError('control_plane_response_invalid');
  }
  let text: string | null;
  try {
    text = await readBounded(response);
  } catch {
    throw new IdentityApprovalEvidenceVerificationError('control_plane_response_invalid');
  }
  if (text === null) throw new IdentityApprovalEvidenceVerificationError('control_plane_response_invalid');
  try {
    const body = record(JSON.parse(text) as unknown);
    if (body === null) throw new Error('invalid');
    return body;
  } catch {
    throw new IdentityApprovalEvidenceVerificationError('control_plane_response_invalid');
  }
}

function projection(audit: Record<string, unknown>): {
  run: Record<string, unknown>;
  checks: Record<string, unknown>;
  approvals: Array<Record<string, unknown>>;
  changes: Array<Record<string, unknown>>;
  deployments: Array<Record<string, unknown>>;
} {
  const run = record(audit.run);
  const answers = record(audit.answers);
  const checks = answers === null ? null : record(answers.checks);
  if (run === null || answers === null || checks === null) {
    throw new IdentityApprovalEvidenceVerificationError('control_plane_projection_mismatch');
  }
  return {
    run,
    checks,
    approvals: rows(answers, 'approvals'),
    changes: rows(answers, 'changes'),
    deployments: rows(answers, 'deployments'),
  };
}

function assertGitHubReview(
  fact: GitHubApprovalIdentityFact,
  item: IdentityApprovalEvidenceManifestV1['cases'][number],
): void {
  if (item.github === null || fact.repository !== item.repository ||
    fact.number !== item.github.pullRequestNumber || fact.headBranch !== item.github.headBranch ||
    fact.baseBranch !== item.github.baseBranch || fact.headSha !== item.github.headSha ||
    fact.authorLogin !== item.identity.authorLogin) {
    throw new IdentityApprovalEvidenceVerificationError('github_fact_mismatch');
  }
  if (!fact.reviews.some((review) =>
    review.login === item.source.externalSubject && review.state === 'APPROVED' &&
    review.commitId === item.github!.headSha)) {
    throw new IdentityApprovalEvidenceVerificationError('github_fact_mismatch');
  }
}

async function verifyCase(
  item: IdentityApprovalEvidenceManifestV1['cases'][number],
  audit: Record<string, unknown>,
  github: GitHubMergeGateExternalFactClient,
): Promise<void> {
  const { run, checks, approvals, changes, deployments } = projection(audit);
  const identityRows = rows(checks, 'identityApprovals').filter((row) =>
    row.sourceId === item.source.sourceId);
  if (
    identityRows.length !== 1 || run.id !== item.runId ||
    run.version !== item.currentRunVersion
  ) throw new IdentityApprovalEvidenceVerificationError('control_plane_projection_mismatch');
  const row = identityRows[0]!;
  const rolesDigest = await canonicalSha256(item.identity.approverRoles);
  const comparable = [
    row.provider === item.source.provider,
    row.tenantKey === item.source.tenantKey,
    row.externalEventId === item.source.externalEventId,
    row.eventDigest === item.source.eventDigest,
    row.channel === item.source.channel,
    row.channelUserId === item.source.channelUserId,
    row.sourceOccurredAt === item.source.occurredAt,
    row.outcome === item.outcome,
    row.runId === item.runId,
    row.taskRevision === item.taskRevision,
    row.planId === item.planId,
    row.planVersion === item.planVersion,
    row.planDigest === item.planDigest,
    row.baseSha === item.baseSha,
    row.effect === item.effect,
    row.decision === item.decision,
    row.approverPrincipal === item.identity.approverPrincipal,
    row.authorPrincipal === item.identity.authorPrincipal,
    row.authorChannel === item.identity.authorChannel,
    row.authorLogin === item.identity.authorLogin,
    row.rolesDigest === rolesDigest,
    row.separationVerified === item.identity.separationVerified,
    (row.approvalId ?? null) === (item.outcome === 'accepted' ? item.approvalId : null),
    (row.lineageId ?? null) === (item.outcome === 'accepted' ? item.lineageId : null),
    (row.rejectionId ?? null) === (item.outcome === 'rejected' ? item.rejectionId : null),
    (row.reason ?? null) === (item.outcome === 'rejected' ? item.rejectionReason : null),
    (row.expiresAt ?? null) === (item.outcome === 'accepted' ? item.expiresAt : null),
  ];
  if (comparable.some((value) => !value)) {
    throw new IdentityApprovalEvidenceVerificationError('control_plane_projection_mismatch');
  }
  const approvalRows = approvals.filter((approval) =>
    approval.approvalId === item.approvalId);
  if (item.outcome === 'accepted') {
    if (
      approvalRows.length !== 1 || approvalRows[0]!.effect !== item.effect ||
      approvalRows[0]!.decision !== 'approve' || approvalRows[0]!.planId !== item.planId ||
      approvalRows[0]!.planVersion !== item.planVersion ||
      approvalRows[0]!.planDigest !== item.planDigest ||
      approvalRows[0]!.baseSha !== item.baseSha ||
      approvalRows[0]!.approver !== item.identity.approverPrincipal ||
      approvalRows[0]!.lineageId !== item.lineageId ||
      approvalRows[0]!.invalidated !== false
    ) throw new IdentityApprovalEvidenceVerificationError('identity_binding_mismatch');
  } else if (approvalRows.length !== 0) {
    throw new IdentityApprovalEvidenceVerificationError('identity_binding_mismatch');
  }
  const mergeChanges = changes.filter((change) => change.kind === 'merge');
  const effectOutboxes = rows(checks, 'effectOutboxes');
  const mergeOutboxes = effectOutboxes.filter((outbox) => outbox.kind === 'merge');
  const productionOutboxes = effectOutboxes.filter((outbox) => outbox.kind === 'production_deploy');
  const productionDeployments = deployments.filter((deployment) =>
    deployment.kind === 'production');
  if (
    mergeChanges.length !== item.noEffect.merges ||
    mergeOutboxes.length !== item.noEffect.mergeOutboxes ||
    productionOutboxes.length !== item.noEffect.productionOutboxes ||
    productionDeployments.length !== item.noEffect.productionDeployments
  ) throw new IdentityApprovalEvidenceVerificationError('effect_mismatch');
  if (item.source.provider === 'github') {
    let fact: GitHubApprovalIdentityFact;
    try {
      fact = await (github as GitHubMergeGateApiClient).observeApprovalIdentity({
        repository: item.repository,
        number: item.github!.pullRequestNumber,
        headBranch: item.github!.headBranch,
        baseBranch: item.github!.baseBranch,
      });
    } catch {
      throw new IdentityApprovalEvidenceVerificationError('github_api_unavailable');
    }
    assertGitHubReview(fact, item);
  }
}

export async function verifyIdentityApprovalEvidence(
  input: IdentityApprovalEvidenceManifestV1,
  options: IdentityApprovalEvidenceVerifierOptions,
): Promise<IdentityApprovalEvidenceVerificationSummary> {
  const parsed = IdentityApprovalEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new IdentityApprovalEvidenceVerificationError('manifest_invalid');
  if (!TOKEN_PATTERN.test(options.controlPlaneToken) || !TOKEN_PATTERN.test(options.githubToken)) {
    throw new IdentityApprovalEvidenceVerificationError('configuration_invalid');
  }
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubApiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const github = new GitHubMergeGateApiClient(
    { getMergeObservationToken: async () => options.githubToken },
    { apiBaseUrl: githubApiOrigin, fetch: fetcher },
  );
  const audits = new Map<string, Record<string, unknown>>();
  for (const item of input.cases) {
    const audit = audits.get(item.runId) ?? await controlPlaneJson(
      fetcher, controlPlaneOrigin, options.controlPlaneToken, item.runId,
    );
    audits.set(item.runId, audit);
    await verifyCase(item, audit, github);
  }
  return {
    schemaVersion: '1', evidenceId: input.evidenceId, repository: input.repository,
    caseCount: input.cases.length,
    acceptedCases: input.cases.filter((item) => item.outcome === 'accepted').length,
    rejectedCases: input.cases.filter((item) => item.outcome === 'rejected').length,
    selfApprovalRejections: input.cases.filter((item) =>
      item.outcome === 'rejected' &&
      (item.rejectionReason === 'self_approval_denied' ||
        item.rejectionReason === 'task_actor_self_approval')).length,
    mergeEffects: 0,
    productionEffects: 0,
  };
}
