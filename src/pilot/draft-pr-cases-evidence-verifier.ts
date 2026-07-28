import { canonicalSha256 } from '../domain/digest.js';
import {
  DraftPrCasesEvidenceManifestV1Schema,
  type DraftPrCaseEvidenceV1,
  type DraftPrCasesEvidenceManifestV1,
} from '../domain/draft-pr-cases-evidence.js';
import {
  GitHubPullRequestEvidenceVerificationError,
  verifyGitHubPullRequestEvidence,
} from './github-pull-request-evidence-verifier.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;

export type DraftPrCasesEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'task_projection_mismatch'
  | 'plan_projection_mismatch'
  | 'lineage_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_action_mismatch'
  | 'github_diff_mismatch'
  | 'github_pull_request_mismatch'
  | 'secret_leak_detected';

export class DraftPrCasesEvidenceVerificationError extends Error {
  constructor(readonly code: DraftPrCasesEvidenceVerificationErrorCode) {
    super(`Draft PR cases evidence verification failed: ${code}`);
    this.name = 'DraftPrCasesEvidenceVerificationError';
  }
}

export interface DraftPrCasesEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  canary: string;
  githubApiOrigin?: string;
  fetcher?: typeof fetch;
}

export interface DraftPrCasesEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  verifiedCases: 2;
  requirementDraftPullRequests: 1;
  bugDraftPullRequests: 1;
  tracedCommits: 2;
  tracedTestSuites: 2;
  repoWriteApprovals: 2;
  readyItemClaims: 2;
  repositoryWriteCredentials: 2;
  singleCommitDiffs: 2;
  changedFiles: number;
  externalActions: 2;
  plaintextLeaks: 0;
  humanReview: 'required_and_recorded';
}

type Source = 'control_plane' | 'github';

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

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new DraftPrCasesEvidenceVerificationError('configuration_invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new DraftPrCasesEvidenceVerificationError('configuration_invalid');
  return url.origin;
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
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}

function unavailable(source: Source): DraftPrCasesEvidenceVerificationErrorCode {
  return source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable';
}

function invalid(source: Source): DraftPrCasesEvidenceVerificationErrorCode {
  return source === 'control_plane'
    ? 'control_plane_response_invalid'
    : 'github_response_invalid';
}

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  source: Source,
  scanner: SecretScanner,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: {
        accept: source === 'github' ? 'application/vnd.github+json' : 'application/json',
        authorization: `Bearer ${token}`,
        ...(source === 'github' ? { 'x-github-api-version': '2022-11-28' } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new DraftPrCasesEvidenceVerificationError(unavailable(source));
  }
  if (!response.ok || /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new DraftPrCasesEvidenceVerificationError(unavailable(source));
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new DraftPrCasesEvidenceVerificationError(invalid(source));
  }
  let text: string | null;
  try { text = await boundedText(response); }
  catch { throw new DraftPrCasesEvidenceVerificationError(invalid(source)); }
  if (text === null) throw new DraftPrCasesEvidenceVerificationError(invalid(source));
  if (scanner.scanText(text, `$.${source}`).length > 0) {
    throw new DraftPrCasesEvidenceVerificationError('secret_leak_detected');
  }
  try { return JSON.parse(text) as unknown; }
  catch { throw new DraftPrCasesEvidenceVerificationError(invalid(source)); }
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function sameStringSet(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value) => typeof value === 'string') &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value));
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function changeItem(item: DraftPrCaseEvidenceV1): DraftPrCaseEvidenceV1['plan']['requiredItems'][number] {
  const changes = item.plan.requiredItems.filter((required) => required.kind === 'change');
  if (
    changes.length !== 1 || item.execution.mode !== 'implement' ||
    item.testSuite.planItemId !== changes[0]!.itemId
  ) throw new DraftPrCasesEvidenceVerificationError('plan_projection_mismatch');
  return changes[0]!;
}

