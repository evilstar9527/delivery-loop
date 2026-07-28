import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/([A-Za-z0-9_.-]{1,100})$/;
const BRANCH_PATTERN = /^(?!\/)(?!.*(?:\.\.|\/\/))[A-Za-z0-9._\u002f-]{1,255}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WORKFLOW_PATH = '.github/workflows/delivery-test-rollback.yml';
const OIDC_AUDIENCE = 'delivery-loop-test-rollback';
const TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true });

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

const SourceSchema = z.object({
  kind: z.enum(['deployment_failure', 'acceptance_failure']),
  id: z.string().regex(ID_PATTERN),
  evidenceId: z.string().regex(ID_PATTERN),
  failedAttemptId: z.string().regex(ID_PATTERN),
  deploymentId: z.string().regex(ID_PATTERN),
  deploymentEvidenceId: z.string().regex(ID_PATTERN),
  acceptanceId: z.string().regex(ID_PATTERN).optional(),
}).strict().superRefine((source, context) => {
  if (source.kind === 'deployment_failure') {
    if (
      source.id !== source.deploymentId || source.acceptanceId !== undefined ||
      source.evidenceId !== source.deploymentEvidenceId
    ) context.addIssue({ code: 'custom', message: 'deployment failure source is inconsistent' });
  } else if (
    source.acceptanceId === undefined || source.id !== source.acceptanceId ||
    source.evidenceId === source.deploymentEvidenceId
  ) context.addIssue({ code: 'custom', message: 'acceptance failure source is inconsistent' });
});

const ObservationSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  digest: z.string().regex(DIGEST_PATTERN),
  state: z.literal('applied'),
  observedAt: TIMESTAMP_SCHEMA,
}).strict();

const SuccessfulRollbackSchema = z.object({
  caseId: z.string().regex(ID_PATTERN),
  source: SourceSchema,
  runId: z.string().regex(ID_PATTERN),
  runVersion: z.number().int().nonnegative().safe(),
  currentRunVersion: z.number().int().nonnegative().safe(),
  runState: z.enum(['executing', 'blocked']),
  planId: z.string().regex(ID_PATTERN),
  planVersion: z.number().int().positive().safe(),
  planDigest: z.string().regex(DIGEST_PATTERN),
  planItemId: z.string().regex(ID_PATTERN),
  approvalId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  baseBranch: z.string().regex(BRANCH_PATTERN),
  baseSha: z.string().regex(SHA_PATTERN),
  refSha: z.string().regex(SHA_PATTERN),
  contractObservationId: z.string().regex(ID_PATTERN),
  policyDigest: z.string().regex(DIGEST_PATTERN),
  contractDigest: z.string().regex(DIGEST_PATTERN),
  workflowPath: z.literal(WORKFLOW_PATH),
  environment: z.literal('test'),
  oidcAudience: z.literal(OIDC_AUDIENCE),
  roleRef: z.string().regex(/^test:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/),
  rollbackId: z.string().regex(ID_PATTERN),
  rollbackAttemptId: z.string().regex(ID_PATTERN),
  rollbackStatus: z.literal('succeeded'),
  actionRunId: z.string().regex(GITHUB_ID_PATTERN),
  actionUrl: SafeUrlSchema,
  actionStatus: z.literal('completed'),
  actionConclusion: z.literal('success'),
  runner: z.object({
    digest: z.string().regex(DIGEST_PATTERN),
    status: z.literal('passed'),
    exitCode: z.literal(0),
    durationMs: z.number().int().nonnegative().max(3_600_000),
  }).strict(),
  rollbackEvidenceId: z.string().regex(ID_PATTERN),
  oidc: z.object({
    attestationId: z.string().regex(ID_PATTERN),
    githubRunId: z.string().regex(GITHUB_ID_PATTERN),
    workflowRef: z.string().min(1).max(512),
    subject: z.string().regex(/^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+:environment:test$/),
  }).strict(),
  observations: z.object({ webhook: ObservationSchema, api: ObservationSchema }).strict(),
  noDuplicate: z.object({
    contracts: z.literal(1),
    rollbacks: z.literal(1),
    attempts: z.literal(1),
    dispatchOutboxes: z.literal(1),
    evidence: z.literal(1),
  }).strict(),
  cloudReview: z.object({
    auditUrl: SafeUrlSchema,
    environmentResultUrl: SafeUrlSchema,
    result: z.literal('restored'),
    reviewer: z.string().regex(ID_PATTERN),
    reviewedAt: TIMESTAMP_SCHEMA,
    actionAndCloudBindingReviewed: z.literal(true),
  }).strict(),
}).strict().superRefine((item, context) => {
  const workflowRef = `${item.repository}/${WORKFLOW_PATH}@refs/heads/${item.baseBranch}`;
  const subject = `repo:${item.repository}:environment:test`;
  if (
    item.currentRunVersion < item.runVersion || item.source.failedAttemptId === item.rollbackAttemptId ||
    item.actionUrl !== `https://github.com/${item.repository}/actions/runs/${item.actionRunId}` ||
    item.oidc.githubRunId !== item.actionRunId || item.oidc.workflowRef !== workflowRef ||
    item.oidc.subject !== subject || item.source.evidenceId === item.rollbackEvidenceId
  ) context.addIssue({ code: 'custom', message: 'successful rollback binding is inconsistent' });
});

