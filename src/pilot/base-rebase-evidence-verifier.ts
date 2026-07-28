import { canonicalSha256 } from '../domain/digest.js';
import {
  BaseRebaseEvidenceManifestV1Schema,
  type BaseRebaseEvidenceManifestV1,
} from '../domain/base-rebase-evidence.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

export type BaseRebaseEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_action_mismatch'
  | 'github_source_mismatch'
  | 'github_side_effect_mismatch';

export class BaseRebaseEvidenceVerificationError extends Error {
  constructor(readonly code: BaseRebaseEvidenceVerificationErrorCode) {
    super(`Base rebase evidence verification failed: ${code}`);
    this.name = 'BaseRebaseEvidenceVerificationError';
  }
}

export interface BaseRebaseEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export type BaseRebaseEvidenceVerificationSummary =
  | {
      schemaVersion: '1';
      evidenceId: string;
      runId: string;
      repository: string;
      outcome: 'passed';
      rebase: 'verified';
      baseComparison: 'verified';
      branchUpdate: 'fast_forward_no_force';
      action: 'verified';
      verification: 'verified';
    }
  | {
      schemaVersion: '1';
      evidenceId: string;
      runId: string;
      repository: string;
      outcome: 'blocked';
      conflict: 'verified';
      baseComparison: 'verified';
      sideEffects: 'none';
      humanAction: 'manual_rebase';
    };

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

