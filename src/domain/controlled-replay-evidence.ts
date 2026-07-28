import { z } from 'zod';
import { PlanEffectSchema } from './plan.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const MAX_REPLAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const MUTATING_EFFECTS = new Set([
  'repo_write',
  'test_deploy',
  'merge',
  'production_deploy',
]);

const ResourceIdSchema = z.string().regex(ID_PATTERN);
const ShaSchema = z.string().regex(SHA_PATTERN);
const DigestSchema = z.string().regex(DIGEST_PATTERN);
const GitHubIdSchema = z.string().regex(GITHUB_ID_PATTERN);
const HeadBranchSchema = z.string().max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.includes('..') && !value.endsWith('/') && !value.endsWith('.'));

const ReplayEffectSchema = z.object({
  effect: PlanEffectSchema,
  approvalId: ResourceIdSchema.optional(),
}).strict().superRefine((value, context) => {
  const mutating = MUTATING_EFFECTS.has(value.effect);
  if (mutating !== (value.approvalId !== undefined)) {
    context.addIssue({ code: 'custom', message: 'replay effect approval binding is invalid' });
  }
});

const DeploymentSchema = z.object({
  kind: z.enum(['test', 'production']),
  deploymentId: ResourceIdSchema,
  evidenceId: ResourceIdSchema,
  githubDeploymentId: GitHubIdSchema,
  environment: z.enum(['test', 'production']),
  sha: ShaSchema,
}).strict().superRefine((value, context) => {
  if (value.kind !== value.environment) {
    context.addIssue({ code: 'custom', message: 'deployment environment must match kind' });
  }
});

export const ControlledReplayEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: ResourceIdSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: z.iso.datetime({ offset: true }),
  window: z.object({
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
  }).strict(),
  runId: ResourceIdSchema,
  expectedRunState: z.literal('succeeded'),
  postReplayRunVersion: z.number().int().positive(),
  planId: ResourceIdSchema,
  planVersion: z.number().int().positive(),
  replay: z.object({
    replayId: ResourceIdSchema,
    expectedRunVersion: z.number().int().nonnegative(),
    planItemId: ResourceIdSchema,
    effectSnapshotDigest: DigestSchema,
    outboxId: ResourceIdSchema,
    createdAt: z.iso.datetime({ offset: true }),
    restartObservedAt: z.iso.datetime({ offset: true }),
    effects: z.array(ReplayEffectSchema).min(1).max(20),
    dispatchOutboxIds: z.array(ResourceIdSchema).min(1).max(50),
  }).strict(),
  agentActions: z.array(z.object({
    attemptId: ResourceIdSchema,
    actionRunId: GitHubIdSchema,
    workflowHeadSha: ShaSchema,
  }).strict()).min(1).max(50),
  pullRequest: z.object({
    publicationId: ResourceIdSchema,
    evidenceId: ResourceIdSchema,
    number: z.number().int().positive(),
    headBranch: HeadBranchSchema,
    headSha: ShaSchema,
  }).strict(),
  deployments: z.array(DeploymentSchema).min(1).max(20),
}).strict().superRefine((manifest, context) => {
  const startedAt = Date.parse(manifest.window.startedAt);
  const endedAt = Date.parse(manifest.window.endedAt);
  const recordedAt = Date.parse(manifest.recordedAt);
  const replayCreatedAt = Date.parse(manifest.replay.createdAt);
  const restartObservedAt = Date.parse(manifest.replay.restartObservedAt);
  if (
    endedAt <= startedAt || endedAt - startedAt > MAX_REPLAY_WINDOW_MS ||
    replayCreatedAt < startedAt || restartObservedAt < replayCreatedAt ||
    restartObservedAt > endedAt || recordedAt < endedAt
  ) context.addIssue({ code: 'custom', message: 'replay evidence time window is invalid' });
  if (manifest.postReplayRunVersion <= manifest.replay.expectedRunVersion) {
    context.addIssue({ code: 'custom', message: 'post-replay Run version must advance' });
  }
  const effects = manifest.replay.effects.map((effect) => effect.effect);
  if (
    new Set(effects).size !== effects.length || !effects.includes('repo_write') ||
    effects.some((effect, index) => index > 0 && effect <= effects[index - 1]!)
  ) {
    context.addIssue({ code: 'custom', message: 'replay effects must be unique and include repo_write' });
  }
  for (const deployment of manifest.deployments) {
    const requiredEffect = deployment.kind === 'test' ? 'test_deploy' : 'production_deploy';
    if (!effects.includes(requiredEffect)) {
      context.addIssue({ code: 'custom', message: 'deployment effect is missing from replay snapshot' });
    }
  }
  const unique = (values: string[], message: string): void => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message });
    }
  };
  unique(manifest.replay.dispatchOutboxIds, 'dispatch outbox IDs must be unique');
  unique(manifest.agentActions.map((action) => action.attemptId), 'Attempt IDs must be unique');
  unique(manifest.agentActions.map((action) => action.actionRunId), 'Action run IDs must be unique');
  unique(
    manifest.deployments.map((deployment) => deployment.deploymentId),
    'deployment IDs must be unique',
  );
  unique(
    manifest.deployments.map((deployment) => deployment.githubDeploymentId),
    'GitHub deployment IDs must be unique',
  );
  unique(
    manifest.deployments.map((deployment) => deployment.evidenceId),
    'deployment Evidence IDs must be unique',
  );
});

export type ControlledReplayEvidenceManifestV1 = z.infer<
  typeof ControlledReplayEvidenceManifestV1Schema
>;
