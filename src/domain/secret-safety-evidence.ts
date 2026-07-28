import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const WORKFLOW_PATH = '.github/workflows/delivery-agent.yml';
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

const ActionSchema = z.object({
  runId: z.string().regex(GITHUB_ID_PATTERN),
  workflowPath: z.literal(WORKFLOW_PATH),
  status: z.enum(['requested', 'queued', 'waiting', 'in_progress', 'completed']),
  conclusion: z.enum([
    'success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out',
    'action_required', 'stale', 'startup_failure',
  ]).nullable(),
  headSha: z.string().regex(SHA_PATTERN),
  displayTitle: z.string().min(1).max(300),
  url: EvidenceUrlSchema,
}).strict();

const LogScanSchema = z.object({
  jobCount: z.number().int().positive().max(100),
  canaryDigest: z.string().regex(DIGEST_PATTERN),
  observedAt: TIMESTAMP_SCHEMA,
  result: z.literal('clean'),
}).strict();

const ArtifactSchema = z.object({
  objectId: z.string().regex(UUID_PATTERN),
  category: z.literal('raw_transcript'),
  ciphertextDigest: z.string().regex(DIGEST_PATTERN),
  sizeBytes: z.number().int().nonnegative().max(1_048_576),
  policyVersion: z.literal('security-v1-raw-30d'),
  deletionState: z.enum(['active', 'deleting', 'retry', 'deleted']),
  createdAt: TIMESTAMP_SCHEMA,
  expiresAt: TIMESTAMP_SCHEMA,
  auditUrl: EvidenceUrlSchema,
}).strict().superRefine((artifact, context) => {
  if (Date.parse(artifact.expiresAt) <= Date.parse(artifact.createdAt)) {
    context.addIssue({ code: 'custom', message: 'raw artifact retention window is invalid' });
  }
});

const PublicationSchema = z.object({
  publicationId: z.string().regex(ID_PATTERN),
  status: z.enum(['pending', 'verified']),
  approvalId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  baseBranch: z.string().regex(BRANCH_PATTERN),
  headBranch: z.string().regex(BRANCH_PATTERN),
  headSha: z.string().regex(SHA_PATTERN),
  bodyDigest: z.string().regex(DIGEST_PATTERN),
  number: z.number().int().positive().nullable(),
  url: EvidenceUrlSchema.nullable(),
  evidenceId: z.string().regex(ID_PATTERN).nullable(),
}).strict();

const CommonCaseSchema = z.object({
  caseId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  runState: z.enum(['verifying', 'pull_request_open']),
  repository: z.string().regex(REPOSITORY_PATTERN),
  taskRevision: z.string().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
  planId: z.string().regex(ID_PATTERN),
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(DIGEST_PATTERN),
  case8ReportDigest: z.string().regex(DIGEST_PATTERN),
  attemptId: z.string().regex(ID_PATTERN),
  attemptMode: z.enum(['analysis', 'implement', 'review_fix']),
  headSha: z.string().regex(SHA_PATTERN),
  action: ActionSchema,
  logScan: LogScanSchema,
  artifact: ArtifactSchema.nullable(),
  publication: PublicationSchema,
  outbox: z.object({
    id: z.string().regex(ID_PATTERN),
    state: z.literal('settled'),
    lastErrorCode: z.enum(['pull_request_secret_detected']).nullable(),
  }).strict(),
}).strict().superRefine((item, context) => {
  if (
    item.repository !== item.publication.repository ||
    item.publication.headSha !== item.headSha ||
    item.action.headSha !== item.headSha ||
    item.action.displayTitle !== `delivery-loop/${item.attemptId}` ||
    item.action.url !== `https://github.com/${item.repository}/actions/runs/${item.action.runId}` ||
    item.publication.status === 'verified' && item.runState !== 'pull_request_open' ||
    item.publication.status === 'pending' && item.runState !== 'verifying'
  ) context.addIssue({ code: 'custom', message: 'secret safety case binding is inconsistent' });
});

const SafeDraftCaseSchema = CommonCaseSchema.extend({
  outcome: z.literal('safe_draft_pr'),
}).strict().superRefine((item, context) => {
  if (
    item.action.status !== 'completed' || item.action.conclusion !== 'success' ||
    item.publication.status !== 'verified' || item.publication.number === null ||
    item.publication.url === null || item.publication.evidenceId === null ||
    item.outbox.lastErrorCode !== null || item.artifact === null
  ) context.addIssue({ code: 'custom', message: 'safe Draft PR case is inconsistent' });
});

const BlockedPublicationCaseSchema = CommonCaseSchema.extend({
  outcome: z.literal('blocked_secret_publication'),
}).strict().superRefine((item, context) => {
  if (
    item.action.status !== 'completed' || item.action.conclusion === 'success' ||
    item.publication.status !== 'pending' || item.publication.number !== null ||
    item.publication.url !== null || item.publication.evidenceId !== null ||
    item.outbox.lastErrorCode !== 'pull_request_secret_detected'
  ) context.addIssue({ code: 'custom', message: 'blocked Secret publication case is inconsistent' });
});

export const SecretSafetyEvidenceCaseSchema = z.discriminatedUnion('outcome', [
  SafeDraftCaseSchema,
  BlockedPublicationCaseSchema,
]);

export const SecretSafetyEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: TIMESTAMP_SCHEMA,
  cases: z.array(SecretSafetyEvidenceCaseSchema).min(2).max(20),
}).strict().superRefine((manifest, context) => {
  const caseIds = manifest.cases.map((item) => item.caseId);
  const runIds = manifest.cases.map((item) => item.runId);
  const actionIds = manifest.cases.map((item) => item.action.runId);
  const publicationIds = manifest.cases.map((item) => item.publication.publicationId);
  if (
    new Set(caseIds).size !== caseIds.length || new Set(runIds).size !== runIds.length ||
    new Set(actionIds).size !== actionIds.length || new Set(publicationIds).size !== publicationIds.length ||
    manifest.cases.some((item) => item.repository !== manifest.repository) ||
    !manifest.cases.some((item) => item.outcome === 'safe_draft_pr') ||
    !manifest.cases.some((item) => item.outcome === 'blocked_secret_publication')
  ) context.addIssue({ code: 'custom', message: 'secret safety evidence cases are incomplete' });
});

export type SecretSafetyEvidenceManifestV1 = z.infer<
  typeof SecretSafetyEvidenceManifestV1Schema
>;