function validateTask(raw: unknown, item: DraftPrCaseEvidenceV1, repository: string): void {
  const root = record(raw);
  const task = root === null ? null : record(root.task);
  const source = task === null ? null : record(task.source);
  const target = task === null ? null : record(task.target);
  const intent = task === null ? null : record(task.intent);
  const run = root === null ? null : record(root.run);
  if (
    root === null || task === null || source === null || target === null ||
    intent === null || run === null ||
    task.id !== item.task.taskId || task.digest !== item.task.taskDigest ||
    source.system !== item.task.sourceSystem || source.revision !== item.task.sourceRevision ||
    target.repository !== repository ||
    intent.kind !== item.scenario ||
    intent.acceptanceCriteriaCount !== item.task.acceptanceCriteriaCount ||
    run.id !== item.runId || run.state !== 'pull_request_open'
  ) throw new DraftPrCasesEvidenceVerificationError('task_projection_mismatch');
  const activePlan = record(run.activePlan);
  if (
    activePlan === null || activePlan.id !== item.plan.planId ||
    activePlan.version !== item.plan.version || activePlan.digest !== item.plan.digest
  ) throw new DraftPrCasesEvidenceVerificationError('task_projection_mismatch');
}

function validatePlan(raw: unknown, item: DraftPrCaseEvidenceV1): void {
  const root = record(raw);
  const run = root === null ? null : record(root.run);
  const plan = root === null ? null : record(root.plan);
  const planItems = root === null ? [] : rows(root, 'items');
  const attempts = root === null ? [] : rows(root, 'attempts');
  const evidence = root === null ? [] : rows(root, 'evidence');
  if (
    root === null || run === null || plan === null ||
    run.id !== item.runId || run.state !== 'pull_request_open' ||
    plan.id !== item.plan.planId || plan.version !== item.plan.version ||
    plan.digest !== item.plan.digest || plan.baseSha !== item.plan.baseSha ||
    plan.status !== 'active'
  ) throw new DraftPrCasesEvidenceVerificationError('plan_projection_mismatch');

  const executionItem = changeItem(item);

  const required = planItems.filter((planItem) => planItem.required === true);
  if (required.length !== item.plan.requiredItems.length) {
    throw new DraftPrCasesEvidenceVerificationError('plan_projection_mismatch');
  }
  const covered = new Set<number>();
  for (const expected of item.plan.requiredItems) {
    const matches = required.filter((planItem) => planItem.id === expected.itemId);
    const row = matches[0];
    const decision = row === undefined ? null : record(row.verificationDecision);
    if (
      matches.length !== 1 || row?.kind !== expected.kind || row.status !== 'passed' ||
      decision === null || decision.id !== expected.verificationId ||
      decision.headSha !== expected.headSha ||
      decision.evidenceSetDigest !== expected.evidenceSetDigest ||
      !sameStrings(decision.evidenceIds, expected.evidenceIds)
    ) throw new DraftPrCasesEvidenceVerificationError('plan_projection_mismatch');
    if (expected.itemId === executionItem.itemId && (
      !sameStringSet(row.effects, ['repo_write']) ||
      !sameStringSet(
        row.commandRefs,
        item.testSuite.commands.map((command) => command.commandRef),
      ) ||
      !Array.isArray(row.evidenceKinds) || !row.evidenceKinds.includes('test')
    )) throw new DraftPrCasesEvidenceVerificationError('plan_projection_mismatch');
    const indexes = row.acceptanceCriteriaIndexes;
    if (!Array.isArray(indexes) || indexes.some((value) => !Number.isSafeInteger(value))) {
      throw new DraftPrCasesEvidenceVerificationError('plan_projection_mismatch');
    }
    for (const value of indexes as number[]) covered.add(value);
  }
  if (
    Array.from({ length: item.task.acceptanceCriteriaCount }, (_, index) => index)
      .some((index) => !covered.has(index))
  ) throw new DraftPrCasesEvidenceVerificationError('plan_projection_mismatch');

  const attemptMatches = attempts.filter((attempt) => attempt.id === item.execution.attemptId);
  const attempt = attemptMatches[0];
  if (
    attemptMatches.length !== 1 || attempt?.mode !== item.execution.mode ||
    attempt.status !== 'completed' || attempt.planId !== item.plan.planId ||
    attempt.planVersion !== item.plan.version ||
    attempt.planItemId !== executionItem.itemId ||
    attempt.headBranch !== item.execution.branch || attempt.headSha !== item.execution.headSha ||
    attempt.githubRunId !== item.execution.actionRunId ||
    attempt.githubStatus !== 'completed' || attempt.githubConclusion !== 'success'
  ) throw new DraftPrCasesEvidenceVerificationError('plan_projection_mismatch');

  for (const command of item.testSuite.commands) {
    const matches = evidence.filter((row) => row.id === command.evidenceId);
    const evidenceRow = matches[0];
    if (
      matches.length !== 1 || evidenceRow?.attemptId !== item.execution.attemptId ||
      evidenceRow.planId !== item.plan.planId ||
      evidenceRow.planVersion !== item.plan.version ||
      evidenceRow.planItemId !== item.testSuite.planItemId ||
      evidenceRow.kind !== 'test' || evidenceRow.status !== 'passed' ||
      evidenceRow.verificationStatus !== 'verified' ||
      evidenceRow.commandRef !== command.commandRef || evidenceRow.exitCode !== 0 ||
      evidenceRow.sha !== item.execution.headSha
    ) throw new DraftPrCasesEvidenceVerificationError('plan_projection_mismatch');
  }
}

