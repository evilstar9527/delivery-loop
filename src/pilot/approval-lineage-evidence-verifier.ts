import { canonicalSha256 } from '../domain/digest.js';
import {
  ApprovalLineageEvidenceManifestV1Schema,
  ApprovalLineageObservabilityReportV1Schema,
  type ApprovalLineageEvidenceManifestV1,
  type ApprovalLineageObservabilityReportV1,
} from '../domain/approval-lineage-evidence.js';
import {
  GitHubMergeGateApiClient,
  type GitHubApprovalIdentityFact,
} from '../reconciliation/github-merge-gate-reconciler.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;

export type ApprovalLineageEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'observability_unavailable'
  | 'observability_response_invalid'
  | 'observability_digest_mismatch'
  | 'replay_observation_mismatch'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'cross_provider_binding_mismatch'
  | 'feishu_action_mismatch'
  | 'isolation_mismatch'
  | 'github_api_unavailable'
  | 'github_fact_mismatch'
  | 'effect_observed'
  | 'secret_leak_detected';

export class ApprovalLineageEvidenceVerificationError extends Error {
  constructor(readonly code: ApprovalLineageEvidenceVerificationErrorCode) {
    super(`Approval lineage evidence verification failed: ${code}`);
    this.name = 'ApprovalLineageEvidenceVerificationError';
  }
}

export interface ApprovalLineageEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  operationsToken: string;
  observabilityReportUrl: string;
  observabilityToken: string;
  githubToken: string;
  canary: string;
  githubApiOrigin?: string;
  fetcher?: typeof fetch;
}

export interface ApprovalLineageEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  runId: string;
  providerApprovals: 2;
  independentLineages: 2;
  sameHumanPrincipal: 'verified';
  exactSnapshotBinding: 'verified';
  replayConvergence: 'verified';
  eventAndSnapshotIsolation: 'verified';
  mergeEffects: 0;
  plaintextLeaks: 0;
  humanReview: 'required_and_recorded';
}

