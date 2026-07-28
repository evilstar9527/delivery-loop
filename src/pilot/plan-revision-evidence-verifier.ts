import { canonicalSha256 } from '../domain/digest.js';
import {
  PlanRevisionEvidenceManifestV1Schema,
  type PlanRevisionEvidenceManifestV1,
} from '../domain/plan-revision-evidence.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type PlanRevisionEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_action_mismatch'
  | 'github_source_mismatch';

export class PlanRevisionEvidenceVerificationError extends Error {
  constructor(readonly code: PlanRevisionEvidenceVerificationErrorCode) {
    super(`Plan revision evidence verification failed: ${code}`);
    this.name = 'PlanRevisionEvidenceVerificationError';
  }
}

export interface PlanRevisionEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface PlanRevisionEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  runId: string;
  repository: string;
  sourceKind: 'review_feedback' | 'supplemental_context' | 'base_update';
  priorPlan: 'superseded';
  newPlan: 'active';
  oldApproval: 'invalidated';
  freshApproval: 'verified';
  analysisAction: 'verified';
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

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PlanRevisionEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new PlanRevisionEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

async function readBoundedResponse(response: Response): Promise<string | null> {
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

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  source: 'control_plane' | 'github',
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
    });
  } catch {
    throw new PlanRevisionEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  const invalidCode = source === 'control_plane'
    ? 'control_plane_response_invalid'
    : 'github_response_invalid';
  if (!response.ok) {
    await response.body?.cancel();
    throw new PlanRevisionEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new PlanRevisionEvidenceVerificationError(invalidCode);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new PlanRevisionEvidenceVerificationError(invalidCode);
  }
  let text: string | null;
  try {
    text = await readBoundedResponse(response);
  } catch {
    throw new PlanRevisionEvidenceVerificationError(invalidCode);
  }
  if (text === null) throw new PlanRevisionEvidenceVerificationError(invalidCode);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PlanRevisionEvidenceVerificationError(invalidCode);
  }
}

async function sameCanonical(left: unknown, right: unknown): Promise<boolean> {
  return await canonicalSha256(left) === await canonicalSha256(right);
}

