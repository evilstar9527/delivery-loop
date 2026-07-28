import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WORKFLOW_PATH = '.github/workflows/delivery-test-acceptance.yml';
const OIDC_AUDIENCE = 'delivery-loop-test-acceptance';

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
  state: z.enum(['received', 'applied', 'ignored']),
  observedAt: z.iso.datetime({ offset: true }),
}).strict();

const RunnerResultSchema = z.object({
  digest: z.string().regex(DIGEST_PATTERN).nullable(),
  status: z.enum(['passed', 'failed']).nullable(),
  exitCode: z.number().int().min(0).max(255).nullable(),
  durationMs: z.number().int().min(0).max(3_600_000).nullable(),
}).strict().superRefine((result, context) => {
  const allNull = result.digest === null && result.status === null &&
    result.exitCode === null && result.durationMs === null;
  const allPresent = result.digest !== null && result.status !== null &&
    result.exitCode !== null && result.durationMs !== null;
  if (!allNull && !allPresent) {
    context.addIssue({ code: 'custom', message: 'runner result fields must be all null or all present' });
  }
});

const AcceptanceCaseSchema = z.object({
  caseId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  runVersion: z.number().int().nonnegative(),
  currentRunVersion: z.number().int().nonnegative(),
  runState: z.enum(['executing', 'blocked']),
  repository: z.string().regex(REPOSITORY_PATTERN),
  planId: z.string().regex(ID_PATTERN),
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(DIGEST_PATTERN),
  planItemId: z.string().regex(ID_PATTERN),
  attemptId: z.string().regex(ID_PATTERN),
  deploymentId: z.string().regex(ID_PATTERN),
  deploymentEvidenceId: z.string().regex(ID_PATTERN),
  acceptanceId: z.string().regex(ID_PATTERN),
  approvalId: z.string().regex(ID_PATTERN),
  refSha: z.string().regex(SHA_PATTERN),
  environment: z.literal('test'),
  workflowPath: z.literal(WORKFLOW_PATH),
  oidcAudience: z.literal(OIDC_AUDIENCE),
  oidcSubject: z.string().regex(/^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+:environment:test$/),
  commandRef: z.string().regex(/^acceptance:[a-z][a-z0-9_-]{0,63}$/),
  oidcAttestationId: z.string().regex(ID_PATTERN),
  oidcGithubRunId: z.string().regex(GITHUB_ID_PATTERN),
  actionRunId: z.string().regex(GITHUB_ID_PATTERN),
  actionUrl: EvidenceUrlSchema,
  actionStatus: z.enum(['requested', 'queued', 'waiting', 'in_progress', 'completed']),
  actionConclusion: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
  environmentUrl: EvidenceUrlSchema,
  acceptanceStatus: z.enum(['dispatched', 'running', 'passed', 'failed']),
  outcome: z.enum(['running', 'passed', 'failed']),
  runner: RunnerResultSchema,
  acceptanceEvidenceId: z.string().regex(ID_PATTERN).nullable(),
  acceptanceEvidenceStatus: z.enum(['passed', 'failed']).nullable(),
  webhook: ObservationSchema,
  apiObservation: ObservationSchema,
  noDuplicate: z.object({
    attempts: z.literal(1),
    acceptances: z.literal(1),
    dispatchOutboxes: z.literal(1),
    evidence: z.union([z.literal(0), z.literal(1)]),
  }).strict(),
}).strict().superRefine((item, context) => {
  const subjectRepository = item.oidcSubject.slice('repo:'.length).split(':environment:')[0];
  if (
    subjectRepository !== item.repository || item.currentRunVersion < item.runVersion ||
    item.actionUrl !== `https://github.com/${item.repository}/actions/runs/${item.actionRunId}`
  ) {
    context.addIssue({ code: 'custom', message: 'acceptance identity or Action URL binding is invalid' });
  }
  if (item.deploymentId === item.acceptanceId || item.attemptId === item.acceptanceId) {
    context.addIssue({ code: 'custom', message: 'acceptance identity must be distinct from deployment/attempt' });
  }
  if (item.outcome === 'running') {
    if (
      item.runState !== 'executing' || item.acceptanceStatus === 'passed' ||
      item.acceptanceStatus === 'failed' || item.actionStatus === 'completed' ||
      item.actionConclusion !== null || item.acceptanceEvidenceId !== null ||
      item.acceptanceEvidenceStatus !== null
    ) context.addIssue({ code: 'custom', message: 'running acceptance cannot have a terminal fact' });
  } else if (item.outcome === 'passed') {
    if (
      item.runState !== 'executing' || item.acceptanceStatus !== 'passed' ||
      item.actionStatus !== 'completed' || item.actionConclusion !== 'success' ||
      item.runner.status !== 'passed' || item.runner.exitCode !== 0 ||
      item.acceptanceEvidenceId === null || item.acceptanceEvidenceStatus !== 'passed' ||
      item.noDuplicate.evidence !== 1
    ) context.addIssue({ code: 'custom', message: 'passed acceptance is inconsistent' });
  } else if (
    !['executing', 'blocked'].includes(item.runState) || item.acceptanceStatus !== 'failed' ||
    item.actionStatus !== 'completed' ||
    (item.actionConclusion === 'success' && item.runner.status !== 'failed') ||
    item.acceptanceEvidenceId === null || item.acceptanceEvidenceStatus !== 'failed' ||
    item.noDuplicate.evidence !== 1
  ) context.addIssue({ code: 'custom', message: 'failed acceptance is inconsistent' });
  if (item.webhook.state !== 'applied' || item.apiObservation.state !== 'applied') {
    context.addIssue({ code: 'custom', message: 'acceptance observations must be applied' });
  }
});

export const TestAcceptanceEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: z.iso.datetime({ offset: true }),
  cases: z.array(AcceptanceCaseSchema).min(3).max(20),
}).strict().superRefine((manifest, context) => {
  const caseIds = manifest.cases.map((item) => item.caseId);
  const runIds = manifest.cases.map((item) => item.runId);
  const acceptanceIds = manifest.cases.map((item) => item.acceptanceId);
  const actionRunIds = manifest.cases.map((item) => item.actionRunId);
  if (
    new Set(caseIds).size !== caseIds.length || new Set(runIds).size !== runIds.length ||
    new Set(acceptanceIds).size !== acceptanceIds.length ||
    new Set(actionRunIds).size !== actionRunIds.length ||
    manifest.cases.some((item) => item.repository !== manifest.repository) ||
    !manifest.cases.some((item) => item.outcome === 'running') ||
    !manifest.cases.some((item) => item.outcome === 'passed') ||
    !manifest.cases.some((item) => item.outcome === 'failed')
  ) context.addIssue({ code: 'custom', message: 'test acceptance evidence cases are incomplete' });
});

export type TestAcceptanceEvidenceManifestV1 = z.infer<
  typeof TestAcceptanceEvidenceManifestV1Schema
>;
