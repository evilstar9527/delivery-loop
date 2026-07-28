import { canonicalSha256 } from '../domain/digest.js';
import {
  GitHubReviewFeedbackEvidenceManifestV1Schema,
  type GitHubReviewFeedbackEvidenceManifestV1,
} from '../domain/github-review-feedback-evidence.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type GitHubReviewFeedbackEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_review_mismatch'
  | 'github_action_mismatch'
  | 'github_job_mismatch'
  | 'github_commit_mismatch'
  | 'github_ref_mismatch'
  | 'github_compare_mismatch'
  | 'github_checks_mismatch'
  | 'secret_leak_detected';

export class GitHubReviewFeedbackEvidenceVerificationError extends Error {
  constructor(readonly code: GitHubReviewFeedbackEvidenceVerificationErrorCode) {
    super(`GitHub review feedback evidence verification failed: ${code}`);
    this.name = 'GitHubReviewFeedbackEvidenceVerificationError';
  }
}

export interface GitHubReviewFeedbackEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  canary: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface GitHubReviewFeedbackEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  runId: string;
  repository: string;
  appliedReview: 'verified';
  staleReview: 'ignored';
  replacementAttempt: 'verified';
  planItem: 'verified';
  commit: 'verified';
  verificationSuite: 'verified';
  githubAction: 'verified';
  githubJob: 'verified';
  githubChecks: 'all_success';
  githubCheckCount: number;
  resultHeadSha: string;
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

function normalizedDate(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    throw new GitHubReviewFeedbackEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new GitHubReviewFeedbackEvidenceVerificationError('configuration_invalid');
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
  scanner: SecretScanner,
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
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GitHubReviewFeedbackEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  const invalidCode = source === 'control_plane'
    ? 'control_plane_response_invalid'
    : 'github_response_invalid';
  if (!response.ok) {
    await response.body?.cancel();
    throw new GitHubReviewFeedbackEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new GitHubReviewFeedbackEvidenceVerificationError(invalidCode);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new GitHubReviewFeedbackEvidenceVerificationError(invalidCode);
  }
  let text: string | null;
  try {
    text = await readBoundedResponse(response);
  } catch {
    throw new GitHubReviewFeedbackEvidenceVerificationError(invalidCode);
  }
  if (text === null) throw new GitHubReviewFeedbackEvidenceVerificationError(invalidCode);
  if (scanner.scanText(text, `$.${source}`).length > 0) {
    throw new GitHubReviewFeedbackEvidenceVerificationError('secret_leak_detected');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubReviewFeedbackEvidenceVerificationError(invalidCode);
  }
}

function apiObject(value: unknown, key: string): Record<string, unknown> | null {
  const parent = record(value);
  const nested = parent?.[key];
  return record(nested);
}

