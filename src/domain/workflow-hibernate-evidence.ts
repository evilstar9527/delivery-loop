import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

const SafeUrlSchema = z.string().url().max(2_048).superRefine((raw, context) => {
  let url: URL;
  try { url = new URL(raw); } catch {
    context.addIssue({ code: 'custom', message: 'invalid URL' });
    return;
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) context.addIssue({ code: 'custom', message: 'unsafe URL' });
});

const DeploymentSchema = z.object({
  deploymentId: z.string().regex(UUID_PATTERN),
  versionId: z.string().regex(UUID_PATTERN),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();

function isCloudflareDashboardUrl(raw: string): boolean {
  try { return new URL(raw).hostname === 'dash.cloudflare.com'; }
  catch { return false; }
}

export const WorkflowHibernateEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: z.iso.datetime({ offset: true }),
  case8ReportDigest: z.string().regex(DIGEST_PATTERN),
  safety: z.object({
    canaryDigest: z.string().regex(DIGEST_PATTERN),
  }).strict(),
  run: z.object({
    runId: z.string().regex(ID_PATTERN),
    state: z.literal('awaiting_approval'),
    version: z.number().int().positive(),
    taskRevision: z.string().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
    baseSha: z.string().regex(SHA_PATTERN),
    planId: z.string().regex(ID_PATTERN),
    planVersion: z.number().int().positive(),
    planDigest: z.string().regex(DIGEST_PATTERN),
  }).strict(),
  analysis: z.object({
    attemptId: z.string().regex(ID_PATTERN),
    attemptStatus: z.literal('completed'),
    dispatchOutboxId: z.string().regex(ID_PATTERN),
    actionRunId: z.string().regex(GITHUB_ID_PATTERN),
    actionUrl: SafeUrlSchema,
    workflowPath: z.literal('.github/workflows/delivery-agent.yml'),
    workflowHeadSha: z.string().regex(SHA_PATTERN),
    headBranch: z.string().regex(BRANCH_PATTERN)
      .refine((value) => !value.includes('..') && !value.includes('//')),
    actionConclusion: z.literal('success'),
  }).strict(),
  cloudflare: z.object({
    accountIdDigest: z.string().regex(DIGEST_PATTERN),
    workerScriptName: z.literal('delivery-loop-control-plane'),
    workflowName: z.literal('delivery-run'),
    instanceVersionId: z.string().regex(UUID_PATTERN),
    instanceStatus: z.literal('waiting'),
    instanceStartedAt: z.iso.datetime({ offset: true }),
    beforeDeployment: DeploymentSchema,
    afterDeployment: DeploymentSchema,
    hibernateWait: z.object({
      name: z.literal('await-analysis-result'),
      startedAt: z.iso.datetime({ offset: true }),
      endedAt: z.iso.datetime({ offset: true }),
    }).strict(),
    platformStepsDigest: z.string().regex(DIGEST_PATTERN),
    auditUrls: z.object({
      workflowInstance: SafeUrlSchema,
      beforeDeployment: SafeUrlSchema,
      afterDeployment: SafeUrlSchema,
    }).strict(),
  }).strict(),
  noDuplicate: z.object({
    analysisAttempts: z.literal(1),
    analysisDispatchOutboxes: z.literal(1),
    githubActionRuns: z.literal(1),
    workflowInstances: z.literal(1),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const instanceStartedAt = Date.parse(manifest.cloudflare.instanceStartedAt);
  const beforeCreatedAt = Date.parse(manifest.cloudflare.beforeDeployment.createdAt);
  const afterCreatedAt = Date.parse(manifest.cloudflare.afterDeployment.createdAt);
  const waitStartedAt = Date.parse(manifest.cloudflare.hibernateWait.startedAt);
  const waitEndedAt = Date.parse(manifest.cloudflare.hibernateWait.endedAt);
  const recordedAt = Date.parse(manifest.recordedAt);
  const auditUrls = Object.values(manifest.cloudflare.auditUrls);
  const auditHostsAreCloudflare = auditUrls.every(isCloudflareDashboardUrl);
  if (
    manifest.analysis.workflowHeadSha !== manifest.run.baseSha ||
    manifest.analysis.actionUrl !==
      `https://github.com/${manifest.repository}/actions/runs/${manifest.analysis.actionRunId}` ||
    manifest.cloudflare.beforeDeployment.deploymentId ===
      manifest.cloudflare.afterDeployment.deploymentId ||
    manifest.cloudflare.beforeDeployment.versionId === manifest.cloudflare.afterDeployment.versionId ||
    beforeCreatedAt > instanceStartedAt || instanceStartedAt >= waitStartedAt ||
    waitStartedAt >= afterCreatedAt || afterCreatedAt >= waitEndedAt || waitEndedAt > recordedAt ||
    new Set(auditUrls).size !== auditUrls.length || !auditHostsAreCloudflare
  ) context.addIssue({ code: 'custom', message: 'Workflow hibernate evidence is inconsistent' });
});

export type WorkflowHibernateEvidenceManifestV1 = z.infer<
  typeof WorkflowHibernateEvidenceManifestV1Schema
>;