type JsonSource = 'observability' | 'control_plane';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rows(parent: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = parent[key];
  return Array.isArray(value)
    ? value.map(record).filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new ApprovalLineageEvidenceVerificationError('configuration_invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new ApprovalLineageEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

function httpsUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new ApprovalLineageEvidenceVerificationError('configuration_invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) throw new ApprovalLineageEvidenceVerificationError('configuration_invalid');
  return url.toString();
}

async function boundedText(response: Response): Promise<string | null> {
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

function unavailableCode(source: JsonSource): ApprovalLineageEvidenceVerificationErrorCode {
  return source === 'observability' ? 'observability_unavailable' : 'control_plane_unavailable';
}

function invalidCode(source: JsonSource): ApprovalLineageEvidenceVerificationErrorCode {
  return source === 'observability'
    ? 'observability_response_invalid'
    : 'control_plane_response_invalid';
}

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  source: JsonSource,
  scanner: SecretScanner,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApprovalLineageEvidenceVerificationError(unavailableCode(source));
  }
  if (!response.ok || /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new ApprovalLineageEvidenceVerificationError(unavailableCode(source));
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ApprovalLineageEvidenceVerificationError(invalidCode(source));
  }
  let text: string | null;
  try { text = await boundedText(response); }
  catch { throw new ApprovalLineageEvidenceVerificationError(invalidCode(source)); }
  if (text === null) throw new ApprovalLineageEvidenceVerificationError(invalidCode(source));
  if (scanner.scanText(text, `$.${source}`).length > 0) {
    throw new ApprovalLineageEvidenceVerificationError('secret_leak_detected');
  }
  try { return JSON.parse(text) as unknown; }
  catch { throw new ApprovalLineageEvidenceVerificationError(invalidCode(source)); }
}

function sourceFor(
  manifest: ApprovalLineageEvidenceManifestV1,
  provider: 'feishu' | 'github',
) {
  return provider === 'feishu' ? manifest.feishu : manifest.github;
}

function assertIdentityApproval(
  row: Record<string, unknown>,
  manifest: ApprovalLineageEvidenceManifestV1,
  provider: 'feishu' | 'github',
): void {
  const source = sourceFor(manifest, provider);
  const expectedTenant = provider === 'feishu' ? manifest.feishu.tenantKey : manifest.repository;
  const expectedUser = provider === 'feishu' ? null : manifest.github.reviewerLogin;
  if (
    row.sourceId !== source.sourceId || row.provider !== provider ||
    row.tenantKey !== expectedTenant || row.externalEventId !== source.externalEventId ||
    row.eventDigest !== source.externalEventDigest || row.channel !== `${provider}:${expectedTenant}` ||
    (expectedUser !== null && row.channelUserId !== expectedUser) ||
    row.sourceOccurredAt !== source.sourceOccurredAt || row.outcome !== 'accepted' ||
    row.approvalId !== source.approvalId || row.lineageId !== source.lineageId ||
    row.runId !== manifest.snapshot.runId || row.taskRevision !== manifest.snapshot.taskRevision ||
    row.planId !== manifest.snapshot.planId || row.planVersion !== manifest.snapshot.planVersion ||
    row.planDigest !== manifest.snapshot.planDigest || row.baseSha !== manifest.snapshot.baseSha ||
    row.effect !== 'merge' || row.decision !== 'approve' ||
    row.approverPrincipal !== manifest.identity.principal ||
    row.approverChannel !== `${provider}:${expectedTenant}` ||
    row.approverChannelUserId !== row.channelUserId ||
    (expectedUser !== null && row.approverChannelUserId !== expectedUser) ||
    row.authorPrincipal !== manifest.identity.pullRequestAuthorPrincipal ||
    row.authorChannel !== `github:${manifest.repository}` ||
    row.authorLogin !== manifest.identity.pullRequestAuthorLogin ||
    row.rolesDigest !== manifest.identity.rolesDigest || row.separationVerified !== true ||
    row.expiresAt !== source.expiresAt || row.decisionRecordedAt !== source.decisionRecordedAt
  ) throw new ApprovalLineageEvidenceVerificationError('cross_provider_binding_mismatch');
}

function assertApproval(
  row: Record<string, unknown>,
  manifest: ApprovalLineageEvidenceManifestV1,
  provider: 'feishu' | 'github',
): void {
  const source = sourceFor(manifest, provider);
  if (
    row.approvalId !== source.approvalId || row.taskId !== manifest.snapshot.taskId ||
    row.taskRevision !== manifest.snapshot.taskRevision ||
    row.approver !== manifest.identity.principal || row.effect !== 'merge' ||
    row.decision !== 'approve' || row.planId !== manifest.snapshot.planId ||
    row.planVersion !== manifest.snapshot.planVersion ||
    row.planDigest !== manifest.snapshot.planDigest || row.baseSha !== manifest.snapshot.baseSha ||
    row.expiresAt !== source.expiresAt || row.createdAt !== source.decisionRecordedAt ||
    row.rolesDigest !== manifest.identity.rolesDigest || row.separationVerified !== true ||
    row.provider !== provider || row.lineageId !== source.lineageId ||
    row.sourceRecordId !== source.sourceId || row.externalEventId !== source.externalEventId ||
    row.eventDigest !== source.externalEventDigest || row.sourceOccurredAt !== source.sourceOccurredAt ||
    row.decisionRecordedAt !== source.decisionRecordedAt || row.invalidated !== false
  ) throw new ApprovalLineageEvidenceVerificationError('cross_provider_binding_mismatch');
}

async function validateAudit(
  raw: unknown,
  manifest: ApprovalLineageEvidenceManifestV1,
): Promise<void> {
  const root = record(raw);
  const run = root === null ? null : record(root.run);
  const task = root === null ? null : record(root.task);
  const answers = root === null ? null : record(root.answers);
  const checks = answers === null ? null : record(answers.checks);
  if (
    root === null || run === null || task === null || answers === null || checks === null ||
    root.schemaVersion !== '1' || root.runId !== manifest.snapshot.runId ||
    task.id !== manifest.snapshot.taskId || task.revision !== manifest.snapshot.taskRevision ||
    task.digest !== manifest.snapshot.taskDigest || task.repository !== manifest.repository ||
    run.version !== manifest.snapshot.runVersion || run.baseSha !== manifest.snapshot.baseSha ||
    run.activePlanId !== manifest.snapshot.planId ||
    run.activePlanVersion !== manifest.snapshot.planVersion ||
    run.activePlanDigest !== manifest.snapshot.planDigest
  ) throw new ApprovalLineageEvidenceVerificationError('cross_provider_binding_mismatch');

  const expectedSourceIds = new Set([manifest.feishu.sourceId, manifest.github.sourceId]);
  const identities = rows(checks, 'identityApprovals').filter((item) =>
    typeof item.sourceId === 'string' && expectedSourceIds.has(item.sourceId));
  if (identities.length !== 2) {
    throw new ApprovalLineageEvidenceVerificationError('cross_provider_binding_mismatch');
  }
  for (const provider of ['feishu', 'github'] as const) {
    const source = sourceFor(manifest, provider);
    const row = identities.find((item) => item.sourceId === source.sourceId);
    if (row === undefined) {
      throw new ApprovalLineageEvidenceVerificationError('cross_provider_binding_mismatch');
    }
    assertIdentityApproval(row, manifest, provider);
    if (provider === 'feishu') {
      const channelUserId = row.channelUserId;
      if (
        typeof channelUserId !== 'string' ||
        await canonicalSha256(channelUserId) !== manifest.feishu.openIdDigest
      ) throw new ApprovalLineageEvidenceVerificationError('cross_provider_binding_mismatch');
    }
  }

  const expectedApprovalIds = new Set([manifest.feishu.approvalId, manifest.github.approvalId]);
  const approvals = rows(answers, 'approvals').filter((item) =>
    typeof item.approvalId === 'string' && expectedApprovalIds.has(item.approvalId));
  if (approvals.length !== 2) {
    throw new ApprovalLineageEvidenceVerificationError('cross_provider_binding_mismatch');
  }
  for (const provider of ['feishu', 'github'] as const) {
    const source = sourceFor(manifest, provider);
    const row = approvals.find((item) => item.approvalId === source.approvalId);
    if (row === undefined) {
      throw new ApprovalLineageEvidenceVerificationError('cross_provider_binding_mismatch');
    }
    assertApproval(row, manifest, provider);
  }

  const mergeOutboxes = rows(checks, 'effectOutboxes').filter((item) => item.kind === 'merge');
  const mergeChanges = rows(answers, 'changes').filter((item) => item.kind === 'merge');
  if (
    mergeOutboxes.length !== manifest.noEffect.mergeOutboxes ||
    mergeChanges.length !== manifest.noEffect.merges
  ) throw new ApprovalLineageEvidenceVerificationError('effect_observed');
}

function requiredRecord(
  parent: Record<string, unknown>,
  key: string,
  code: 'feishu_action_mismatch' | 'isolation_mismatch',
): Record<string, unknown> {
  const value = record(parent[key]);
  if (value === null) throw new ApprovalLineageEvidenceVerificationError(code);
  return value;
}

async function validateFeishuPrimary(
  raw: unknown,
  manifest: ApprovalLineageEvidenceManifestV1,
): Promise<void> {
  const root = record(raw);
  if (root === null) throw new ApprovalLineageEvidenceVerificationError('feishu_action_mismatch');
  const counts = requiredRecord(root, 'counts', 'feishu_action_mismatch');
  const delivery = requiredRecord(root, 'delivery', 'feishu_action_mismatch');
  const action = requiredRecord(root, 'action', 'feishu_action_mismatch');
  const outcome = requiredRecord(action, 'outcome', 'feishu_action_mismatch');
  const effect = requiredRecord(action, 'businessEffect', 'feishu_action_mismatch');
  if (
    root.schemaVersion !== '1' || root.tenantKey !== manifest.feishu.tenantKey ||
    root.eventId !== manifest.feishu.externalEventId ||
    counts.deliveries !== 1 || counts.ingressOutboxes !== 0 || counts.actionReceipts !== 1 ||
    counts.actionOutcomes !== 1 || counts.businessEffects !== 1 ||
    delivery.deliveryId !== manifest.feishu.deliveryId || delivery.appId !== manifest.feishu.appId ||
    delivery.eventType !== 'card.action.trigger' ||
    delivery.eventCreatedAt !== manifest.feishu.sourceOccurredAt ||
    delivery.requestDigest !== manifest.feishu.requestDigest ||
    delivery.eventDigest !== manifest.feishu.externalEventDigest ||
    action.actionReceiptId !== manifest.feishu.actionReceiptId ||
    action.deliveryId !== manifest.feishu.deliveryId ||
    action.operatorDigest !== manifest.feishu.operatorDigest ||
    action.principalDigest !== manifest.identity.principalDigest ||
    action.rolesDigest !== manifest.identity.rolesDigest || action.chatDigest !== manifest.feishu.chatDigest ||
    action.messageId !== manifest.feishu.messageId || action.cardId !== manifest.feishu.cardId ||
    action.presentationId !== manifest.feishu.presentationId ||
    action.taskId !== manifest.snapshot.taskId || action.runId !== manifest.snapshot.runId ||
    action.runVersion !== manifest.snapshot.runVersion ||
    action.taskRevisionDigest !== manifest.snapshot.taskDigest ||
    action.planId !== manifest.snapshot.planId || action.planVersion !== manifest.snapshot.planVersion ||
    action.planDigest !== manifest.snapshot.planDigest || action.baseSha !== manifest.snapshot.baseSha ||
    action.actionId !== manifest.feishu.actionId || action.command !== 'approve' ||
    action.effect !== 'merge' || action.contextMode !== null ||
    outcome.outcomeId !== manifest.feishu.outcomeId || outcome.disposition !== 'applied' ||
    outcome.resultKind !== 'approval' || outcome.resultId !== manifest.feishu.approvalId ||
    outcome.reasonCode !== null || effect.kind !== 'approval' ||
    effect.approvalId !== manifest.feishu.approvalId || effect.decision !== 'approve' ||
    effect.effect !== 'merge' || effect.expiresAt !== manifest.feishu.expiresAt ||
    effect.lineageId !== manifest.feishu.lineageId ||
    effect.sourceOccurredAt !== manifest.feishu.sourceOccurredAt ||
    effect.decisionRecordedAt !== manifest.feishu.decisionRecordedAt ||
    effect.externalEventDigest !== manifest.feishu.externalEventDigest || effect.currentTrusted !== true
  ) throw new ApprovalLineageEvidenceVerificationError('feishu_action_mismatch');
}

function validateFeishuIsolation(
  raw: unknown,
  manifest: ApprovalLineageEvidenceManifestV1,
): void {
  const root = record(raw);
  if (root === null) throw new ApprovalLineageEvidenceVerificationError('isolation_mismatch');
  const counts = requiredRecord(root, 'counts', 'isolation_mismatch');
  const delivery = requiredRecord(root, 'delivery', 'isolation_mismatch');
  const expected = manifest.isolation.feishuDistinctEvent;
  if (
    root.schemaVersion !== '1' || root.tenantKey !== manifest.feishu.tenantKey ||
    root.eventId !== expected.eventId || counts.deliveries !== 1 || counts.ingressOutboxes !== 0 ||
    counts.actionReceipts !== 0 || counts.actionOutcomes !== 0 || counts.businessEffects !== 0 ||
    delivery.deliveryId !== expected.deliveryId || delivery.appId !== manifest.feishu.appId ||
    delivery.eventType !== 'card.action.trigger' || delivery.requestDigest !== expected.requestDigest ||
    delivery.eventDigest !== expected.eventDigest || root.action !== null
  ) throw new ApprovalLineageEvidenceVerificationError('isolation_mismatch');
}

async function validateReport(
  raw: unknown,
  manifest: ApprovalLineageEvidenceManifestV1,
): Promise<ApprovalLineageObservabilityReportV1> {
  const parsed = ApprovalLineageObservabilityReportV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApprovalLineageEvidenceVerificationError('observability_response_invalid');
  }
  const report = parsed.data;
  const { reportDigest, ...body } = report;
  if (
    report.evidenceId !== manifest.evidenceId || reportDigest !== manifest.observabilityReportDigest ||
    await canonicalSha256(body) !== reportDigest ||
    Date.parse(report.generatedAt) > Date.parse(manifest.recordedAt)
  ) throw new ApprovalLineageEvidenceVerificationError('observability_digest_mismatch');
  const observation = (scenario: ApprovalLineageObservabilityReportV1['requests'][number]['scenario']) =>
    report.requests.find((item) => item.scenario === scenario)!;
  const feishu = observation('feishu_primary');
  const github = observation('github_primary');
  const feishuDistinct = observation('feishu_distinct_event');
  const githubMutation = observation('github_snapshot_mutation');
  if (
    feishu.externalEventId !== manifest.feishu.externalEventId ||
    feishu.externalEventDigest !== manifest.feishu.externalEventDigest ||
    feishu.requestDigest !== manifest.feishu.requestDigest ||
    feishu.approvalId !== manifest.feishu.approvalId ||
    feishu.lineageId !== manifest.feishu.lineageId ||
    github.externalEventId !== manifest.github.externalEventId ||
    github.externalEventDigest !== manifest.github.externalEventDigest ||
    github.requestDigest !== manifest.github.requestDigest ||
    github.approvalId !== manifest.github.approvalId ||
    github.lineageId !== manifest.github.lineageId ||
    feishuDistinct.externalEventId !== manifest.isolation.feishuDistinctEvent.eventId ||
    feishuDistinct.externalEventDigest !== manifest.isolation.feishuDistinctEvent.eventDigest ||
    feishuDistinct.requestDigest !== manifest.isolation.feishuDistinctEvent.requestDigest ||
    feishuDistinct.reasonCode !== manifest.isolation.feishuDistinctEvent.expectedReason ||
    githubMutation.externalEventId !== manifest.github.externalEventId ||
    githubMutation.externalEventDigest !== manifest.github.externalEventDigest ||
    githubMutation.requestDigest !== manifest.isolation.githubSnapshotMutation.requestDigest ||
    githubMutation.reasonCode !== manifest.isolation.githubSnapshotMutation.expectedReason
  ) throw new ApprovalLineageEvidenceVerificationError('replay_observation_mismatch');
  return report;
}

