import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

const ResourceIdSchema = z.string().regex(ID_PATTERN);
const GitHubIdSchema = z.string().regex(GITHUB_ID_PATTERN);
const ShaSchema = z.string().regex(SHA_PATTERN);
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

const ProductionDeploymentEvidenceSchema = z.object({
  runId: ResourceIdSchema,
  refSha: ShaSchema,
  deploymentId: ResourceIdSchema,
  githubDeploymentId: GitHubIdSchema,
  actionRunId: GitHubIdSchema,
  approvalId: ResourceIdSchema,
  deploymentEvidenceId: ResourceIdSchema,
  environmentUrl: EvidenceUrlSchema,
}).strict();

export const PilotEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  pilotId: ResourceIdSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: z.iso.datetime({ offset: true }),
  test: z.object({
    runId: ResourceIdSchema,
    refSha: ShaSchema,
    deploymentId: ResourceIdSchema,
    githubDeploymentId: GitHubIdSchema,
    deploymentActionRunId: GitHubIdSchema,
    deploymentEvidenceId: ResourceIdSchema,
    acceptanceId: ResourceIdSchema,
    acceptanceActionRunId: GitHubIdSchema,
    acceptanceEvidenceId: ResourceIdSchema,
    environmentUrl: EvidenceUrlSchema,
    oidcAuditUrl: EvidenceUrlSchema,
    productionSecretIsolationEvidenceUrl: EvidenceUrlSchema,
  }).strict(),
  productionDemo: z.object({
    environment: z.literal('production'),
    isolationEvidenceUrl: EvidenceUrlSchema,
    reviewerEvidenceUrl: EvidenceUrlSchema,
    success: ProductionDeploymentEvidenceSchema,
    failure: ProductionDeploymentEvidenceSchema.extend({
      externalState: z.enum(['failure', 'error']),
    }).strict(),
    rollback: z.object({
      mode: z.enum(['manual', 'contract']),
      failedRefSha: ShaSchema,
      restoredRefSha: ShaSchema,
      actionRunId: GitHubIdSchema,
      auditUrl: EvidenceUrlSchema,
      environmentResultUrl: EvidenceUrlSchema,
    }).strict(),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const runIds = [
    manifest.test.runId,
    manifest.productionDemo.success.runId,
    manifest.productionDemo.failure.runId,
  ];
  if (new Set(runIds).size !== runIds.length) {
    context.addIssue({ code: 'custom', message: 'pilot Run IDs must be distinct' });
  }
  const deploymentIds = [
    manifest.test.deploymentId,
    manifest.productionDemo.success.deploymentId,
    manifest.productionDemo.failure.deploymentId,
  ];
  if (new Set(deploymentIds).size !== deploymentIds.length) {
    context.addIssue({ code: 'custom', message: 'pilot deployment IDs must be distinct' });
  }
  const githubDeploymentIds = [
    manifest.test.githubDeploymentId,
    manifest.productionDemo.success.githubDeploymentId,
    manifest.productionDemo.failure.githubDeploymentId,
  ];
  if (new Set(githubDeploymentIds).size !== githubDeploymentIds.length) {
    context.addIssue({ code: 'custom', message: 'GitHub deployment IDs must be distinct' });
  }
  const actionRunIds = [
    manifest.test.deploymentActionRunId,
    manifest.test.acceptanceActionRunId,
    manifest.productionDemo.success.actionRunId,
    manifest.productionDemo.failure.actionRunId,
    manifest.productionDemo.rollback.actionRunId,
  ];
  if (new Set(actionRunIds).size !== actionRunIds.length) {
    context.addIssue({ code: 'custom', message: 'GitHub Action run IDs must be distinct' });
  }
  if (manifest.productionDemo.rollback.failedRefSha !== manifest.productionDemo.failure.refSha) {
    context.addIssue({ code: 'custom', message: 'rollback failure SHA must match failure' });
  }
  if (manifest.productionDemo.rollback.restoredRefSha !== manifest.productionDemo.success.refSha) {
    context.addIssue({ code: 'custom', message: 'rollback restored SHA must match success' });
  }
});

export type PilotEvidenceManifestV1 = z.infer<typeof PilotEvidenceManifestV1Schema>;