async function validateAudit(raw: unknown, item: DraftPrCaseEvidenceV1): Promise<void> {
  const root = record(raw);
  const run = root === null ? null : record(root.run);
  const task = root === null ? null : record(root.task);
  const answers = root === null ? null : record(root.answers);
  const who = answers === null ? null : record(answers.who);
  const permissions = answers === null ? null : record(answers.permissions);
  const taskPolicy = permissions === null ? null : record(permissions.taskPolicy);
  const attemptRows = who === null ? [] : rows(who, 'attempts');
  const planEffects = permissions === null ? [] : rows(permissions, 'planEffects');
  const credentials = permissions === null ? [] : rows(permissions, 'repositoryWriteCredentials');
  const approvals = answers === null ? [] : rows(answers, 'approvals');
  const checks = answers === null ? null : record(answers.checks);
  const changes = answers === null ? [] : rows(answers, 'changes');
  const deployments = answers === null ? [] : rows(answers, 'deployments');
  const commands = checks === null ? [] : rows(checks, 'commands');
  const verifications = checks === null ? [] : rows(checks, 'itemVerifications');
  const evidence = checks === null ? [] : rows(checks, 'evidence');
  if (
    root === null || run === null || task === null || answers === null || checks === null ||
    who === null || permissions === null || taskPolicy === null ||
    root.schemaVersion !== '1' || root.runId !== item.runId ||
    run.state !== 'pull_request_open' || run.baseSha !== item.plan.baseSha ||
    run.activePlanId !== item.plan.planId || run.activePlanVersion !== item.plan.version ||
    run.activePlanDigest !== item.plan.digest || task.id !== item.task.taskId ||
    task.revision !== item.task.sourceRevision || task.digest !== item.task.taskDigest ||
    changes.some((change) => change.kind === 'merge') || deployments.length !== 0
  ) throw new DraftPrCasesEvidenceVerificationError('lineage_projection_mismatch');
  const reportDigest = root.reportDigest;
  const body = Object.fromEntries(Object.entries(root).filter(([key]) =>
    key !== 'generatedAt' && key !== 'queryDurationMs' && key !== 'reportDigest'));
  if (
    typeof reportDigest !== 'string' || await canonicalSha256(body) !== reportDigest
  ) throw new DraftPrCasesEvidenceVerificationError('lineage_projection_mismatch');

  const executionItem = changeItem(item);
  if (
    taskPolicy.repositoryWrite !== true || taskPolicy.humanApprovalRequired !== true ||
    planEffects.filter((effect) =>
      effect.planId === item.plan.planId && effect.planVersion === item.plan.version &&
      effect.planDigest === item.plan.digest && effect.itemId === executionItem.itemId &&
      effect.effect === 'repo_write').length !== 1
  ) throw new DraftPrCasesEvidenceVerificationError('lineage_projection_mismatch');

  const attemptMatches = attemptRows.filter((attempt) =>
    attempt.attemptId === item.execution.attemptId);
  const executionAttempt = attemptMatches[0];
  const attemptCreatedAt = timestamp(executionAttempt?.createdAt);
  const attemptUpdatedAt = timestamp(executionAttempt?.updatedAt);
  if (
    attemptMatches.length !== 1 || executionAttempt?.mode !== 'implement' ||
    executionAttempt.status !== 'completed' ||
    executionAttempt.repository !== item.pullRequest.repository ||
    executionAttempt.planId !== item.plan.planId ||
    executionAttempt.planVersion !== item.plan.version ||
    executionAttempt.itemId !== executionItem.itemId ||
    !Number.isSafeInteger(executionAttempt.claimedProgressVersion) ||
    Number(executionAttempt.claimedProgressVersion) < 1 ||
    executionAttempt.baseSha !== item.execution.actionCheckoutSha ||
    executionAttempt.headSha !== item.execution.headSha ||
    executionAttempt.githubRunId !== item.execution.actionRunId ||
    executionAttempt.githubStatus !== 'completed' ||
    executionAttempt.githubConclusion !== 'success' ||
    attemptCreatedAt === null || attemptUpdatedAt === null || attemptCreatedAt > attemptUpdatedAt
  ) throw new DraftPrCasesEvidenceVerificationError('lineage_projection_mismatch');

  const attemptCommits = changes.filter((change) =>
    change.kind === 'commit' && change.attemptId === item.execution.attemptId);
  const commits = attemptCommits.filter((change) =>
    change.kind === 'commit' && change.updateId === item.execution.updateId);
  const commitCreatedAt = timestamp(commits[0]?.createdAt);
  if (
    attemptCommits.length !== 1 || commits.length !== 1 ||
    commits[0]!.attemptId !== item.execution.attemptId ||
    commits[0]!.planId !== item.plan.planId ||
    commits[0]!.planVersion !== item.plan.version ||
    commits[0]!.itemId !== executionItem.itemId ||
    commits[0]!.parentSha !== item.execution.parentSha ||
    commits[0]!.headSha !== item.execution.headSha ||
    commits[0]!.branch !== item.execution.branch ||
    commits[0]!.evidenceId !== item.execution.commitEvidenceId ||
    commitCreatedAt === null || attemptCreatedAt === null || attemptUpdatedAt === null ||
    commitCreatedAt < attemptCreatedAt || commitCreatedAt > attemptUpdatedAt
  ) throw new DraftPrCasesEvidenceVerificationError('lineage_projection_mismatch');

  const publicationMatches = changes.filter((change) =>
    change.kind === 'pull_request' &&
    change.publicationId === item.pullRequest.publication.publicationId);
  const publication = publicationMatches[0];
  const publicationCreatedAt = timestamp(publication?.createdAt);
  if (
    publicationMatches.length !== 1 ||
    publication?.approvalId !== item.pullRequest.publication.approvalId ||
    publication.repository !== item.pullRequest.repository ||
    publication.baseBranch !== item.pullRequest.publication.baseBranch ||
    publication.headBranch !== item.execution.branch ||
    publication.headSha !== item.execution.headSha ||
    publication.status !== 'verified' || publicationCreatedAt === null ||
    commitCreatedAt === null || publicationCreatedAt < commitCreatedAt
  ) throw new DraftPrCasesEvidenceVerificationError('lineage_projection_mismatch');

  const exactApprovals = approvals.filter((approval) =>
    approval.taskId === item.task.taskId &&
    approval.taskRevision === item.task.sourceRevision &&
    approval.planId === item.plan.planId && approval.planVersion === item.plan.version &&
    approval.planDigest === item.plan.digest && approval.baseSha === item.plan.baseSha &&
    approval.effect === 'repo_write');
  const approvalMatches = exactApprovals.filter((approval) =>
    approval.approvalId === item.pullRequest.publication.approvalId);
  const approval = approvalMatches[0];
  const approvalCreatedAt = timestamp(approval?.createdAt);
  const approvalExpiresAt = timestamp(approval?.expiresAt);
  const approvalSourceOccurredAt = timestamp(approval?.sourceOccurredAt);
  const approvalDecisionRecordedAt = timestamp(approval?.decisionRecordedAt);
  const latestApproval = [...exactApprovals].sort((left, right) =>
    (timestamp(left.createdAt) ?? Number.NEGATIVE_INFINITY) -
      (timestamp(right.createdAt) ?? Number.NEGATIVE_INFINITY) ||
    String(left.approvalId).localeCompare(String(right.approvalId))).at(-1);
  if (
    exactApprovals.some((candidate) => timestamp(candidate.createdAt) === null) ||
    approvalMatches.length !== 1 || latestApproval?.approvalId !== approval?.approvalId ||
    approval?.decision !== 'approve' || approval.invalidated !== false ||
    typeof approval.approver !== 'string' || !approval.approver.startsWith('user:') ||
    approval.provider !== 'feishu' ||
    typeof approval.lineageId !== 'string' || approval.lineageId.length === 0 ||
    typeof approval.sourceRecordId !== 'string' || approval.sourceRecordId.length === 0 ||
    typeof approval.externalEventId !== 'string' || approval.externalEventId.length === 0 ||
    typeof approval.rolesDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(approval.rolesDigest) ||
    approvalCreatedAt === null || approvalExpiresAt === null ||
    approvalSourceOccurredAt === null || approvalDecisionRecordedAt === null ||
    approvalSourceOccurredAt > approvalDecisionRecordedAt ||
    approvalDecisionRecordedAt > approvalCreatedAt ||
    attemptCreatedAt === null || publicationCreatedAt === null ||
    approvalCreatedAt > attemptCreatedAt || approvalExpiresAt <= publicationCreatedAt
  ) throw new DraftPrCasesEvidenceVerificationError('lineage_projection_mismatch');

  const credentialMatches = credentials.filter((credential) =>
    credential.attemptId === item.execution.attemptId);
  const credential = credentialMatches[0];
  const credentialCreatedAt = timestamp(credential?.createdAt);
  const authorizationExpiresAt = timestamp(credential?.authorizationExpiresAt);
  const revokedAt = credential?.revokedAt === null ? null : timestamp(credential?.revokedAt);
  if (
    credentialMatches.length !== 1 ||
    credential?.planId !== item.plan.planId || credential.planVersion !== item.plan.version ||
    credential.itemId !== executionItem.itemId ||
    credential.approvalId !== item.pullRequest.publication.approvalId ||
    credential.repository !== item.pullRequest.repository ||
    !Number.isSafeInteger(credential.leaseGeneration) || Number(credential.leaseGeneration) < 1 ||
    !['revocation_pending', 'revoking', 'revoked', 'expired'].includes(String(credential.status)) ||
    credentialCreatedAt === null || authorizationExpiresAt === null ||
    approvalCreatedAt === null || commitCreatedAt === null ||
    credentialCreatedAt < approvalCreatedAt || credentialCreatedAt > commitCreatedAt ||
    authorizationExpiresAt <= commitCreatedAt ||
    (credential.revokedAt !== null && (revokedAt === null || revokedAt < commitCreatedAt)) ||
    (credential.status === 'revoked' && revokedAt === null)
  ) throw new DraftPrCasesEvidenceVerificationError('lineage_projection_mismatch');

  for (const expected of item.testSuite.commands) {
    const commandMatches = commands.filter((command) =>
      command.suiteId === item.testSuite.suiteId && command.position === expected.position);
    const command = commandMatches[0];
    const evidenceMatches = evidence.filter((row) => row.evidenceId === expected.evidenceId);
    const evidenceRow = evidenceMatches[0];
    if (
      commandMatches.length !== 1 || command?.attemptId !== item.execution.attemptId ||
      command.planId !== item.plan.planId || command.planVersion !== item.plan.version ||
      command.itemId !== item.testSuite.planItemId ||
      command.headSha !== item.execution.headSha ||
      command.deliveryPolicyDigest !== item.testSuite.deliveryPolicyDigest ||
      command.phase !== expected.phase || command.commandRef !== expected.commandRef ||
      command.status !== 'passed' || command.evidenceId !== expected.evidenceId ||
      evidenceMatches.length !== 1 || evidenceRow?.attemptId !== item.execution.attemptId ||
      evidenceRow.planId !== item.plan.planId ||
      evidenceRow.planVersion !== item.plan.version ||
      evidenceRow.itemId !== item.testSuite.planItemId ||
      evidenceRow.kind !== 'test' || evidenceRow.status !== 'passed' ||
      evidenceRow.verificationStatus !== 'verified' ||
      evidenceRow.commandRef !== expected.commandRef || evidenceRow.exitCode !== 0 ||
      evidenceRow.sha !== item.execution.headSha
    ) throw new DraftPrCasesEvidenceVerificationError('lineage_projection_mismatch');
  }
  for (const expected of item.plan.requiredItems) {
    const matches = verifications.filter((row) => row.verificationId === expected.verificationId);
    if (
      matches.length !== 1 || matches[0]!.planId !== item.plan.planId ||
      matches[0]!.planVersion !== item.plan.version ||
      matches[0]!.itemId !== expected.itemId ||
      matches[0]!.headSha !== expected.headSha ||
      matches[0]!.evidenceSetDigest !== expected.evidenceSetDigest ||
      matches[0]!.status !== 'passed'
    ) throw new DraftPrCasesEvidenceVerificationError('lineage_projection_mismatch');
  }
}