export async function verifyGitHubReviewFeedbackEvidence(
  input: GitHubReviewFeedbackEvidenceManifestV1,
  options: GitHubReviewFeedbackEvidenceVerifierOptions,
): Promise<GitHubReviewFeedbackEvidenceVerificationSummary> {
  const parsed = GitHubReviewFeedbackEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new GitHubReviewFeedbackEvidenceVerificationError('manifest_invalid');
  }
  if (
    !TOKEN_PATTERN.test(options.controlPlaneToken) || !TOKEN_PATTERN.test(options.githubToken) ||
    !CANARY_PATTERN.test(options.canary) ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    parsed.data.safety.canaryDigest !== await canonicalSha256(options.canary)
  ) {
    throw new GitHubReviewFeedbackEvidenceVerificationError('configuration_invalid');
  }
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubApiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const scanner = new SecretScanner({
    secrets: [options.controlPlaneToken, options.githubToken, options.canary],
  });
  const manifest = parsed.data;
  const p = manifest.publication;
  const applied = manifest.appliedReview;
  const stale = manifest.staleReview;
  const replacement = manifest.replacement;
  const expectedPlan = manifest.plan;
  const [planRaw, auditRaw] = await Promise.all([
    getJson(
      fetcher,
      `${controlPlaneOrigin}/v1/runs/${manifest.runId}/plan`,
      options.controlPlaneToken,
      'control_plane',
      scanner,
    ),
    getJson(
      fetcher,
      `${controlPlaneOrigin}/v1/runs/${manifest.runId}/audit`,
      options.controlPlaneToken,
      'control_plane',
      scanner,
    ),
  ]);

  const planRoot = record(planRaw);
  const planRun = planRoot === null ? null : record(planRoot.run);
  const plan = planRoot === null ? null : record(planRoot.plan);
  const planItems = planRoot === null ? [] : rows(planRoot, 'items');
  const planAttempts = planRoot === null ? [] : rows(planRoot, 'attempts');
  const planEvidence = planRoot === null ? [] : rows(planRoot, 'evidence');
  const planItemMatches = planItems.filter((item) => item.id === expectedPlan.itemId);
  const planItem = planItemMatches[0];
  const decision = planItem === undefined ? null : record(planItem.verificationDecision);
  const priorPlanAttempts = planAttempts.filter((attempt) =>
    attempt.id === replacement.priorAttemptId);
  const replacementPlanAttempts = planAttempts.filter((attempt) =>
    attempt.id === replacement.attemptId);
  const priorPlanAttempt = priorPlanAttempts[0];
  const replacementPlanAttempt = replacementPlanAttempts[0];
  const expectedEvidenceIds = replacement.itemVerification.evidenceIds;
  if (
    planRoot === null || planRun === null || plan === null ||
    planRun.id !== manifest.runId || planRun.state !== 'executing' ||
    plan.id !== expectedPlan.planId || plan.version !== expectedPlan.version ||
    plan.digest !== expectedPlan.digest || plan.baseSha !== expectedPlan.baseSha ||
    plan.status !== 'active' || planItemMatches.length !== 1 ||
    planItem?.kind !== 'change' || planItem.required !== true || planItem.status !== 'passed' ||
    planItem.progressVersion !== replacement.claimedProgressVersion + 2 ||
    !Array.isArray(planItem.commandRefs) ||
    JSON.stringify([...planItem.commandRefs].sort()) !== JSON.stringify(
      replacement.testSuite.commands.map((command) => command.commandRef).sort(),
    ) ||
    !Array.isArray(planItem.effects) || !planItem.effects.includes('repo_write') ||
    decision === null || decision.id !== replacement.itemVerification.verificationId ||
    decision.headSha !== replacement.resultHeadSha ||
    decision.evidenceSetDigest !== replacement.itemVerification.evidenceSetDigest ||
    !Array.isArray(decision.evidenceIds) ||
    JSON.stringify([...decision.evidenceIds].sort()) !== JSON.stringify([...expectedEvidenceIds].sort()) ||
    priorPlanAttempts.length !== 1 || replacementPlanAttempts.length !== 1 ||
    priorPlanAttempt?.mode !== 'implement' || priorPlanAttempt.status !== 'completed' ||
    priorPlanAttempt.planId !== expectedPlan.planId ||
    priorPlanAttempt.planVersion !== expectedPlan.version ||
    priorPlanAttempt.planItemId !== expectedPlan.itemId ||
    priorPlanAttempt.headBranch !== replacement.branch ||
    priorPlanAttempt.headSha !== replacement.checkoutSha ||
    replacementPlanAttempt?.mode !== 'review_fix' ||
    replacementPlanAttempt.status !== 'completed' ||
    replacementPlanAttempt.planId !== expectedPlan.planId ||
    replacementPlanAttempt.planVersion !== expectedPlan.version ||
    replacementPlanAttempt.planItemId !== expectedPlan.itemId ||
    replacementPlanAttempt.headBranch !== replacement.branch ||
    replacementPlanAttempt.headSha !== replacement.resultHeadSha ||
    replacementPlanAttempt.githubRunId !== replacement.actionRunId ||
    replacementPlanAttempt.githubStatus !== replacement.actionStatus ||
    replacementPlanAttempt.githubConclusion !== replacement.actionConclusion
  ) throw new GitHubReviewFeedbackEvidenceVerificationError('control_plane_projection_mismatch');
  for (const evidenceId of expectedEvidenceIds) {
    const matches = planEvidence.filter((evidence) => evidence.id === evidenceId);
    const evidence = matches[0];
    const command = replacement.testSuite.commands.find((item) => item.evidenceId === evidenceId);
    const isCommit = evidenceId === replacement.commitEvidenceId;
    if (
      matches.length !== 1 || evidence?.attemptId !== replacement.attemptId ||
      evidence.planId !== expectedPlan.planId || evidence.planVersion !== expectedPlan.version ||
      evidence.planItemId !== expectedPlan.itemId ||
      evidence.kind !== (isCommit ? 'commit' : 'test') || evidence.status !== 'passed' ||
      evidence.verificationStatus !== 'verified' || evidence.sha !== replacement.resultHeadSha ||
      (!isCommit && (command === undefined || evidence.commandRef !== command.commandRef ||
        evidence.exitCode !== 0))
    ) throw new GitHubReviewFeedbackEvidenceVerificationError('control_plane_projection_mismatch');
  }

  const audit = record(auditRaw);
  const run = audit === null ? null : record(audit.run);
  const task = audit === null ? null : record(audit.task);
  const answers = audit === null ? null : record(audit.answers);
  const changes = answers === null ? [] : rows(answers, 'changes');
  const checks = answers === null ? null : record(answers.checks);
  const observations = checks === null ? [] : rows(checks, 'reviewObservations');
  const attempts = answers === null ? [] : rows(record(answers.who) ?? {}, 'attempts');
  const commands = checks === null ? [] : rows(checks, 'commands');
  const verifications = checks === null ? [] : rows(checks, 'itemVerifications');
  const evidence = checks === null ? [] : rows(checks, 'evidence');
  const reportBody = audit === null ? null : Object.fromEntries(Object.entries(audit).filter(
    ([key]) => key !== 'generatedAt' && key !== 'queryDurationMs' && key !== 'reportDigest',
  ));
  const publication = changes.filter((change) =>
    change.kind === 'pull_request' && change.publicationId === p.publicationId,
  );
  const replacementCommits = changes.filter((change) =>
    change.kind === 'commit' && change.attemptId === replacement.attemptId);
  const appliedRows = observations.filter((observation) =>
    observation.sourceKind === 'webhook' &&
    observation.sourceId === applied.deliveryId &&
    observation.publicationId === p.publicationId &&
    observation.githubReviewId === applied.reviewId,
  );
  const staleRows = observations.filter((observation) =>
    observation.sourceKind === 'webhook' &&
    observation.sourceId === stale.deliveryId &&
    observation.publicationId === p.publicationId &&
    observation.githubReviewId === stale.reviewId,
  );
  const replacementRows = attempts.filter((attempt) =>
    attempt.attemptId === replacement.attemptId,
  );
  const priorRows = attempts.filter((attempt) => attempt.attemptId === replacement.priorAttemptId);
  if (
    audit === null || audit.schemaVersion !== '1' || audit.runId !== manifest.runId ||
    reportBody === null || audit.reportDigest !== manifest.case8ReportDigest ||
    await canonicalSha256(reportBody) !== manifest.case8ReportDigest ||
    run?.state !== 'executing' || run.baseSha !== expectedPlan.baseSha ||
    run.activePlanId !== expectedPlan.planId || run.activePlanVersion !== expectedPlan.version ||
    run.activePlanDigest !== expectedPlan.digest || task?.repository !== manifest.repository ||
    publication.length !== 1 || appliedRows.length !== 1 || staleRows.length !== 1 ||
    replacementRows.length !== 1 || priorRows.length !== 1 || replacementCommits.length !== 1
  ) throw new GitHubReviewFeedbackEvidenceVerificationError('control_plane_projection_mismatch');
  const change = publication[0]!;
  const appliedRow = appliedRows[0]!;
  const staleRow = staleRows[0]!;
  const replacementRow = replacementRows[0]!;
  const priorRow = priorRows[0]!;
  const commitRow = replacementCommits[0]!;
  const priorUpdatedAt = timestamp(priorRow.updatedAt);
  const replacementCreatedAt = timestamp(replacementRow.createdAt);
  const replacementUpdatedAt = timestamp(replacementRow.updatedAt);
  const commitCreatedAt = timestamp(commitRow.createdAt);
  if (
    change.status !== 'verified' || change.repository !== manifest.repository ||
    change.baseBranch !== p.baseBranch || change.headBranch !== p.headBranch ||
    change.headSha !== p.reviewedHeadSha || change.number !== p.number ||
    safeUrl(change.url) !== p.url ||
    appliedRow.processingState !== 'applied' ||
    appliedRow.factDigest !== applied.payloadDigest ||
    appliedRow.reviewedHeadSha !== applied.reviewedHeadSha ||
    appliedRow.feedbackId !== applied.feedbackId ||
    appliedRow.priorAttemptId !== applied.priorAttemptId ||
    appliedRow.reviewAttemptId !== applied.reviewAttemptId ||
    appliedRow.sourceHeadSha !== applied.reviewedHeadSha ||
    appliedRow.branch !== applied.branch ||
    safeUrl(appliedRow.reviewUrl) !== applied.reviewUrl ||
    appliedRow.bodyDigest !== applied.bodyDigest ||
    appliedRow.repository !== manifest.repository || appliedRow.githubPrNumber !== p.number ||
    appliedRow.submittedAt !== applied.submittedAt ||
    appliedRow.observedAt !== applied.receivedAt ||
    appliedRow.processedAt !== applied.processedAt ||
    staleRow.processingState !== 'ignored' || staleRow.ignoreReason !== 'stale_head' ||
    staleRow.factDigest !== stale.payloadDigest ||
    staleRow.reviewedHeadSha !== stale.reviewedHeadSha ||
    staleRow.repository !== manifest.repository || staleRow.githubPrNumber !== p.number ||
    staleRow.observedAt !== stale.receivedAt || staleRow.processedAt !== stale.processedAt ||
    staleRow.feedbackId !== null || staleRow.priorAttemptId !== null ||
    staleRow.reviewAttemptId !== null || staleRow.sourceHeadSha !== null ||
    staleRow.branch !== null || staleRow.reviewUrl !== null || staleRow.submittedAt !== null ||
    staleRow.bodyDigest !== null ||
    priorRow.mode !== 'implement' || priorRow.status !== 'completed' ||
    priorRow.repository !== manifest.repository || priorRow.planId !== expectedPlan.planId ||
    priorRow.planVersion !== expectedPlan.version || priorRow.itemId !== expectedPlan.itemId ||
    priorRow.baseSha !== expectedPlan.baseSha || priorRow.headSha !== p.reviewedHeadSha ||
    !Number.isSafeInteger(priorRow.ordinal) || !Number.isSafeInteger(replacementRow.ordinal) ||
    Number(replacementRow.ordinal) !== Number(priorRow.ordinal) + 1 ||
    replacementRow.mode !== 'review_fix' || replacementRow.status !== 'completed' ||
    replacementRow.repository !== manifest.repository ||
    replacementRow.planId !== expectedPlan.planId ||
    replacementRow.planVersion !== expectedPlan.version ||
    replacementRow.itemId !== expectedPlan.itemId ||
    replacementRow.claimedProgressVersion !== replacement.claimedProgressVersion ||
    replacementRow.baseSha !== expectedPlan.baseSha ||
    replacementRow.headSha !== replacement.resultHeadSha ||
    replacementRow.githubRunId !== replacement.actionRunId ||
    replacementRow.githubStatus !== replacement.actionStatus ||
    replacementRow.githubConclusion !== replacement.actionConclusion ||
    commitRow.updateId !== replacement.updateId ||
    commitRow.planId !== expectedPlan.planId || commitRow.planVersion !== expectedPlan.version ||
    commitRow.itemId !== expectedPlan.itemId || commitRow.parentSha !== replacement.checkoutSha ||
    commitRow.headSha !== replacement.resultHeadSha || commitRow.branch !== replacement.branch ||
    commitRow.evidenceId !== replacement.commitEvidenceId ||
    priorUpdatedAt === null || replacementCreatedAt === null || replacementUpdatedAt === null ||
    commitCreatedAt === null || replacementCreatedAt < Date.parse(applied.processedAt) ||
    replacementCreatedAt < priorUpdatedAt || commitCreatedAt < replacementCreatedAt ||
    commitCreatedAt > replacementUpdatedAt
  ) throw new GitHubReviewFeedbackEvidenceVerificationError('control_plane_projection_mismatch');

  const replacementCommands = commands.filter((command) =>
    command.attemptId === replacement.attemptId);
  if (replacementCommands.length !== replacement.testSuite.commands.length) {
    throw new GitHubReviewFeedbackEvidenceVerificationError('control_plane_projection_mismatch');
  }
  for (const expected of replacement.testSuite.commands) {
    const matches = replacementCommands.filter((command) =>
      command.suiteId === replacement.testSuite.suiteId && command.position === expected.position);
    const command = matches[0];
    const evidenceMatches = evidence.filter((item) => item.evidenceId === expected.evidenceId);
    const evidenceRow = evidenceMatches[0];
    if (
      matches.length !== 1 || command?.planId !== expectedPlan.planId ||
      command.planVersion !== expectedPlan.version || command.itemId !== expectedPlan.itemId ||
      command.headSha !== replacement.resultHeadSha ||
      command.deliveryPolicyDigest !== replacement.testSuite.deliveryPolicyDigest ||
      command.suiteStatus !== 'completed' || command.phase !== expected.phase ||
      command.commandRef !== expected.commandRef || command.status !== 'passed' ||
      command.evidenceId !== expected.evidenceId || evidenceMatches.length !== 1 ||
      evidenceRow?.attemptId !== replacement.attemptId || evidenceRow.planId !== expectedPlan.planId ||
      evidenceRow.planVersion !== expectedPlan.version || evidenceRow.itemId !== expectedPlan.itemId ||
      evidenceRow.kind !== 'test' || evidenceRow.status !== 'passed' ||
      evidenceRow.verificationStatus !== 'verified' ||
      evidenceRow.commandRef !== expected.commandRef || evidenceRow.exitCode !== 0 ||
      evidenceRow.sha !== replacement.resultHeadSha
    ) throw new GitHubReviewFeedbackEvidenceVerificationError('control_plane_projection_mismatch');
  }
  const commitEvidence = evidence.filter((item) => item.evidenceId === replacement.commitEvidenceId);
  const verification = verifications.filter((item) =>
    item.verificationId === replacement.itemVerification.verificationId);
  if (
    commitEvidence.length !== 1 || commitEvidence[0]!.attemptId !== replacement.attemptId ||
    commitEvidence[0]!.planId !== expectedPlan.planId ||
    commitEvidence[0]!.planVersion !== expectedPlan.version ||
    commitEvidence[0]!.itemId !== expectedPlan.itemId || commitEvidence[0]!.kind !== 'commit' ||
    commitEvidence[0]!.status !== 'passed' ||
    commitEvidence[0]!.verificationStatus !== 'verified' ||
    commitEvidence[0]!.sha !== replacement.resultHeadSha || verification.length !== 1 ||
    verification[0]!.planId !== expectedPlan.planId ||
    verification[0]!.planVersion !== expectedPlan.version ||
    verification[0]!.itemId !== expectedPlan.itemId ||
    verification[0]!.attemptId !== replacement.attemptId ||
    verification[0]!.headSha !== replacement.resultHeadSha ||
    verification[0]!.evidenceSetDigest !== replacement.itemVerification.evidenceSetDigest ||
    verification[0]!.status !== 'passed'
  ) throw new GitHubReviewFeedbackEvidenceVerificationError('control_plane_projection_mismatch');

  const pr = record(await getJson(
    fetcher,
    `${githubApiOrigin}/repos/${manifest.repository}/pulls/${p.number}`,
    options.githubToken,
    'github',
    scanner,
  ));
  const head = apiObject(pr, 'head');
  const base = apiObject(pr, 'base');
  if (
    pr === null || pr.number !== p.number || pr.state !== 'open' || pr.draft !== true ||
    safeUrl(pr.html_url) !== p.url || head?.ref !== replacement.branch ||
    head.sha !== replacement.resultHeadSha ||
    record(head.repo)?.full_name !== manifest.repository || base?.ref !== p.baseBranch ||
    record(base.repo)?.full_name !== manifest.repository
  ) throw new GitHubReviewFeedbackEvidenceVerificationError('github_review_mismatch');

  const reviewList = await getJson(
    fetcher,
    `${githubApiOrigin}/repos/${manifest.repository}/pulls/${p.number}/reviews?per_page=100`,
    options.githubToken,
    'github',
    scanner,
  );
  if (!Array.isArray(reviewList)) {
    throw new GitHubReviewFeedbackEvidenceVerificationError('github_response_invalid');
  }
  const reviews = reviewList.filter((value): value is Record<string, unknown> =>
    record(value)?.id !== undefined && String(record(value)?.id) === applied.reviewId,
  );
  const liveReview = reviews.length === 1 ? reviews[0]! : null;
  const reviewUser = liveReview === null ? null : record(liveReview.user);
  if (
    liveReview === null || String(liveReview.state).toLowerCase() !== 'changes_requested' ||
    liveReview.commit_id !== applied.reviewedHeadSha ||
    safeUrl(liveReview.html_url) !== applied.reviewUrl ||
    normalizedDate(liveReview.submitted_at) !== normalizedDate(applied.submittedAt) ||
    reviewUser?.login !== applied.reviewerLogin || reviewUser.type !== applied.reviewerType ||
    typeof liveReview.body !== 'string' || await canonicalSha256(liveReview.body) !== applied.bodyDigest
  ) throw new GitHubReviewFeedbackEvidenceVerificationError('github_review_mismatch');

  const action = record(await getJson(
    fetcher,
    `${githubApiOrigin}/repos/${manifest.repository}/actions/runs/${replacement.actionRunId}`,
    options.githubToken,
    'github',
    scanner,
  ));
  const actionRepository = apiObject(action, 'repository');
  if (
    action === null || String(action.id) !== replacement.actionRunId ||
    action.name !== 'Delivery Agent' || action.event !== 'workflow_dispatch' ||
    action.status !== 'completed' || action.conclusion !== 'success' ||
    action.head_sha !== replacement.actionWorkflowHeadSha ||
    action.head_branch !== replacement.actionHeadBranch ||
    action.path !== replacement.actionWorkflowPath || action.display_title !== replacement.actionTitle ||
    action.run_attempt !== 1 || actionRepository?.full_name !== manifest.repository
  ) throw new GitHubReviewFeedbackEvidenceVerificationError('github_action_mismatch');

  const jobsRoot = record(await getJson(
    fetcher,
    `${githubApiOrigin}/repos/${manifest.repository}/actions/runs/` +
      `${replacement.actionRunId}/jobs?filter=all&per_page=100`,
    options.githubToken,
    'github',
    scanner,
  ));
  const jobs = jobsRoot === null ? [] : rows(jobsRoot, 'jobs');
  const job = jobs[0];
  const steps = job === undefined ? [] : rows(job, 'steps');
  const requiredSteps = [
    'Checkout trusted execution snapshot',
    'Validate attempt mode bindings',
    'Run approved execution attempt',
  ];
  if (
    jobsRoot === null || jobsRoot.total_count !== 1 || jobs.length !== 1 ||
    String(job?.run_id) !== replacement.actionRunId || job?.name !== 'attempt' ||
    job.head_sha !== replacement.actionWorkflowHeadSha || job.status !== 'completed' ||
    job.conclusion !== 'success' || requiredSteps.some((name) => {
      const matches = steps.filter((step) => step.name === name);
      return matches.length !== 1 || matches[0]!.status !== 'completed' ||
        matches[0]!.conclusion !== 'success';
    })
  ) throw new GitHubReviewFeedbackEvidenceVerificationError('github_job_mismatch');

  const commit = record(await getJson(
    fetcher,
    `${githubApiOrigin}/repos/${manifest.repository}/commits/${replacement.resultHeadSha}`,
    options.githubToken,
    'github',
    scanner,
  ));
  const parents = commit === null ? [] : rows(commit, 'parents');
  if (
    commit?.sha !== replacement.resultHeadSha || parents.length !== 1 ||
    parents[0]!.sha !== replacement.checkoutSha
  ) throw new GitHubReviewFeedbackEvidenceVerificationError('github_commit_mismatch');

  const ref = record(await getJson(
    fetcher,
    `${githubApiOrigin}/repos/${manifest.repository}/git/ref/heads/${encodeURIComponent(replacement.branch)}`,
    options.githubToken,
    'github',
    scanner,
  ));
  const refObject = ref === null ? null : record(ref.object);
  if (refObject?.sha !== replacement.resultHeadSha) {
    throw new GitHubReviewFeedbackEvidenceVerificationError('github_ref_mismatch');
  }

  const compare = record(await getJson(
    fetcher,
    `${githubApiOrigin}/repos/${manifest.repository}/compare/${applied.reviewedHeadSha}...${replacement.resultHeadSha}`,
    options.githubToken,
    'github',
    scanner,
  ));
  const baseCommit = compare === null ? null : record(compare.base_commit);
  const mergeBase = compare === null ? null : record(compare.merge_base_commit);
  const commits = compare === null ? [] : rows(compare, 'commits');
  if (
    compare?.status !== 'ahead' ||
    compare.ahead_by !== 1 || compare.behind_by !== 0 ||
    baseCommit?.sha !== replacement.checkoutSha || mergeBase?.sha !== applied.reviewedHeadSha ||
    commits.length !== 1 || commits[0]!.sha !== replacement.resultHeadSha
  ) throw new GitHubReviewFeedbackEvidenceVerificationError('github_compare_mismatch');

  const checksResponse = record(await getJson(
    fetcher,
    `${githubApiOrigin}/repos/${manifest.repository}/commits/${replacement.resultHeadSha}/check-runs?per_page=100`,
    options.githubToken,
    'github',
    scanner,
  ));
  const checkRuns = checksResponse === null ? [] : rows(checksResponse, 'check_runs');
  if (
    checksResponse === null || checksResponse.total_count !== checkRuns.length ||
    checkRuns.length !== replacement.checks.length || replacement.checks.some((expected) => {
      const found = checkRuns.filter((check) => check.name === expected.name);
      return found.length !== 1 || found[0]!.status !== 'completed' ||
        found[0]!.conclusion !== expected.conclusion || found[0]!.head_sha !== replacement.resultHeadSha;
    })
  ) throw new GitHubReviewFeedbackEvidenceVerificationError('github_checks_mismatch');

  return {
    schemaVersion: '1', evidenceId: manifest.evidenceId, runId: manifest.runId,
    repository: manifest.repository, appliedReview: 'verified', staleReview: 'ignored',
    replacementAttempt: 'verified', planItem: 'verified', commit: 'verified',
    verificationSuite: 'verified', githubAction: 'verified', githubJob: 'verified',
    githubChecks: 'all_success', githubCheckCount: replacement.checks.length,
    resultHeadSha: replacement.resultHeadSha,
  };
}
