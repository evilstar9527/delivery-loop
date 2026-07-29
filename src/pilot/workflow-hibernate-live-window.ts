import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import { analysisAttemptId } from '../domain/workflow-event.js';
import {
  TaskEnvelopeSchema,
  taskRevisionDigest,
  taskRevisionIds,
  type TaskEnvelope,
} from '../domain/task.js';
import {
  executeConditionalHibernateAfter,
  verifyWorkflowHibernateWindowSnapshot,
  type WorkflowHibernateAfterRequest,
  type WorkflowHibernateAfterResult,
  type WorkflowHibernateWindowSnapshot,
} from './workflow-hibernate-window-guard.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[-A-Za-z0-9_.]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BUNDLE_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_AUTHORIZATION_WINDOW_MS = 30 * 60_000;
const MAX_LIVE_WINDOW_WAIT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 500;

export const WorkflowHibernateWindowAuthorizationV1Schema = z.object({
  schemaVersion: z.literal('1'),
  authorizationId: z.string().regex(ID_PATTERN),
  authorizedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  authorityDigest: z.string().regex(SHA256_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  baseBranch: z.string().regex(BRANCH_PATTERN)
    .refine((value) => !value.includes('..') && !value.includes('//')),
  analysisWorkflowHeadSha: z.string().regex(SHA_PATTERN),
  task: z.object({
    envelopeDigest: z.string().regex(SHA256_PATTERN),
    revisionDigest: z.string().regex(SHA256_PATTERN),
    taskId: z.string().regex(ID_PATTERN),
    runId: z.string().regex(ID_PATTERN),
    attemptId: z.string().regex(ID_PATTERN),
    idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
  }).strict(),
  source: z.object({
    sha: z.string().regex(SHA_PATTERN),
    bundleSha256: z.string().regex(BUNDLE_SHA256_PATTERN),
    bundleBytes: z.number().int().positive().max(10 * 1_024 * 1_024),
  }).strict(),
  beforeDeployment: z.object({
    deploymentId: z.string().regex(UUID_PATTERN),
    versionId: z.string().regex(UUID_PATTERN),
    createdAt: z.iso.datetime({ offset: true }),
  }).strict(),
  effects: z.object({
    taskCreates: z.literal(1),
    analysisActions: z.literal(1),
    afterDeployments: z.literal(1),
    rollbacks: z.literal(0),
  }).strict(),
}).strict().superRefine((value, context) => {
  const authorizedAt = Date.parse(value.authorizedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (
    expiresAt <= authorizedAt ||
    expiresAt - authorizedAt > MAX_AUTHORIZATION_WINDOW_MS ||
    value.task.attemptId !== analysisAttemptId(value.task.runId)
  ) context.addIssue({ code: 'custom', message: 'hibernate window authority is inconsistent' });
});

export type WorkflowHibernateWindowAuthorizationV1 = z.infer<
  typeof WorkflowHibernateWindowAuthorizationV1Schema
>;

export async function workflowHibernateWindowAuthorityDigest(
  input: WorkflowHibernateWindowAuthorizationV1,
): Promise<string> {
  const payload: Record<string, unknown> = { ...input };
  delete payload.authorityDigest;
  return await canonicalSha256(payload);
}

export type WorkflowHibernateLiveWindowErrorCode =
  | 'configuration_invalid'
  | 'authorization_invalid'
  | 'authorization_inactive'
  | 'task_invalid'
  | 'task_authorization_mismatch'
  | 'source_verification_failed'
  | 'before_deployment_mismatch'
  | 'task_already_exists'
  | 'task_create_failed'
  | 'task_create_response_mismatch'
  | 'external_unavailable'
  | 'external_response_invalid'
  | 'secret_leak_detected'
  | 'live_snapshot_not_ready'
  | 'live_snapshot_conflict'
  | 'live_window_timeout'
  | 'after_deploy_failed';

export class WorkflowHibernateLiveWindowError extends Error {
  constructor(readonly code: WorkflowHibernateLiveWindowErrorCode) {
    super(`Workflow hibernate live window failed: ${code}`);
    this.name = 'WorkflowHibernateLiveWindowError';
  }
}

export interface FrozenWorkerSourceVerification {
  headSha: string;
  bundleSha256: string;
  bundleBytes: number;
  matchingBundleBuilds: number;
  clean: boolean;
}

export interface LiveBeforeDeployment {
  deploymentId: string;
  versionId: string;
  createdAt: string;
  trafficPercentage: number;
}

export interface WorkflowHibernateLiveWindowDependencies {
  verifyFrozenSource(
    authorization: WorkflowHibernateWindowAuthorizationV1,
  ): Promise<FrozenWorkerSourceVerification>;
  readBeforeDeployment(
    authorization: WorkflowHibernateWindowAuthorizationV1,
  ): Promise<LiveBeforeDeployment>;
  taskExists(authorization: WorkflowHibernateWindowAuthorizationV1): Promise<boolean>;
  createTask(
    task: TaskEnvelope,
    authorization: WorkflowHibernateWindowAuthorizationV1,
  ): Promise<{ accepted: boolean; taskId: string; runId: string }>;
  readSnapshot(
    authorization: WorkflowHibernateWindowAuthorizationV1,
  ): Promise<WorkflowHibernateWindowSnapshot>;
  deployAfter(request: WorkflowHibernateAfterRequest): Promise<WorkflowHibernateAfterResult>;
  sleep(milliseconds: number): Promise<void>;
  now?: () => Date;
}

export interface WorkflowHibernateLiveWindowSummary {
  schemaVersion: '1';
  authorizationId: string;
  taskId: string;
  runId: string;
  attemptId: string;
  actionBaseSha: string;
  beforeDeploymentId: string;
  afterDeploymentId: string;
  afterVersionId: string;
  taskCreateRequests: 1;
  afterDeployRequests: 1;
  rollbackRequests: 0;
}

function fail(code: WorkflowHibernateLiveWindowErrorCode): never {
  throw new WorkflowHibernateLiveWindowError(code);
}

function sameTime(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

async function assertTaskAuthority(
  authorization: WorkflowHibernateWindowAuthorizationV1,
  taskInput: TaskEnvelope,
): Promise<void> {
  const parsed = TaskEnvelopeSchema.safeParse(taskInput);
  if (!parsed.success) fail('task_invalid');
  const task = parsed.data;
  const ids = await taskRevisionIds(task);
  if (
    await canonicalSha256(task) !== authorization.task.envelopeDigest ||
    await taskRevisionDigest(task) !== authorization.task.revisionDigest ||
    ids.taskId !== authorization.task.taskId || ids.runId !== authorization.task.runId ||
    analysisAttemptId(ids.runId) !== authorization.task.attemptId ||
    `${task.target.owner}/${task.target.repo}` !== authorization.repository ||
    task.target.baseBranch !== authorization.baseBranch ||
    task.target.environment !== 'none' ||
    task.policy.allowRepositoryWrite || task.policy.allowTestDeploy ||
    task.policy.allowProductionDeploy || !task.policy.requireHumanApproval
  ) fail('task_authorization_mismatch');
}

function assertSource(
  source: FrozenWorkerSourceVerification,
  authorization: WorkflowHibernateWindowAuthorizationV1,
): void {
  if (
    source.headSha !== authorization.source.sha ||
    source.bundleSha256 !== authorization.source.bundleSha256 ||
    source.bundleBytes !== authorization.source.bundleBytes ||
    source.matchingBundleBuilds !== 2 || !source.clean
  ) fail('source_verification_failed');
}

function assertBefore(
  deployment: LiveBeforeDeployment,
  authorization: WorkflowHibernateWindowAuthorizationV1,
): void {
  if (
    deployment.deploymentId !== authorization.beforeDeployment.deploymentId ||
    deployment.versionId !== authorization.beforeDeployment.versionId ||
    !sameTime(deployment.createdAt, authorization.beforeDeployment.createdAt) ||
    deployment.trafficPercentage !== 100
  ) fail('before_deployment_mismatch');
}

async function waitForEligibleSnapshot(
  authorization: WorkflowHibernateWindowAuthorizationV1,
  dependencies: WorkflowHibernateLiveWindowDependencies,
  startedAt: number,
): Promise<void> {
  const now = dependencies.now ?? (() => new Date());
  const expectation = {
    runId: authorization.task.runId,
    attemptId: authorization.task.attemptId,
    sourceSha: authorization.source.sha,
    bundleSha256: authorization.source.bundleSha256,
    beforeDeploymentId: authorization.beforeDeployment.deploymentId,
    beforeVersionId: authorization.beforeDeployment.versionId,
    maximumSnapshotAgeMs: 5_000,
  } as const;
  while (true) {
    const current = now().getTime();
    if (
      !Number.isFinite(current) || current >= Date.parse(authorization.expiresAt) ||
      current - startedAt >= MAX_LIVE_WINDOW_WAIT_MS
    ) fail('live_window_timeout');
    try {
      verifyWorkflowHibernateWindowSnapshot(
        expectation,
        await dependencies.readSnapshot(authorization),
        now(),
      );
      return;
    } catch (error) {
      if (
        !(error instanceof WorkflowHibernateLiveWindowError) ||
        error.code !== 'live_snapshot_not_ready'
      ) throw error;
    }
    await dependencies.sleep(POLL_INTERVAL_MS);
  }
}

export async function executeWorkflowHibernateLiveWindow(
  authorizationInput: WorkflowHibernateWindowAuthorizationV1,
  taskInput: TaskEnvelope,
  dependencies: WorkflowHibernateLiveWindowDependencies,
): Promise<WorkflowHibernateLiveWindowSummary> {
  const parsed = WorkflowHibernateWindowAuthorizationV1Schema.safeParse(authorizationInput);
  if (!parsed.success) fail('authorization_invalid');
  const authorization = parsed.data;
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().getTime();
  if (
    !Number.isFinite(startedAt) ||
    startedAt < Date.parse(authorization.authorizedAt) ||
    startedAt >= Date.parse(authorization.expiresAt)
  ) fail('authorization_inactive');
  if (
    await workflowHibernateWindowAuthorityDigest(authorization) !==
    authorization.authorityDigest
  ) fail('authorization_invalid');
  await assertTaskAuthority(authorization, taskInput);
  assertSource(await dependencies.verifyFrozenSource(authorization), authorization);
  assertBefore(await dependencies.readBeforeDeployment(authorization), authorization);
  if (await dependencies.taskExists(authorization)) fail('task_already_exists');

  let created: { accepted: boolean; taskId: string; runId: string };
  try { created = await dependencies.createTask(taskInput, authorization); }
  catch { fail('task_create_failed'); }
  if (
    !created.accepted || created.taskId !== authorization.task.taskId ||
    created.runId !== authorization.task.runId
  ) fail('task_create_response_mismatch');

  await waitForEligibleSnapshot(authorization, dependencies, startedAt);
  const after = await executeConditionalHibernateAfter({
    runId: authorization.task.runId,
    attemptId: authorization.task.attemptId,
    sourceSha: authorization.source.sha,
    bundleSha256: authorization.source.bundleSha256,
    beforeDeploymentId: authorization.beforeDeployment.deploymentId,
    beforeVersionId: authorization.beforeDeployment.versionId,
    maximumSnapshotAgeMs: 5_000,
  }, {
    readSnapshot: async () => await dependencies.readSnapshot(authorization),
    deployAfter: dependencies.deployAfter,
    now,
  });
  return {
    schemaVersion: '1',
    authorizationId: authorization.authorizationId,
    taskId: authorization.task.taskId,
    runId: authorization.task.runId,
    attemptId: authorization.task.attemptId,
    actionBaseSha: authorization.analysisWorkflowHeadSha,
    beforeDeploymentId: after.beforeDeploymentId,
    afterDeploymentId: after.afterDeploymentId,
    afterVersionId: after.afterVersionId,
    taskCreateRequests: 1,
    afterDeployRequests: 1,
    rollbackRequests: 0,
  };
}
