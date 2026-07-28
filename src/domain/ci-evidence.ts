import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const URL_SCHEMA = z.string().url().max(2_048).superRefine((raw, context) => {
  let url: URL;
  try { url = new URL(raw); } catch { context.addIssue({ code: 'custom', message: 'invalid URL' }); return; }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    context.addIssue({ code: 'custom', message: 'unsafe URL' });
  }
});

const CaseSchema = z.object({
  caseId: z.string().regex(ID_PATTERN),
  kind: z.enum(['ci_main_success', 'ci_pull_request_success', 'validate_valid_success', 'validate_invalid_failure']),
  runId: z.string().regex(GITHUB_ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  workflowPath: z.enum(['.github/workflows/ci.yml', '.github/workflows/validate-task.yml']),
  event: z.enum(['push', 'pull_request', 'workflow_dispatch']),
  status: z.literal('completed'),
  conclusion: z.enum(['success', 'failure']),
  headSha: z.string().regex(SHA_PATTERN),
  headBranch: z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  displayTitleDigest: z.string().regex(DIGEST_PATTERN),
  url: URL_SCHEMA,
  workflowBlobSha: z.string().regex(SHA_PATTERN),
  workflowContentDigest: z.string().regex(DIGEST_PATTERN),
  permissions: z.object({ contents: z.literal('read') }).strict(),
  job: z.object({
    name: z.enum(['verify', 'validate']),
    status: z.literal('completed'),
    conclusion: z.enum(['success', 'failure']),
  }).strict(),
  logCanaryDigest: z.string().regex(DIGEST_PATTERN).nullable(),
}).strict().superRefine((item, context) => {
  const ci = item.kind === 'ci_main_success' || item.kind === 'ci_pull_request_success';
  const expectedWorkflow = ci ? '.github/workflows/ci.yml' : '.github/workflows/validate-task.yml';
  const expectedEvent = item.kind === 'ci_main_success' ? 'push' :
    item.kind === 'ci_pull_request_success' ? 'pull_request' : 'workflow_dispatch';
  const expectedConclusion = item.kind === 'validate_invalid_failure' ? 'failure' : 'success';
  if (
    item.workflowPath !== expectedWorkflow || item.event !== expectedEvent ||
    item.conclusion !== expectedConclusion || item.job.conclusion !== item.conclusion ||
    item.job.name !== (ci ? 'verify' : 'validate') ||
    item.url !== `https://github.com/${item.repository}/actions/runs/${item.runId}` ||
    (item.kind === 'ci_main_success' && item.headBranch !== 'main') ||
    ((item.kind === 'validate_invalid_failure') !== (item.logCanaryDigest !== null))
  ) context.addIssue({ code: 'custom', message: 'CI evidence case binding is inconsistent' });
});

export const CiEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: z.iso.datetime({ offset: true }),
  cases: z.array(CaseSchema).min(4).max(20),
}).strict().superRefine((manifest, context) => {
  const caseIds = manifest.cases.map((item) => item.caseId);
  const runIds = manifest.cases.map((item) => item.runId);
  const kinds = manifest.cases.map((item) => item.kind);
  if (
    new Set(caseIds).size !== caseIds.length || new Set(runIds).size !== runIds.length ||
    manifest.cases.some((item) => item.repository !== manifest.repository) ||
    new Set(kinds).size !== kinds.length ||
    !['ci_main_success', 'ci_pull_request_success', 'validate_valid_success', 'validate_invalid_failure']
      .every((kind) => kinds.includes(kind as typeof kinds[number]))
  ) context.addIssue({ code: 'custom', message: 'CI evidence cases are incomplete' });
});

export type CiEvidenceManifestV1 = z.infer<typeof CiEvidenceManifestV1Schema>;