async function validateAction(
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
  scanner: SecretScanner,
  repository: string,
  item: DraftPrCaseEvidenceV1,
): Promise<void> {
  const run = record(await getJson(
    fetcher,
    `${apiOrigin}/repos/${repository}/actions/runs/${item.execution.actionRunId}`,
    token,
    'github',
    scanner,
  ));
  const runRepository = run === null ? null : record(run.repository);
  if (
    run === null || String(run.id) !== item.execution.actionRunId ||
    run.name !== 'Delivery Agent' ||
    run.display_title !== `delivery-loop/${item.execution.attemptId}` ||
    run.event !== 'workflow_dispatch' || run.status !== 'completed' ||
    run.conclusion !== 'success' || run.head_sha !== item.execution.actionCheckoutSha ||
    runRepository?.full_name !== repository
  ) throw new DraftPrCasesEvidenceVerificationError('github_action_mismatch');
  const jobsRoot = record(await getJson(
    fetcher,
    `${apiOrigin}/repos/${repository}/actions/runs/${item.execution.actionRunId}` +
      '/jobs?filter=all&per_page=100',
    token,
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
    String(job?.run_id) !== item.execution.actionRunId ||
    job?.head_sha !== item.execution.actionCheckoutSha ||
    job.status !== 'completed' || job.conclusion !== 'success' ||
    requiredSteps.some((name) => {
      const matches = steps.filter((step) => step.name === name);
      return matches.length !== 1 || matches[0]!.conclusion !== 'success';
    })
  ) throw new DraftPrCasesEvidenceVerificationError('github_action_mismatch');
}

async function validateDiff(
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
  scanner: SecretScanner,
  repository: string,
  item: DraftPrCaseEvidenceV1,
): Promise<void> {
  const compare = record(await getJson(
    fetcher,
    `${apiOrigin}/repos/${repository}/compare/` +
      `${encodeURIComponent(item.plan.baseSha)}...${encodeURIComponent(item.execution.headSha)}`,
    token,
    'github',
    scanner,
  ));
  const baseCommit = compare === null ? null : record(compare.base_commit);
  const mergeBase = compare === null ? null : record(compare.merge_base_commit);
  const commits = compare === null ? [] : rows(compare, 'commits');
  const files = compare === null ? [] : rows(compare, 'files');
  const projection = files.map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    previousFilename: file.previous_filename ?? null,
  })).sort((left, right) => String(left.filename).localeCompare(String(right.filename)));
  if (
    compare === null || compare.status !== 'ahead' ||
    compare.ahead_by !== 1 ||
    compare.behind_by !== 0 || baseCommit?.sha !== item.plan.baseSha ||
    mergeBase?.sha !== item.plan.baseSha ||
    commits.length !== 1 || commits[0]?.sha !== item.execution.headSha ||
    files.length !== item.diff.changedFileCount ||
    files.some((file) =>
      typeof file.filename !== 'string' || typeof file.status !== 'string' ||
      !Number.isSafeInteger(file.additions) || !Number.isSafeInteger(file.deletions) ||
      !Number.isSafeInteger(file.changes)) ||
    await canonicalSha256(projection) !== item.diff.changedFilesDigest
  ) throw new DraftPrCasesEvidenceVerificationError('github_diff_mismatch');
}

