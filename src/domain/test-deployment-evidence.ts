import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WORKFLOW_PATH = '.github/workflows/delivery-test-deploy.yml';
const OIDC_AUDIENCE = 'delivery-loop-test-deploy';

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
  digest: z.string().regex(DIGEST_PATTERN),
  state: z.enum(['applied', 'ignored']),
  observedAt: z.iso.datetime({ offset: true }),
}).strict();

const DeploymentCaseSchema = z.object({
  caseId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  runVersion: z.number().int().nonnegative(),
  currentRunVersion: z.number().int().nonnegative(),
  repository: z.string().regex(REPOSITORY_PATTERN),
  planId: z.string().regex(ID_PATTERN),
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(DIGEST_PATTERN),
  planItemId: z.string().regex(ID_PATTERN),
  attemptId: z.string().regex(ID_PATTERN),
  approvalId: z.string().regex(ID_PATTERN),
  deploymentId: z.string().regex(ID_PATTERN),
  githubDeploymentId: z.string().regex(GITHUB_ID_PATTERN),
  refSha: z.string().regex(SHA_PATTERN),
  environment: z.literal('test'),
  workflowPath: z.literal(WORKFLOW_PATH),
  oidcAudience: z.literal(OIDC_AUDIENCE),
  oidcSubject: z.string().regex(/^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+:environment:test$/),
  roleRef: z.string().regex(/^test:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/),
  oidcAttestationId: z.string().regex(ID_PATTERN),
  oidcGithubRunId: z.string().regex(GITHUB_ID_PATTERN),
  actionRunId: z.string().regex(GITHUB_ID_PATTERN),
  actionConclusion: z.enum(['success', 'failure']),
  actionUrl: EvidenceUrlSchema,
  deploymentEvidenceId: z.string().regex(ID_PATTERN),
  outcome: z.enum(['succeeded', 'failed']),
  externalState: z.enum(['success', 'failure', 'error']),
  environmentUrl: EvidenceUrlSchema.nullable(),
  webhook: ObservationSchema,
  apiObservation: ObservationSchema,
  noDuplicate: z.object({
    attempts: z.literal(1),
    deployments: z.literal(1),
    deployOutboxes: z.literal(1),
    deploymentEvidence: z.literal(1),
  }).strict(),
  audit: z.object({
    oidcAuditUrl: EvidenceUrlSchema,
    productionSecretIsolationEvidenceUrl: EvidenceUrlSchema,
  }).strict(),
}).strict().superRefine((item, context) => {
  if (item.repository !== item.oidcSubject.slice('repo:'.length).split(':environment:')[0]) {
    context.addIssue({ code: 'custom', message: 'OIDC subject repository does not match deployment' });
  }
  if (
    item.currentRunVersion < item.runVersion ||
    item.actionUrl !== `https://github.com/${item.repository}/actions/runs/${item.actionRunId}`
  ) context.addIssue({ code: 'custom', message: 'test deployment run or Action URL binding is invalid' });
  if (item.outcome === 'succeeded') {
    if (
      item.externalState !== 'success' || item.environmentUrl === null ||
      item.actionConclusion !== 'success'
    ) {
      context.addIssue({ code: 'custom', message: 'successful test deployment needs success state and URL' });
    }
  } else if (item.externalState === 'success' || item.actionConclusion !== 'failure') {
    context.addIssue({ code: 'custom', message: 'failed test deployment cannot have success state' });
  }
  if (item.webhook.state !== 'applied' || item.apiObservation.state !== 'applied') {
    context.addIssue({ code: 'custom', message: 'deployment status observations must be applied' });
  }
});

export const TestDeploymentEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: z.iso.datetime({ offset: true }),
  cases: z.array(DeploymentCaseSchema).min(1).max(20),
}).strict().superRefine((manifest, context) => {
  const caseIds = manifest.cases.map((item) => item.caseId);
  const runIds = manifest.cases.map((item) => item.runId);
  const deploymentIds = manifest.cases.map((item) => item.deploymentId);
  const githubDeploymentIds = manifest.cases.map((item) => item.githubDeploymentId);
  const actionRunIds = manifest.cases.map((item) => item.actionRunId);
  if (
    new Set(caseIds).size !== caseIds.length ||
    new Set(runIds).size !== runIds.length ||
    new Set(deploymentIds).size !== deploymentIds.length ||
    new Set(githubDeploymentIds).size !== githubDeploymentIds.length ||
    new Set(actionRunIds).size !== actionRunIds.length ||
    manifest.cases.some((item) => item.repository !== manifest.repository) ||
    !manifest.cases.some((item) => item.outcome === 'succeeded')
  ) context.addIssue({ code: 'custom', message: 'test deployment evidence cases are incomplete' });
});

export type TestDeploymentEvidenceManifestV1 = z.infer<
  typeof TestDeploymentEvidenceManifestV1Schema
>;
