import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WORKFLOW_PATH = '.github/workflows/delivery-production-deploy.yml';
const OIDC_AUDIENCE = 'delivery-loop-production-deploy';
const TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true });

const EvidenceUrlSchema = z.string().min(1).max(2_048).superRefine((raw, context) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    context.addIssue({ code: 'custom', message: 'evidence URL is invalid' });
    return;
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) context.addIssue({ code: 'custom', message: 'evidence URL is unsafe' });
});

const ObservationSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  sourceKind: z.enum(['webhook', 'api']),
  digest: z.string().regex(DIGEST_PATTERN),
  state: z.enum(['received', 'applied', 'ignored']),
  observedAt: TIMESTAMP_SCHEMA,
}).strict();

const ActionStatusSchema = z.enum([
  'requested', 'queued', 'waiting', 'in_progress', 'completed',
]);

const ActionConclusionSchema = z.enum([
  'success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out',
  'action_required', 'stale', 'startup_failure',
]);

const DeploymentCaseSchema = z.object({
  caseId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  runVersion: z.number().int().nonnegative(),
  currentRunVersion: z.number().int().nonnegative(),
  runState: z.enum(['deploying', 'succeeded', 'failed']),
  repository: z.string().regex(REPOSITORY_PATTERN),
  taskRevision: z.string().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
  planId: z.string().regex(ID_PATTERN),
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(DIGEST_PATTERN),
  attemptId: z.string().regex(ID_PATTERN),
  approvalId: z.string().regex(ID_PATTERN),
  deploymentId: z.string().regex(ID_PATTERN),
  githubDeploymentId: z.string().regex(GITHUB_ID_PATTERN),
  mergeId: z.string().regex(ID_PATTERN),
  mergeSha: z.string().regex(SHA_PATTERN),
  baseSha: z.string().regex(SHA_PATTERN),
  environment: z.literal('production'),
  workflowPath: z.literal(WORKFLOW_PATH),
  oidcAudience: z.literal(OIDC_AUDIENCE),
  roleRef: z.string().regex(/^production:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/),
  oidcAttestationId: z.string().regex(ID_PATTERN).nullable(),
  oidcGithubRunId: z.string().regex(GITHUB_ID_PATTERN).nullable(),
  oidcSubject: z.string().regex(/^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+:environment:production$/).nullable(),
  actionRunId: z.string().regex(GITHUB_ID_PATTERN),
  actionStatus: ActionStatusSchema,
  actionConclusion: ActionConclusionSchema.nullable(),
  actionUrl: EvidenceUrlSchema,
  externalState: z.enum(['in_progress', 'success', 'failure', 'error']),
  externalUpdatedAt: TIMESTAMP_SCHEMA,
  deploymentStatus: z.enum(['created_unverified', 'in_progress', 'succeeded', 'failed']),
  environmentUrl: EvidenceUrlSchema.nullable(),
  deploymentEvidenceId: z.string().regex(ID_PATTERN).nullable(),
  deploymentEvidenceStatus: z.enum(['passed', 'failed']).nullable(),
  webhook: ObservationSchema,
  apiObservation: ObservationSchema,
  noDuplicate: z.object({
    attempts: z.literal(1),
    deployments: z.literal(1),
    deployOutboxes: z.literal(1),
    deploymentEvidence: z.union([z.literal(0), z.literal(1)]),
  }).strict(),
}).strict().superRefine((item, context) => {
  const subjectRepository = item.oidcSubject === null
    ? null
    : item.oidcSubject.slice('repo:'.length).split(':environment:')[0];
  if (
    subjectRepository !== null && subjectRepository !== item.repository ||
    item.currentRunVersion < item.runVersion ||
    item.actionUrl !== `https://github.com/${item.repository}/actions/runs/${item.actionRunId}` ||
    item.webhook.sourceKind !== 'webhook' || item.apiObservation.sourceKind !== 'api' ||
    item.webhook.state !== 'applied' || item.apiObservation.state !== 'applied'
  ) context.addIssue({ code: 'custom', message: 'production deployment identity is inconsistent' });

  if (item.externalState === 'in_progress') {
    if (
      item.runState !== 'deploying' || item.deploymentStatus !== 'in_progress' ||
      item.actionStatus === 'completed' || item.actionConclusion !== null ||
      item.deploymentEvidenceId !== null || item.deploymentEvidenceStatus !== null ||
      item.noDuplicate.deploymentEvidence !== 0 || item.currentRunVersion !== item.runVersion
    ) context.addIssue({ code: 'custom', message: 'in-progress production deployment is inconsistent' });
  } else if (item.externalState === 'success') {
    if (
      item.runState !== 'succeeded' || item.deploymentStatus !== 'succeeded' ||
      item.actionStatus !== 'completed' || item.actionConclusion !== 'success' ||
      item.oidcAttestationId === null || item.oidcGithubRunId === null ||
      item.oidcSubject === null || item.oidcGithubRunId !== item.actionRunId ||
      item.deploymentEvidenceId === null || item.deploymentEvidenceStatus !== 'passed' ||
      item.environmentUrl === null || item.noDuplicate.deploymentEvidence !== 1 ||
      item.currentRunVersion !== item.runVersion + 1
    ) context.addIssue({ code: 'custom', message: 'successful production deployment is inconsistent' });
  } else if (
    item.runState !== 'failed' || item.deploymentStatus !== 'failed' ||
    item.actionStatus !== 'completed' || item.actionConclusion === null ||
    item.deploymentEvidenceId === null || item.deploymentEvidenceStatus !== 'failed' ||
    item.noDuplicate.deploymentEvidence !== 1 || item.currentRunVersion !== item.runVersion + 1
  ) context.addIssue({ code: 'custom', message: 'failed production deployment is inconsistent' });
});

export const ProductionDeploymentEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: TIMESTAMP_SCHEMA,
  cases: z.array(DeploymentCaseSchema).min(4).max(20),
}).strict().superRefine((manifest, context) => {
  const caseIds = manifest.cases.map((item) => item.caseId);
  const runIds = manifest.cases.map((item) => item.runId);
  const deploymentIds = manifest.cases.map((item) => item.deploymentId);
  const githubDeploymentIds = manifest.cases.map((item) => item.githubDeploymentId);
  const actionRunIds = manifest.cases.map((item) => item.actionRunId);
  const states = new Set(manifest.cases.map((item) => item.externalState));
  const requiredStates: Array<'in_progress' | 'success' | 'failure' | 'error'> = [
    'in_progress', 'success', 'failure', 'error',
  ];
  if (
    new Set(caseIds).size !== caseIds.length || new Set(runIds).size !== runIds.length ||
    new Set(deploymentIds).size !== deploymentIds.length ||
    new Set(githubDeploymentIds).size !== githubDeploymentIds.length ||
    new Set(actionRunIds).size !== actionRunIds.length ||
    manifest.cases.some((item) => item.repository !== manifest.repository) ||
    !requiredStates.every((state) => states.has(state))
  ) context.addIssue({ code: 'custom', message: 'production deployment evidence cases are incomplete' });
});

export type ProductionDeploymentEvidenceManifestV1 = z.infer<
  typeof ProductionDeploymentEvidenceManifestV1Schema
>;