const ActionAbsenceSchema = z.object({
  from: TIMESTAMP_SCHEMA,
  to: TIMESTAMP_SCHEMA,
}).strict().superRefine((window, context) => {
  const duration = Date.parse(window.to) - Date.parse(window.from);
  if (duration < 60_000 || duration > 3_600_000) {
    context.addIssue({ code: 'custom', message: 'Action absence window is invalid' });
  }
});

const ZeroEffectSchema = z.object({
  contracts: z.union([z.literal(0), z.literal(1)]),
  rollbacks: z.literal(0),
  attempts: z.literal(0),
  dispatchOutboxes: z.literal(0),
  actions: z.literal(0),
  evidence: z.literal(0),
}).strict();

const ContractAbsentCaseSchema = z.object({
  caseKind: z.literal('contract_absent'),
  caseId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  currentRunVersion: z.number().int().nonnegative().safe(),
  runState: z.enum(['executing', 'blocked']),
  repository: z.string().regex(REPOSITORY_PATTERN),
  source: SourceSchema,
  refSha: z.string().regex(SHA_PATTERN),
  contractObservation: z.object({
    id: z.string().regex(ID_PATTERN),
    disposition: z.enum(['not_declared', 'policy_missing', 'policy_invalid']),
    policyDigest: z.string().regex(DIGEST_PATTERN).nullable(),
    observedAt: TIMESTAMP_SCHEMA,
  }).strict(),
  actionAbsence: ActionAbsenceSchema,
  noEffect: ZeroEffectSchema.extend({ contracts: z.literal(1) }).strict(),
}).strict().superRefine((item, context) => {
  const needsDigest = item.contractObservation.disposition === 'not_declared';
  if (
    needsDigest !== (item.contractObservation.policyDigest !== null) ||
    Date.parse(item.contractObservation.observedAt) < Date.parse(item.actionAbsence.from) ||
    Date.parse(item.contractObservation.observedAt) > Date.parse(item.actionAbsence.to)
  ) context.addIssue({ code: 'custom', message: 'negative contract observation is inconsistent' });
});

const ProductionFailureCaseSchema = z.object({
  caseKind: z.literal('production_failure'),
  caseId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  currentRunVersion: z.number().int().nonnegative().safe(),
  runState: z.literal('failed'),
  repository: z.string().regex(REPOSITORY_PATTERN),
  failedAttemptId: z.string().regex(ID_PATTERN),
  deploymentId: z.string().regex(ID_PATTERN),
  sourceEvidenceId: z.string().regex(ID_PATTERN),
  refSha: z.string().regex(SHA_PATTERN),
  actionAbsence: ActionAbsenceSchema,
  noEffect: ZeroEffectSchema.extend({ contracts: z.literal(0) }).strict(),
}).strict();

export const TestRollbackEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  baseBranch: z.string().regex(BRANCH_PATTERN),
  recordedAt: TIMESTAMP_SCHEMA,
  successfulRollbacks: z.tuple([SuccessfulRollbackSchema, SuccessfulRollbackSchema]),
  negativeCases: z.tuple([ContractAbsentCaseSchema, ProductionFailureCaseSchema]),
  productionDecision: z.object({
    automaticRollback: z.literal('not_approved'),
    decisionEvidenceUrl: SafeUrlSchema,
    reviewer: z.string().regex(ID_PATTERN),
    reviewedAt: TIMESTAMP_SCHEMA,
  }).strict(),
  safety: z.object({ canaryDigest: z.string().regex(DIGEST_PATTERN) }).strict(),
}).strict().superRefine((manifest, context) => {
  const allCases = [...manifest.successfulRollbacks, ...manifest.negativeCases];
  const caseIds = allCases.map((item) => item.caseId);
  const runIds = allCases.map((item) => item.runId);
  const actionRunIds = manifest.successfulRollbacks.map((item) => item.actionRunId);
  const rollbackIds = manifest.successfulRollbacks.map((item) => item.rollbackId);
  if (
    manifest.successfulRollbacks[0].source.kind !== 'deployment_failure' ||
    manifest.successfulRollbacks[1].source.kind !== 'acceptance_failure' ||
    allCases.some((item) => item.repository !== manifest.repository) ||
    manifest.successfulRollbacks.some((item) => item.baseBranch !== manifest.baseBranch) ||
    new Set(caseIds).size !== caseIds.length || new Set(runIds).size !== runIds.length ||
    new Set(actionRunIds).size !== actionRunIds.length ||
    new Set(rollbackIds).size !== rollbackIds.length ||
    Date.parse(manifest.productionDecision.reviewedAt) > Date.parse(manifest.recordedAt) ||
    manifest.successfulRollbacks.some((item) =>
      Date.parse(item.cloudReview.reviewedAt) > Date.parse(manifest.recordedAt)) ||
    manifest.negativeCases.some((item) => Date.parse(item.actionAbsence.to) > Date.parse(manifest.recordedAt))
  ) context.addIssue({ code: 'custom', message: 'test rollback evidence cases are incomplete' });
});

export type TestRollbackEvidenceManifestV1 = z.infer<
  typeof TestRollbackEvidenceManifestV1Schema
>;