function origin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BaseRebaseEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new BaseRebaseEvidenceVerificationError('configuration_invalid');
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
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function requestJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  source: 'control_plane' | 'github',
  expectedStatuses: readonly number[] = [200],
): Promise<{ status: number; body: unknown }> {
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
    throw new BaseRebaseEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  const invalidCode = source === 'control_plane'
    ? 'control_plane_response_invalid'
    : 'github_response_invalid';
  if (!expectedStatuses.includes(response.status)) {
    await response.body?.cancel();
    throw new BaseRebaseEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  if (/(?:^|[;\s])rel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new BaseRebaseEvidenceVerificationError(invalidCode);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new BaseRebaseEvidenceVerificationError(invalidCode);
  }
  let text: string | null;
  try {
    text = await boundedText(response);
  } catch {
    throw new BaseRebaseEvidenceVerificationError(invalidCode);
  }
  if (text === null) throw new BaseRebaseEvidenceVerificationError(invalidCode);
  if (response.status === 404 && expectedStatuses.includes(404)) return { status: 404, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    throw new BaseRebaseEvidenceVerificationError(invalidCode);
  }
}

async function getControlAudit(
  fetcher: typeof fetch,
  originUrl: string,
  token: string,
  runId: string,
): Promise<Record<string, unknown>> {
  const result = await requestJson(
    fetcher,
    `${originUrl}/v1/runs/${runId}/audit`,
    token,
    'control_plane',
  );
  const body = record(result.body);
  if (body === null) throw new BaseRebaseEvidenceVerificationError('control_plane_response_invalid');
  return body;
}

function actionPath(repository: string, runId: string): string {
  return `/repos/${repository}/actions/runs/${runId}`;
}

function refPath(repository: string, branch: string): string {
  const encoded = branch.split('/').map(encodeURIComponent).join('/');
  return `/repos/${repository}/git/ref/heads/${encoded}`;
}

function comparePath(repository: string, beforeSha: string, afterSha: string): string {
  return `/repos/${repository}/compare/${beforeSha}...${afterSha}`;
}

function actionsPath(repository: string): string {
  return `/repos/${repository}/actions/runs?per_page=100`;
}

function requireObject(value: unknown, code: BaseRebaseEvidenceVerificationErrorCode): Record<string, unknown> {
  const object = record(value);
  if (object === null) throw new BaseRebaseEvidenceVerificationError(code);
  return object;
}

async function verifyBaseComparison(
  manifest: BaseRebaseEvidenceManifestV1,
  fetcher: typeof fetch,
  githubOrigin: string,
  githubToken: string,
): Promise<void> {
  const comparison = manifest.baseComparison;
  const reference = requireObject((await requestJson(
    fetcher,
    `${githubOrigin}${refPath(manifest.repository, comparison.baseBranch)}`,
    githubToken,
    'github',
  )).body, 'github_source_mismatch');
  const referenceObject = requireObject(reference.object, 'github_source_mismatch');
  if (
    reference.ref !== `refs/heads/${comparison.baseBranch}` ||
    referenceObject.type !== 'commit' || referenceObject.sha !== comparison.afterSha
  ) throw new BaseRebaseEvidenceVerificationError('github_source_mismatch');
  const referenceDigest = await canonicalSha256({
    ref: reference.ref,
    objectType: referenceObject.type,
    sha: referenceObject.sha,
  });
  const compareBody = requireObject((await requestJson(
    fetcher,
    `${githubOrigin}${comparePath(manifest.repository, comparison.beforeSha, comparison.afterSha)}`,
    githubToken,
    'github',
  )).body, 'github_source_mismatch');
  const baseCommit = requireObject(compareBody.base_commit, 'github_source_mismatch');
  const mergeBase = requireObject(compareBody.merge_base_commit, 'github_source_mismatch');
  if (
    compareBody.status !== comparison.relationship ||
    compareBody.ahead_by !== comparison.aheadBy ||
    compareBody.behind_by !== comparison.behindBy ||
    baseCommit.sha !== comparison.beforeSha || mergeBase.sha !== comparison.mergeBaseSha
  ) throw new BaseRebaseEvidenceVerificationError('github_source_mismatch');
  const comparisonDigest = await canonicalSha256({
    status: compareBody.status,
    aheadBy: compareBody.ahead_by,
    behindBy: compareBody.behind_by,
    baseCommitSha: baseCommit.sha,
    mergeBaseCommitSha: mergeBase.sha,
    comparedHeadSha: comparison.afterSha,
  });
  const sourceDigest = manifest.outcome === 'passed'
    ? await canonicalSha256({
        schemaVersion: '1', repository: comparison.repository,
        baseBranch: comparison.baseBranch, beforeSha: comparison.beforeSha,
        afterSha: comparison.afterSha, relationship: 'ahead', aheadBy: comparison.aheadBy,
        referenceDigest, comparisonDigest,
      })
    : await canonicalSha256({
        schemaVersion: '1', repository: comparison.repository,
        baseBranch: comparison.baseBranch, beforeSha: comparison.beforeSha,
        afterSha: comparison.afterSha, relationship: comparison.relationship,
        aheadBy: comparison.aheadBy, behindBy: comparison.behindBy,
        mergeBaseSha: comparison.mergeBaseSha, referenceDigest, comparisonDigest,
      });
  if (
    referenceDigest !== comparison.referenceDigest ||
    comparisonDigest !== comparison.comparisonDigest ||
    sourceDigest !== comparison.sourceDigest
  ) throw new BaseRebaseEvidenceVerificationError('github_source_mismatch');
}

async function verifyAction(
  manifest: Extract<BaseRebaseEvidenceManifestV1, { outcome: 'passed' }>,
  fetcher: typeof fetch,
  githubOrigin: string,
  githubToken: string,
): Promise<void> {
  const action = requireObject((await requestJson(
    fetcher,
    `${githubOrigin}${actionPath(manifest.repository, manifest.action.githubRunId)}`,
    githubToken,
    'github',
  )).body, 'github_action_mismatch');
  const actionRepository = requireObject(action.repository, 'github_action_mismatch');
  if (
    String(action.id) !== manifest.action.githubRunId ||
    action.status !== manifest.action.status || action.conclusion !== manifest.action.conclusion ||
    action.head_sha !== manifest.action.headSha || action.head_branch !== manifest.action.headBranch ||
    action.path !== manifest.action.workflowPath ||
    action.display_title !== manifest.action.displayTitle ||
    action.run_attempt !== manifest.action.runAttempt ||
    actionRepository.full_name !== manifest.repository
  ) throw new BaseRebaseEvidenceVerificationError('github_action_mismatch');
}

async function verifySuccessGitRefs(
  manifest: Extract<BaseRebaseEvidenceManifestV1, { outcome: 'passed' }>,
  fetcher: typeof fetch,
  githubOrigin: string,
  githubToken: string,
): Promise<void> {
  const { rebase, branchUpdate } = manifest;
  const target = requireObject((await requestJson(
    fetcher,
    `${githubOrigin}${refPath(manifest.repository, rebase.targetBranch)}`,
    githubToken,
    'github',
  )).body, 'github_source_mismatch');
  const targetObject = requireObject(target.object, 'github_source_mismatch');
  if (
    target.ref !== branchUpdate.ref || targetObject.type !== 'commit' ||
    targetObject.sha !== branchUpdate.afterSha
  ) throw new BaseRebaseEvidenceVerificationError('github_source_mismatch');
  const source = requireObject((await requestJson(
    fetcher,
    `${githubOrigin}${refPath(manifest.repository, rebase.sourceBranch)}`,
    githubToken,
    'github',
  )).body, 'github_source_mismatch');
  const sourceObject = requireObject(source.object, 'github_source_mismatch');
  if (sourceObject.type !== 'commit' || sourceObject.sha !== rebase.sourceHeadSha) {
    throw new BaseRebaseEvidenceVerificationError('github_source_mismatch');
  }
  const compare = requireObject((await requestJson(
    fetcher,
    `${githubOrigin}${comparePath(manifest.repository, rebase.sourceHeadSha, rebase.resultHeadSha)}`,
    githubToken,
    'github',
  )).body, 'github_source_mismatch');
  const baseCommit = requireObject(compare.base_commit, 'github_source_mismatch');
  const mergeBase = requireObject(compare.merge_base_commit, 'github_source_mismatch');
  if (
    compare.status !== 'ahead' || compare.behind_by !== 0 || baseCommit.sha !== rebase.sourceHeadSha ||
    mergeBase.sha !== rebase.sourceHeadSha || branchUpdate.fastForward !== true ||
    branchUpdate.force !== false
  ) throw new BaseRebaseEvidenceVerificationError('github_source_mismatch');
}

async function verifyConflictSideEffects(
  manifest: Extract<BaseRebaseEvidenceManifestV1, { outcome: 'blocked' }>,
  audit: Record<string, unknown>,
  fetcher: typeof fetch,
  githubOrigin: string,
  githubToken: string,
): Promise<void> {
  const answers = requireObject(audit.answers, 'control_plane_projection_mismatch');
  const checks = requireObject(answers.checks, 'control_plane_projection_mismatch');
  const rebases = rows(checks, 'baseRebases');
  const effects = rows(checks, 'effectOutboxes');
  const evidence = rows(checks, 'evidence');
  const cutoff = Date.parse(manifest.conflict.observedAt);
  if (
    rebases.length !== 0 ||
    effects.some((effect) => effect.kind === 'execution_dispatch' &&
      typeof effect.createdAt === 'string' && Date.parse(effect.createdAt) >= cutoff) ||
    evidence.some((item) => {
      const observedAt = typeof item.observedAt === 'string' ? Date.parse(item.observedAt) : NaN;
      return Number.isFinite(observedAt) && observedAt >= Date.parse(manifest.conflict.observedAt);
    })
  ) throw new BaseRebaseEvidenceVerificationError('control_plane_projection_mismatch');
  const actions = requireObject((await requestJson(
    fetcher,
    `${githubOrigin}${actionsPath(manifest.repository)}`,
    githubToken,
    'github',
  )).body, 'github_response_invalid');
  const runs = Array.isArray(actions.workflow_runs) ? actions.workflow_runs : null;
  if (runs === null) throw new BaseRebaseEvidenceVerificationError('github_response_invalid');
  const matching = runs.map(record).filter((run): run is Record<string, unknown> =>
    run !== null && run.display_title === manifest.forbiddenAction.displayTitle &&
    run.path === manifest.forbiddenAction.workflowPath,
  );
  if (matching.length !== 0) throw new BaseRebaseEvidenceVerificationError('github_side_effect_mismatch');
  const targetRef = await requestJson(
    fetcher,
    `${githubOrigin}${refPath(manifest.repository, manifest.conflict.targetBranch)}`,
    githubToken,
    'github',
    [200, 404],
  );
  if (targetRef.status !== 404 || manifest.noSideEffects.targetBranchAbsent !== true) {
    throw new BaseRebaseEvidenceVerificationError('github_side_effect_mismatch');
  }
}

function projection(audit: Record<string, unknown>): {
  run: Record<string, unknown>;
  task: Record<string, unknown>;
  answers: Record<string, unknown>;
  checks: Record<string, unknown>;
} {
  const run = requireObject(audit.run, 'control_plane_projection_mismatch');
  const task = requireObject(audit.task, 'control_plane_projection_mismatch');
  const answers = requireObject(audit.answers, 'control_plane_projection_mismatch');
  const checks = requireObject(answers.checks, 'control_plane_projection_mismatch');
  return { run, task, answers, checks };
}

async function verifyPassed(
  input: Extract<BaseRebaseEvidenceManifestV1, { outcome: 'passed' }>,
  audit: Record<string, unknown>,
): Promise<void> {
  const { run, task, answers, checks } = projection(audit);
  const taskTarget = requireObject(task.target, 'control_plane_projection_mismatch');
  const rebases = rows(checks, 'baseRebases').filter((row) => row.rebaseId === input.rebase.rebaseId);
  const revisions = rows(checks, 'planRevisions').filter((row) => row.revisionId === input.rebase.revisionId);
  const attempts = rows(requireObject(answers.who, 'control_plane_projection_mismatch'), 'attempts')
    .filter((row) => row.attemptId === input.rebase.rebaseAttemptId);
  const changes = rows(answers, 'changes').filter((row) => row.kind === 'commit');
  const commands = rows(checks, 'commands').filter((row) => row.suiteId === input.verification.suiteId);
  const evidence = rows(checks, 'evidence').filter((row) => row.attemptId === input.rebase.rebaseAttemptId);
  if (
    audit.schemaVersion !== '1' || run.id !== input.runId || taskTarget.repository !== input.repository ||
    run.state === 'blocked' || run.activePlanId !== input.rebase.targetPlanId ||
    run.activePlanVersion !== input.rebase.targetPlanVersion || rebases.length !== 1 ||
    revisions.length !== 1 || attempts.length !== 1
  ) throw new BaseRebaseEvidenceVerificationError('control_plane_projection_mismatch');
  const revision = revisions[0]!;
  const attempt = attempts[0]!;
  const rebase = rebases[0]!;
  const sourcePlan = record(rebase.sourcePlan);
  const targetPlan = record(rebase.targetPlan);
  const priorPlan = record(revision.priorPlan);
  const replacementPlan = record(revision.newPlan);
  if (
    rebase.revisionId !== input.rebase.revisionId ||
    sourcePlan?.id !== input.rebase.sourcePlanId ||
    sourcePlan?.version !== input.rebase.sourcePlanVersion ||
    targetPlan?.id !== input.rebase.targetPlanId ||
    targetPlan?.version !== input.rebase.targetPlanVersion ||
    rebase.itemId !== input.rebase.planItemId ||
    rebase.sourceAttemptId !== input.rebase.sourceAttemptId ||
    rebase.attemptId !== input.rebase.rebaseAttemptId ||
    rebase.oldBaseSha !== input.rebase.oldBaseSha || rebase.newBaseSha !== input.rebase.newBaseSha ||
    rebase.sourceBranch !== input.rebase.sourceBranch || rebase.sourceHeadSha !== input.rebase.sourceHeadSha ||
    rebase.targetBranch !== input.rebase.targetBranch || rebase.resultHeadSha !== input.rebase.resultHeadSha ||
    rebase.status !== 'passed' || rebase.verificationSuiteId !== input.rebase.verificationSuiteId ||
    rebase.dispatchOutboxId !== input.rebase.dispatchOutboxId ||
    rebase.attemptStatus !== 'completed' || rebase.progressStatus !== 'passed' ||
    rebase.attemptHeadBranch !== input.rebase.targetBranch ||
    rebase.attemptHeadSha !== input.rebase.resultHeadSha ||
    rebase.githubRunId !== input.action.githubRunId || rebase.githubStatus !== input.action.status ||
    rebase.githubConclusion !== input.action.conclusion ||
    revision.sourceKind !== 'base_update' || revision.sourceRecordId !== input.baseComparison.observationId ||
    revision.sourceDigest !== input.baseComparison.sourceDigest || revision.status !== 'activated' ||
    priorPlan?.id !== input.rebase.sourcePlanId || priorPlan?.version !== input.rebase.sourcePlanVersion ||
    priorPlan?.status !== 'superseded' || replacementPlan?.id !== input.rebase.targetPlanId ||
    replacementPlan?.version !== input.rebase.targetPlanVersion || replacementPlan?.status !== 'active' ||
    replacementPlan?.baseSha !== input.rebase.newBaseSha ||
    attempt.mode !== 'review_fix' || attempt.status !== 'completed' ||
    attempt.githubRunId !== input.action.githubRunId || attempt.githubStatus !== input.action.status ||
    attempt.githubConclusion !== input.action.conclusion || attempt.headSha !== input.rebase.resultHeadSha ||
    changes.filter((change) => change.attemptId === input.rebase.rebaseAttemptId &&
      change.branch === input.rebase.targetBranch && change.headSha === input.rebase.resultHeadSha &&
      change.parentSha === input.rebase.sourceHeadSha).length !== 1 ||
    commands.length < 1 || commands.some((command) => command.status !== 'passed') ||
    !commands.some((command) => command.phase === 'targeted') ||
    !commands.some((command) => command.phase === 'required_verify') ||
    evidence.length !== input.verification.evidenceCount || evidence.length < 1 ||
    evidence.some((item) => item.status !== 'passed' || item.verificationStatus !== 'verified' ||
      item.sha !== input.rebase.resultHeadSha)
  ) throw new BaseRebaseEvidenceVerificationError('control_plane_projection_mismatch');
}

async function verifyBlocked(
  input: Extract<BaseRebaseEvidenceManifestV1, { outcome: 'blocked' }>,
  audit: Record<string, unknown>,
): Promise<void> {
  const { run, task, checks } = projection(audit);
  const target = requireObject(task.target, 'control_plane_projection_mismatch');
  const conflicts = rows(checks, 'baseConflicts').filter((row) => row.conflictId === input.conflict.conflictId);
  if (
    audit.schemaVersion !== '1' || run.id !== input.runId || target.repository !== input.repository ||
    conflicts.length !== 1
  ) throw new BaseRebaseEvidenceVerificationError('control_plane_projection_mismatch');
  const conflict = conflicts[0]!;
  const priorPlan = record(conflict.priorPlan);
  if (
    conflict.expectedRunVersion !== input.conflict.expectedRunVersion ||
    priorPlan?.id !== input.conflict.priorPlanId ||
    priorPlan?.version !== input.conflict.priorPlanVersion ||
    priorPlan?.digest !== input.conflict.priorPlanDigest ||
    conflict.repository !== input.conflict.repository || conflict.baseBranch !== input.conflict.baseBranch ||
    conflict.beforeSha !== input.conflict.beforeSha || conflict.afterSha !== input.conflict.afterSha ||
    conflict.relationship !== input.conflict.relationship || conflict.aheadBy !== input.conflict.aheadBy ||
    conflict.behindBy !== input.conflict.behindBy || conflict.mergeBaseSha !== input.conflict.mergeBaseSha ||
    conflict.referenceDigest !== input.conflict.referenceDigest ||
    conflict.comparisonDigest !== input.conflict.comparisonDigest ||
    conflict.sourceDigest !== input.conflict.sourceDigest ||
    conflict.blockerReason !== input.conflict.blockerReason ||
    conflict.neededHumanInput !== input.conflict.neededHumanInput ||
    conflict.runState !== 'blocked' || conflict.runVersion !== input.conflict.runVersion ||
    conflict.planStatus !== 'blocked' || conflict.cancelOutboxId !== input.conflict.cancelOutboxId ||
    run.state !== 'blocked' || run.version !== input.conflict.runVersion ||
    run.baseSha !== input.conflict.beforeSha || conflict.cancelOutboxId !== input.conflict.cancelOutboxId
  ) throw new BaseRebaseEvidenceVerificationError('control_plane_projection_mismatch');
}

export async function verifyBaseRebaseEvidence(
  input: BaseRebaseEvidenceManifestV1,
  options: BaseRebaseEvidenceVerifierOptions,
): Promise<BaseRebaseEvidenceVerificationSummary> {
  const parsed = BaseRebaseEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new BaseRebaseEvidenceVerificationError('manifest_invalid');
  if (!TOKEN_PATTERN.test(options.controlPlaneToken) || !TOKEN_PATTERN.test(options.githubToken)) {
    throw new BaseRebaseEvidenceVerificationError('configuration_invalid');
  }
  const controlPlaneOrigin = origin(options.controlPlaneOrigin);
  const githubOrigin = origin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const audit = await getControlAudit(fetcher, controlPlaneOrigin, options.controlPlaneToken, input.runId);
  if (input.outcome === 'passed') {
    await verifyPassed(input, audit);
    await verifyBaseComparison(input, fetcher, githubOrigin, options.githubToken);
    await verifyAction(input, fetcher, githubOrigin, options.githubToken);
    await verifySuccessGitRefs(input, fetcher, githubOrigin, options.githubToken);
    return {
      schemaVersion: '1', evidenceId: input.evidenceId, runId: input.runId,
      repository: input.repository, outcome: 'passed', rebase: 'verified',
      baseComparison: 'verified', branchUpdate: 'fast_forward_no_force',
      action: 'verified', verification: 'verified',
    };
  }
  await verifyBlocked(input, audit);
  await verifyBaseComparison(input, fetcher, githubOrigin, options.githubToken);
  await verifyConflictSideEffects(input, audit, fetcher, githubOrigin, options.githubToken);
  return {
    schemaVersion: '1', evidenceId: input.evidenceId, runId: input.runId,
    repository: input.repository, outcome: 'blocked', conflict: 'verified',
    baseComparison: 'verified', sideEffects: 'none', humanAction: 'manual_rebase',
  };
}
