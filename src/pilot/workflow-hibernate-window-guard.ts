const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type WorkflowHibernateWindowGuardErrorCode =
  | 'configuration_invalid'
  | 'snapshot_invalid'
  | 'snapshot_stale'
  | 'source_sha_mismatch'
  | 'source_dirty'
  | 'bundle_mismatch'
  | 'bundle_verification_incomplete'
  | 'before_deployment_mismatch'
  | 'before_traffic_mismatch'
  | 'deployment_already_during_wait'
  | 'run_projection_mismatch'
  | 'analysis_attempt_mismatch'
  | 'analysis_dispatch_mismatch'
  | 'analysis_callback_already_recorded'
  | 'github_action_mismatch'
  | 'github_action_not_active'
  | 'workflow_wait_mismatch'
  | 'workflow_already_resumed'
  | 'guard_identity_changed'
  | 'after_deploy_failed'
  | 'after_deployment_mismatch'
  | 'after_deployment_outside_wait';

export class WorkflowHibernateWindowGuardError extends Error {
  constructor(readonly code: WorkflowHibernateWindowGuardErrorCode) {
    super(`Workflow hibernate window guard failed: ${code}`);
    this.name = 'WorkflowHibernateWindowGuardError';
  }
}

interface DeploymentSnapshot {
  deploymentId: string;
  versionId: string;
  createdAt: string;
  trafficPercentage: number;
}

export interface WorkflowHibernateWindowSnapshot {
  observedAt: string;
  source: {
    headSha: string;
    bundleSha256: string;
    clean: boolean;
    matchingBundleBuilds: number;
  };
  deployment: DeploymentSnapshot & {
    deploymentsDuringWait: number;
  };
  run: {
    runId: string;
    state: string;
    activePlanId: string | null;
    analysisAttemptCount: number;
    analysisDispatchOutboxCount: number;
    workflowInstanceCount: number;
  };
  analysis: {
    attemptId: string;
    attemptStatus: string;
    dispatchOutboxId: string;
    dispatchOutboxState: string;
    resultSignalOutboxCount: number;
    actionRunId: string;
    actionStatus: string;
    actionConclusion: string | null;
    actionRunCount: number;
  };
  workflow: {
    instanceId: string;
    status: string;
    registerRun: { status: string; endedAt: string };
    dispatchAnalysisAttempt: { status: string; endedAt: string };
    analysisWait: { status: string; startedAt: string; endedAt: string | null };
    resumedStepCount: number;
  };
}

export interface WorkflowHibernateAfterResult {
  deployment: DeploymentSnapshot;
  observedAt: string;
  workflow: {
    instanceId: string;
    analysisWaitStartedAt: string;
    analysisWaitEndedAt: string | null;
  };
  deploymentsDuringWait: number;
}

export interface WorkflowHibernateWindowExpectation {
  runId: string;
  attemptId: string;
  sourceSha: string;
  bundleSha256: string;
  beforeDeploymentId: string;
  beforeVersionId: string;
  maximumSnapshotAgeMs: number;
}

export interface WorkflowHibernateAfterRequest {
  runId: string;
  sourceSha: string;
  bundleSha256: string;
  expectedBeforeDeploymentId: string;
  message: string;
  strict: true;
}

export interface ConditionalHibernateAfterDependencies {
  readSnapshot(): Promise<WorkflowHibernateWindowSnapshot>;
  deployAfter(request: WorkflowHibernateAfterRequest): Promise<WorkflowHibernateAfterResult>;
  now?: () => Date;
}

export interface ConditionalHibernateAfterSummary {
  runId: string;
  attemptId: string;
  beforeDeploymentId: string;
  afterDeploymentId: string;
  afterVersionId: string;
  deployed: true;
  rollbackAttempted: false;
}