function assertGitHubFact(
  fact: GitHubApprovalIdentityFact,
  manifest: ApprovalLineageEvidenceManifestV1,
): void {
  const github = manifest.github;
  const matches = fact.reviews.filter((review) => review.id === github.reviewId);
  if (
    fact.repository !== manifest.repository || fact.number !== github.pullRequestNumber ||
    fact.authorLogin !== manifest.identity.pullRequestAuthorLogin ||
    fact.headBranch !== github.headBranch || fact.baseBranch !== github.baseBranch ||
    fact.headSha !== github.headSha || matches.length !== 1 ||
    matches[0]!.login !== github.reviewerLogin || matches[0]!.state !== 'APPROVED' ||
    matches[0]!.commitId !== github.headSha ||
    matches[0]!.submittedAt !== github.reviewSubmittedAt
  ) throw new ApprovalLineageEvidenceVerificationError('github_fact_mismatch');
}

export async function verifyApprovalLineageEvidence(
  input: ApprovalLineageEvidenceManifestV1,
  options: ApprovalLineageEvidenceVerifierOptions,
): Promise<ApprovalLineageEvidenceVerificationSummary> {
  const parsed = ApprovalLineageEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new ApprovalLineageEvidenceVerificationError('manifest_invalid');
  const manifest = parsed.data;
  if (
    !TOKEN_PATTERN.test(options.operationsToken) ||
    !TOKEN_PATTERN.test(options.observabilityToken) ||
    !TOKEN_PATTERN.test(options.githubToken) || !CANARY_PATTERN.test(options.canary) ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    manifest.safety.canaryDigest !== await canonicalSha256(options.canary)
  ) throw new ApprovalLineageEvidenceVerificationError('configuration_invalid');
  if (
    manifest.identity.rolesDigest !== await canonicalSha256(manifest.identity.roles) ||
    manifest.identity.principalDigest !== await canonicalSha256(manifest.identity.principal)
  ) throw new ApprovalLineageEvidenceVerificationError('cross_provider_binding_mismatch');
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const reportUrl = httpsUrl(options.observabilityReportUrl);
  const githubApiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  if (
    httpsOrigin(manifest.controlPlaneOrigin) !== controlPlaneOrigin ||
    httpsUrl(manifest.observabilityReportUrl) !== reportUrl
  ) throw new ApprovalLineageEvidenceVerificationError('configuration_invalid');

  const fetcher = options.fetcher ?? fetch;
  const scanner = new SecretScanner({
    secrets: [
      options.operationsToken,
      options.observabilityToken,
      options.githubToken,
      options.canary,
    ],
  });
  const reportRaw = await getJson(
    fetcher, reportUrl, options.observabilityToken, 'observability', scanner,
  );
  await validateReport(reportRaw, manifest);
  const auditRaw = await getJson(
    fetcher,
    `${controlPlaneOrigin}/v1/runs/${manifest.snapshot.runId}/audit`,
    options.operationsToken,
    'control_plane',
    scanner,
  );
  await validateAudit(auditRaw, manifest);

  const feishuUrl = `${controlPlaneOrigin}/v1/operations/feishu-card-action/evidence`;
  const feishuRaw = await getJson(
    fetcher,
    `${feishuUrl}?tenantKey=${encodeURIComponent(manifest.feishu.tenantKey)}` +
      `&eventId=${encodeURIComponent(manifest.feishu.externalEventId)}`,
    options.operationsToken,
    'control_plane',
    scanner,
  );
  await validateFeishuPrimary(feishuRaw, manifest);
  const isolationRaw = await getJson(
    fetcher,
    `${feishuUrl}?tenantKey=${encodeURIComponent(manifest.feishu.tenantKey)}` +
      `&eventId=${encodeURIComponent(manifest.isolation.feishuDistinctEvent.eventId)}`,
    options.operationsToken,
    'control_plane',
    scanner,
  );
  validateFeishuIsolation(isolationRaw, manifest);

  const scanningFetch: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init);
    const copy = response.clone();
    const text = await boundedText(copy);
    if (text === null) {
      throw new ApprovalLineageEvidenceVerificationError('github_fact_mismatch');
    }
    if (scanner.scanText(text, '$.github').length > 0) {
      throw new ApprovalLineageEvidenceVerificationError('secret_leak_detected');
    }
    return response;
  };
  const github = new GitHubMergeGateApiClient(
    { getMergeObservationToken: async () => options.githubToken },
    { apiBaseUrl: githubApiOrigin, fetch: scanningFetch },
  );
  let fact: GitHubApprovalIdentityFact;
  try {
    fact = await github.observeApprovalIdentity({
      repository: manifest.repository,
      number: manifest.github.pullRequestNumber,
      headBranch: manifest.github.headBranch,
      baseBranch: manifest.github.baseBranch,
    });
  } catch (error) {
    if (error instanceof ApprovalLineageEvidenceVerificationError) throw error;
    throw new ApprovalLineageEvidenceVerificationError('github_api_unavailable');
  }
  assertGitHubFact(fact, manifest);

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    repository: manifest.repository,
    runId: manifest.snapshot.runId,
    providerApprovals: 2,
    independentLineages: 2,
    sameHumanPrincipal: 'verified',
    exactSnapshotBinding: 'verified',
    replayConvergence: 'verified',
    eventAndSnapshotIsolation: 'verified',
    mergeEffects: 0,
    plaintextLeaks: 0,
    humanReview: 'required_and_recorded',
  };
}