async function scanningFetch(
  fetcher: typeof fetch,
  scanner: SecretScanner,
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetcher(input, init);
  const copy = response.clone();
  const text = await boundedText(copy);
  if (text === null) {
    throw new DraftPrCasesEvidenceVerificationError('github_response_invalid');
  }
  if (scanner.scanText(text, '$.external').length > 0) {
    throw new DraftPrCasesEvidenceVerificationError('secret_leak_detected');
  }
  return response;
}

export async function verifyDraftPrCasesEvidence(
  input: DraftPrCasesEvidenceManifestV1,
  options: DraftPrCasesEvidenceVerifierOptions,
): Promise<DraftPrCasesEvidenceVerificationSummary> {
  const parsed = DraftPrCasesEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new DraftPrCasesEvidenceVerificationError('manifest_invalid');
  }
  const manifest = parsed.data;
  if (
    !TOKEN_PATTERN.test(options.controlPlaneToken) ||
    !TOKEN_PATTERN.test(options.githubToken) || !CANARY_PATTERN.test(options.canary) ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    manifest.safety.canaryDigest !== await canonicalSha256(options.canary)
  ) throw new DraftPrCasesEvidenceVerificationError('configuration_invalid');
  const controlOrigin = safeOrigin(options.controlPlaneOrigin);
  const githubOrigin = safeOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetcher ?? fetch;
  const scanner = new SecretScanner({
    secrets: [options.controlPlaneToken, options.githubToken, options.canary],
  });

  for (const item of manifest.cases) {
    const [taskRaw, planRaw, auditRaw] = await Promise.all([
      getJson(
        fetcher,
        `${controlOrigin}/v1/tasks/${item.task.taskId}`,
        options.controlPlaneToken,
        'control_plane',
        scanner,
      ),
      getJson(
        fetcher,
        `${controlOrigin}/v1/runs/${item.runId}/plan`,
        options.controlPlaneToken,
        'control_plane',
        scanner,
      ),
      getJson(
        fetcher,
        `${controlOrigin}/v1/runs/${item.runId}/audit`,
        options.controlPlaneToken,
        'control_plane',
        scanner,
      ),
    ]);
    validateTask(taskRaw, item, manifest.repository);
    validatePlan(planRaw, item);
    await validateAudit(auditRaw, item);
    await validateAction(
      fetcher, githubOrigin, options.githubToken, scanner, manifest.repository, item,
    );
    await validateDiff(
      fetcher, githubOrigin, options.githubToken, scanner, manifest.repository, item,
    );
    const guardedFetch: typeof fetch = async (request, init) =>
      await scanningFetch(fetcher, scanner, request, init);
    try {
      await verifyGitHubPullRequestEvidence(item.pullRequest, {
        controlPlaneOrigin: controlOrigin,
        controlPlaneToken: options.controlPlaneToken,
        githubToken: options.githubToken,
        githubApiOrigin: githubOrigin,
        fetch: guardedFetch,
      });
    } catch (error) {
      if (error instanceof DraftPrCasesEvidenceVerificationError) throw error;
      if (error instanceof GitHubPullRequestEvidenceVerificationError) {
        throw new DraftPrCasesEvidenceVerificationError('github_pull_request_mismatch');
      }
      throw new DraftPrCasesEvidenceVerificationError('github_pull_request_mismatch');
    }
  }

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    repository: manifest.repository,
    verifiedCases: 2,
    requirementDraftPullRequests: 1,
    bugDraftPullRequests: 1,
    tracedCommits: 2,
    tracedTestSuites: 2,
    repoWriteApprovals: 2,
    readyItemClaims: 2,
    repositoryWriteCredentials: 2,
    singleCommitDiffs: 2,
    changedFiles: manifest.cases.reduce((sum, item) => sum + item.diff.changedFileCount, 0),
    externalActions: 2,
    plaintextLeaks: 0,
    humanReview: 'required_and_recorded',
  };
}