function validDate(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function fail(code: WorkflowHibernateWindowGuardErrorCode): never {
  throw new WorkflowHibernateWindowGuardError(code);
}

function assertExpectation(input: WorkflowHibernateWindowExpectation): void {
  if (
    !ID_PATTERN.test(input.runId) ||
    !ID_PATTERN.test(input.attemptId) ||
    !SHA_PATTERN.test(input.sourceSha) ||
    !SHA256_PATTERN.test(input.bundleSha256) ||
    !UUID_PATTERN.test(input.beforeDeploymentId) ||
    !UUID_PATTERN.test(input.beforeVersionId) ||
    input.maximumSnapshotAgeMs !== 5_000
  ) fail('configuration_invalid');
}

function assertSnapshotShape(snapshot: WorkflowHibernateWindowSnapshot): {
  observedAt: number;
  deploymentCreatedAt: number;
  registerEndedAt: number;
  dispatchEndedAt: number;
  waitStartedAt: number;
} {
  const observedAt = validDate(snapshot.observedAt);
  const deploymentCreatedAt = validDate(snapshot.deployment.createdAt);
  const registerEndedAt = validDate(snapshot.workflow.registerRun.endedAt);
  const dispatchEndedAt = validDate(snapshot.workflow.dispatchAnalysisAttempt.endedAt);
  const waitStartedAt = validDate(snapshot.workflow.analysisWait.startedAt);
  if (
    observedAt === null || deploymentCreatedAt === null || registerEndedAt === null ||
    dispatchEndedAt === null || waitStartedAt === null ||
    !finiteInteger(snapshot.source.matchingBundleBuilds) ||
    !finiteInteger(snapshot.deployment.deploymentsDuringWait) ||
    !finiteInteger(snapshot.run.analysisAttemptCount) ||
    !finiteInteger(snapshot.run.analysisDispatchOutboxCount) ||
    !finiteInteger(snapshot.run.workflowInstanceCount) ||
    !finiteInteger(snapshot.analysis.resultSignalOutboxCount) ||
    !finiteInteger(snapshot.analysis.actionRunCount) ||
    !finiteInteger(snapshot.workflow.resumedStepCount) ||
    deploymentCreatedAt > registerEndedAt || registerEndedAt > dispatchEndedAt ||
    dispatchEndedAt > waitStartedAt || waitStartedAt > observedAt
  ) fail('snapshot_invalid');
  return {
    observedAt,
    deploymentCreatedAt,
    registerEndedAt,
    dispatchEndedAt,
    waitStartedAt,
  };
}

function assertFreshSnapshot(
  snapshot: WorkflowHibernateWindowSnapshot,
  expected: WorkflowHibernateWindowExpectation,
  now: Date,
): void {
  const timing = assertSnapshotShape(snapshot);
  const ageMs = now.getTime() - timing.observedAt;
  if (!Number.isFinite(now.getTime()) || ageMs < 0 || ageMs > expected.maximumSnapshotAgeMs) {
    fail('snapshot_stale');
  }
  if (snapshot.source.headSha !== expected.sourceSha) fail('source_sha_mismatch');
  if (!snapshot.source.clean) fail('source_dirty');
  if (snapshot.source.bundleSha256 !== expected.bundleSha256) fail('bundle_mismatch');
  if (snapshot.source.matchingBundleBuilds !== 2) fail('bundle_verification_incomplete');
  if (
    snapshot.deployment.deploymentId !== expected.beforeDeploymentId ||
    snapshot.deployment.versionId !== expected.beforeVersionId
  ) fail('before_deployment_mismatch');
  if (snapshot.deployment.trafficPercentage !== 100) fail('before_traffic_mismatch');
  if (snapshot.deployment.deploymentsDuringWait !== 0) {
    fail('deployment_already_during_wait');
  }
  if (
    snapshot.run.runId !== expected.runId || snapshot.run.state !== 'planning' ||
    snapshot.run.activePlanId !== null || snapshot.run.workflowInstanceCount !== 1
  ) fail('run_projection_mismatch');
  if (
    snapshot.run.analysisAttemptCount !== 1 ||
    snapshot.analysis.attemptId !== expected.attemptId
  ) fail('analysis_attempt_mismatch');
  if (
    snapshot.run.analysisDispatchOutboxCount !== 1 ||
    !ID_PATTERN.test(snapshot.analysis.dispatchOutboxId) ||
    snapshot.analysis.dispatchOutboxState !== 'settled'
  ) fail('analysis_dispatch_mismatch');
  if (
    snapshot.analysis.attemptStatus === 'completed' ||
    snapshot.analysis.resultSignalOutboxCount !== 0
  ) fail('analysis_callback_already_recorded');
  if (!['pending', 'starting', 'running'].includes(snapshot.analysis.attemptStatus)) {
    fail('analysis_attempt_mismatch');
  }
  if (
    snapshot.analysis.actionRunCount !== 1 ||
    !/^[1-9][0-9]{0,31}$/.test(snapshot.analysis.actionRunId)
  ) fail('github_action_mismatch');
  if (
    !['queued', 'in_progress'].includes(snapshot.analysis.actionStatus) ||
    snapshot.analysis.actionConclusion !== null
  ) fail('github_action_not_active');
  if (
    snapshot.workflow.instanceId !== expected.runId ||
    snapshot.workflow.status !== 'waiting' ||
    snapshot.workflow.registerRun.status !== 'complete' ||
    snapshot.workflow.dispatchAnalysisAttempt.status !== 'complete' ||
    snapshot.workflow.analysisWait.status !== 'waiting' ||
    snapshot.workflow.analysisWait.endedAt !== null
  ) fail('workflow_wait_mismatch');
  if (snapshot.workflow.resumedStepCount !== 0) fail('workflow_already_resumed');
}

function assertSameGuardIdentity(
  first: WorkflowHibernateWindowSnapshot,
  second: WorkflowHibernateWindowSnapshot,
): void {
  if (
    first.deployment.deploymentId !== second.deployment.deploymentId ||
    first.deployment.versionId !== second.deployment.versionId ||
    first.analysis.attemptId !== second.analysis.attemptId ||
    first.analysis.dispatchOutboxId !== second.analysis.dispatchOutboxId ||
    first.analysis.actionRunId !== second.analysis.actionRunId ||
    first.workflow.instanceId !== second.workflow.instanceId ||
    first.workflow.analysisWait.startedAt !== second.workflow.analysisWait.startedAt ||
    Date.parse(second.observedAt) < Date.parse(first.observedAt)
  ) fail('guard_identity_changed');
}

function assertAfterResult(
  result: WorkflowHibernateAfterResult,
  expected: WorkflowHibernateWindowExpectation,
  guard: WorkflowHibernateWindowSnapshot,
): void {
  const createdAt = validDate(result.deployment.createdAt);
  const observedAt = validDate(result.observedAt);
  const waitStartedAt = validDate(result.workflow.analysisWaitStartedAt);
  const waitEndedAt = result.workflow.analysisWaitEndedAt === null
    ? null : validDate(result.workflow.analysisWaitEndedAt);
  if (
    createdAt === null || observedAt === null || waitStartedAt === null ||
    (result.workflow.analysisWaitEndedAt !== null && waitEndedAt === null) ||
    observedAt < createdAt || createdAt < Date.parse(guard.observedAt)
  ) fail('after_deployment_mismatch');
  if (
    !UUID_PATTERN.test(result.deployment.deploymentId) ||
    !UUID_PATTERN.test(result.deployment.versionId) ||
    result.deployment.deploymentId === expected.beforeDeploymentId ||
    result.deployment.versionId === expected.beforeVersionId ||
    result.deployment.trafficPercentage !== 100 ||
    result.deploymentsDuringWait !== 1 ||
    result.workflow.instanceId !== expected.runId ||
    result.workflow.analysisWaitStartedAt !== guard.workflow.analysisWait.startedAt
  ) fail('after_deployment_mismatch');
  if (createdAt <= waitStartedAt || (waitEndedAt !== null && createdAt >= waitEndedAt)) {
    fail('after_deployment_outside_wait');
  }
}

/**
 * Executes the one authorized production after deployment only while two live,
 * fresh observations prove that the ordinary analysis callback has not yet
 * been recorded. The caller owns live collection and the exact deploy command;
 * this function does not create production authority and deliberately exposes
 * no rollback dependency.
 */
export async function executeConditionalHibernateAfter(
  expected: WorkflowHibernateWindowExpectation,
  dependencies: ConditionalHibernateAfterDependencies,
): Promise<ConditionalHibernateAfterSummary> {
  assertExpectation(expected);
  const now = dependencies.now ?? (() => new Date());
  const first = await dependencies.readSnapshot();
  assertFreshSnapshot(first, expected, now());
  const finalGuard = await dependencies.readSnapshot();
  assertFreshSnapshot(finalGuard, expected, now());
  assertSameGuardIdentity(first, finalGuard);

  let after: WorkflowHibernateAfterResult;
  try {
    after = await dependencies.deployAfter({
      runId: expected.runId,
      sourceSha: expected.sourceSha,
      bundleSha256: expected.bundleSha256,
      expectedBeforeDeploymentId: expected.beforeDeploymentId,
      message: `phase1-hibernate-after run@${expected.runId}`,
      strict: true,
    });
  } catch {
    fail('after_deploy_failed');
  }
  assertAfterResult(after, expected, finalGuard);
  return {
    runId: expected.runId,
    attemptId: expected.attemptId,
    beforeDeploymentId: expected.beforeDeploymentId,
    afterDeploymentId: after.deployment.deploymentId,
    afterVersionId: after.deployment.versionId,
    deployed: true,
    rollbackAttempted: false,
  };
}