export async function verifyPlanRevisionEvidence(
  input: PlanRevisionEvidenceManifestV1,
  options: PlanRevisionEvidenceVerifierOptions,
): Promise<PlanRevisionEvidenceVerificationSummary> {
  const parsed = PlanRevisionEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new PlanRevisionEvidenceVerificationError('manifest_invalid');
  if (!TOKEN_PATTERN.test(options.controlPlaneToken) || !TOKEN_PATTERN.test(options.githubToken)) {
    throw new PlanRevisionEvidenceVerificationError('configuration_invalid');
  }
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubApiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const audit = record(await getJson(
    fetcher,
    `${controlPlaneOrigin}/v1/runs/${input.runId}/audit`,
    options.controlPlaneToken,
    'control_plane',
  ));
  const run = audit === null ? null : record(audit.run);
  const task = audit === null ? null : record(audit.task);
  const target = task === null ? null : record(task.target);
  const answers = audit === null ? null : record(audit.answers);
  const checks = answers === null ? null : record(answers.checks);
  const revisions = checks === null ? [] : rows(checks, 'planRevisions').filter((revision) =>
    revision.revisionId === input.revision.revisionId,
  );
  const attempts = answers === null ? [] : rows(record(answers.who) ?? {}, 'attempts').filter(
    (attempt) => attempt.attemptId === input.revision.analysisAttemptId,
  );
  const sourceEvents = answers === null ? [] : rows(answers, 'sourceEvents').filter((event) =>
    event.kind === 'plan_revision' && event.sourceKind === input.source.kind &&
    event.digest === input.source.digest,
  );
  const approvals = answers === null ? [] : rows(answers, 'approvals');
  const digests = audit === null ? null : record(audit.digests);
  const plans = digests === null ? [] : rows(digests, 'plans');
  const priorPlans = plans.filter((plan) => plan.planId === input.revision.priorPlan.id);
  const newPlans = plans.filter((plan) => plan.planId === input.revision.newPlan.id);
  if (
    audit === null || audit.schemaVersion !== '1' || run?.id !== input.runId ||
    target?.repository !== input.repository || revisions.length !== 1 || attempts.length !== 1 ||
    sourceEvents.length !== 1 || priorPlans.length !== 1 || newPlans.length !== 1 ||
    run.activePlanId !== input.revision.newPlan.id ||
    run.activePlanVersion !== input.revision.newPlan.version ||
    run.activePlanDigest !== input.revision.newPlan.digest ||
    run.baseSha !== input.revision.newPlan.baseSha
  ) throw new PlanRevisionEvidenceVerificationError('control_plane_projection_mismatch');
  const revision = revisions[0]!;
  const attempt = attempts[0]!;
  const priorPlan = priorPlans[0]!;
  const newPlan = newPlans[0]!;
  if (
    revision.expectedRunVersion !== input.revision.expectedRunVersion ||
    revision.status !== 'activated' || revision.sourceKind !== input.source.kind ||
    revision.sourceRecordId !== input.source.recordId ||
    revision.sourceDigest !== input.source.digest ||
    revision.requestedBaseSha !== input.revision.newPlan.baseSha ||
    revision.analysisAttemptId !== input.revision.analysisAttemptId ||
    !await sameCanonical(revision.priorPlan, input.revision.priorPlan) ||
    !await sameCanonical(revision.newPlan, input.revision.newPlan) ||
    !await sameCanonical(revision.changes, input.revision.changes) ||
    !await sameCanonical(revision.source, input.source) ||
    revision.activatedAt !== input.revision.activatedAt ||
    priorPlan.version !== input.revision.priorPlan.version ||
    priorPlan.digest !== input.revision.priorPlan.digest ||
    priorPlan.status !== 'superseded' || priorPlan.baseSha !== input.revision.priorPlan.baseSha ||
    newPlan.version !== input.revision.newPlan.version ||
    newPlan.digest !== input.revision.newPlan.digest || newPlan.status !== 'active' ||
    newPlan.baseSha !== input.revision.newPlan.baseSha ||
    attempt.mode !== 'analysis' || attempt.status !== 'completed' ||
    attempt.baseSha !== input.analysisAction.headSha ||
    attempt.githubRunId !== input.analysisAction.githubRunId ||
    attempt.githubStatus !== input.analysisAction.status ||
    attempt.githubConclusion !== input.analysisAction.conclusion
  ) throw new PlanRevisionEvidenceVerificationError('control_plane_projection_mismatch');
  for (const expected of input.approvals.invalidated) {
    const found = approvals.filter((approval) => approval.approvalId === expected.approvalId);
    if (
      found.length !== 1 || found[0]!.effect !== expected.effect ||
      found[0]!.planId !== input.revision.priorPlan.id ||
      found[0]!.planVersion !== input.revision.priorPlan.version ||
      found[0]!.planDigest !== input.revision.priorPlan.digest ||
      found[0]!.baseSha !== input.revision.priorPlan.baseSha || found[0]!.invalidated !== true
    ) throw new PlanRevisionEvidenceVerificationError('control_plane_projection_mismatch');
  }
  const priorApprovalRows = approvals.filter((approval) =>
    approval.planId === input.revision.priorPlan.id,
  );
  if (priorApprovalRows.length !== input.approvals.invalidated.length) {
    throw new PlanRevisionEvidenceVerificationError('control_plane_projection_mismatch');
  }
  for (const expected of input.approvals.fresh) {
    const found = approvals.filter((approval) => approval.approvalId === expected.approvalId);
    if (
      found.length !== 1 || found[0]!.effect !== expected.effect ||
      found[0]!.decision !== 'approve' || found[0]!.approver !== expected.approver ||
      found[0]!.provider !== expected.provider ||
      found[0]!.externalEventId !== expected.externalEventId ||
      found[0]!.eventDigest !== expected.eventDigest ||
      found[0]!.expiresAt !== expected.expiresAt || found[0]!.invalidated !== false ||
      found[0]!.planId !== input.revision.newPlan.id ||
      found[0]!.planVersion !== input.revision.newPlan.version ||
      found[0]!.planDigest !== input.revision.newPlan.digest ||
      found[0]!.baseSha !== input.revision.newPlan.baseSha
    ) throw new PlanRevisionEvidenceVerificationError('control_plane_projection_mismatch');
  }
  const freshApprovalRows = approvals.filter((approval) =>
    approval.planId === input.revision.newPlan.id && approval.invalidated === false,
  );
  if (freshApprovalRows.length !== input.approvals.fresh.length) {
    throw new PlanRevisionEvidenceVerificationError('control_plane_projection_mismatch');
  }

  const action = record(await getJson(
    fetcher,
    `${githubApiOrigin}/repos/${input.repository}/actions/runs/${input.analysisAction.githubRunId}`,
    options.githubToken,
    'github',
  ));
  const actionRepository = action === null ? null : record(action.repository);
  if (
    action === null || String(action.id) !== input.analysisAction.githubRunId ||
    action.status !== input.analysisAction.status ||
    action.conclusion !== input.analysisAction.conclusion ||
    action.head_sha !== input.analysisAction.headSha ||
    action.head_branch !== input.analysisAction.headBranch ||
    action.path !== input.analysisAction.workflowPath ||
    action.display_title !== input.analysisAction.displayTitle ||
    action.run_attempt !== input.analysisAction.runAttempt ||
    actionRepository?.full_name !== input.repository
  ) throw new PlanRevisionEvidenceVerificationError('github_action_mismatch');

  if (input.source.kind === 'base_update') {
    const branch = input.source.baseBranch.split('/').map(encodeURIComponent).join('/');
    const reference = record(await getJson(
      fetcher,
      `${githubApiOrigin}/repos/${input.repository}/git/ref/heads/${branch}`,
      options.githubToken,
      'github',
    ));
    const referenceObject = reference === null ? null : record(reference.object);
    if (
      reference?.ref !== `refs/heads/${input.source.baseBranch}` ||
      referenceObject?.type !== 'commit' || referenceObject.sha !== input.source.afterSha
    ) throw new PlanRevisionEvidenceVerificationError('github_source_mismatch');
    const referenceDigest = await canonicalSha256({
      ref: reference.ref, objectType: referenceObject.type, sha: referenceObject.sha,
    });
    const comparison = record(await getJson(
      fetcher,
      `${githubApiOrigin}/repos/${input.repository}/compare/` +
        `${input.source.beforeSha}...${input.source.afterSha}`,
      options.githubToken,
      'github',
    ));
    const baseCommit = comparison === null ? null : record(comparison.base_commit);
    const mergeBase = comparison === null ? null : record(comparison.merge_base_commit);
    if (
      comparison?.status !== 'ahead' || comparison.ahead_by !== input.source.aheadBy ||
      comparison.behind_by !== 0 || baseCommit?.sha !== input.source.beforeSha ||
      mergeBase?.sha !== input.source.beforeSha
    ) throw new PlanRevisionEvidenceVerificationError('github_source_mismatch');
    const comparisonDigest = await canonicalSha256({
      status: comparison.status, aheadBy: comparison.ahead_by,
      behindBy: comparison.behind_by, baseCommitSha: baseCommit.sha,
      mergeBaseCommitSha: mergeBase.sha, comparedHeadSha: input.source.afterSha,
    });
    const sourceDigest = await canonicalSha256({
      schemaVersion: '1', repository: input.source.repository,
      baseBranch: input.source.baseBranch, beforeSha: input.source.beforeSha,
      afterSha: input.source.afterSha, relationship: 'ahead', aheadBy: input.source.aheadBy,
      referenceDigest, comparisonDigest,
    });
    if (
      referenceDigest !== input.source.referenceDigest ||
      comparisonDigest !== input.source.comparisonDigest || sourceDigest !== input.source.digest
    ) throw new PlanRevisionEvidenceVerificationError('github_source_mismatch');
  } else if (input.source.kind === 'review_feedback') {
    const reviewSource = input.source;
    const reviews = await getJson(
      fetcher,
      `${githubApiOrigin}/repos/${input.repository}/pulls/` +
        `${reviewSource.pullRequestNumber}/reviews?per_page=100`,
      options.githubToken,
      'github',
    );
    if (!Array.isArray(reviews)) {
      throw new PlanRevisionEvidenceVerificationError('github_response_invalid');
    }
    const matching = reviews.map(record).filter((review): review is Record<string, unknown> =>
      review !== null && String(review.id) === reviewSource.reviewId,
    );
    const review = matching.length === 1 ? matching[0]! : null;
    if (
      review === null || String(review.state).toLowerCase() !== 'changes_requested' ||
      review.commit_id !== reviewSource.reviewedHeadSha ||
      safeUrl(review.html_url) !== reviewSource.reviewUrl || typeof review.body !== 'string' ||
      await canonicalSha256(review.body) !== reviewSource.bodyDigest
    ) throw new PlanRevisionEvidenceVerificationError('github_source_mismatch');
  }

  return {
    schemaVersion: '1', evidenceId: input.evidenceId, runId: input.runId,
    repository: input.repository, sourceKind: input.source.kind,
    priorPlan: 'superseded', newPlan: 'active', oldApproval: 'invalidated',
    freshApproval: 'verified', analysisAction: 'verified',
  };
}
