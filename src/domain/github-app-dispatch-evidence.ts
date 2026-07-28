import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WORKFLOW_PATH = '.github/workflows/delivery-agent.yml';

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

const AppPermissionsSchema = z.object({
  actions: z.literal('write'),
  contents: z.enum(['read', 'write']),
  metadata: z.literal('read'),
  checks: z.literal('read').optional(),
  deployments: z.enum(['read', 'write']).optional(),
  pull_requests: z.enum(['read', 'write']).optional(),
  statuses: z.literal('read').optional(),
}).strict();

const AppEventSchema = z.enum([
  'deployment_status',
  'installation',
  'installation_repositories',
  'pull_request',
  'pull_request_review',
  'workflow_run',
]);

const AppEventsSchema = z.array(AppEventSchema).min(1).max(10).superRefine((events, context) => {
  if (
    !events.includes('workflow_run') || new Set(events).size !== events.length ||
    [...events].sort().some((event, index) => event !== events[index])
  ) context.addIssue({ code: 'custom', message: 'GitHub App events are inconsistent' });
});

const PrincipalTypeSchema = z.enum(['Organization', 'User']);

export const GitHubAppDispatchEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: z.iso.datetime({ offset: true }),
  app: z.object({
    appId: z.string().regex(GITHUB_ID_PATTERN),
    slug: z.string().regex(SLUG_PATTERN),
    ownerLogin: z.string().regex(LOGIN_PATTERN),
    ownerType: PrincipalTypeSchema,
    permissions: AppPermissionsSchema,
    events: AppEventsSchema,
    appUrl: SafeUrlSchema,
  }).strict(),
  installation: z.object({
    installationId: z.string().regex(GITHUB_ID_PATTERN),
    targetId: z.string().regex(GITHUB_ID_PATTERN),
    targetLogin: z.string().regex(LOGIN_PATTERN),
    targetType: PrincipalTypeSchema,
    repositorySelection: z.literal('selected'),
    suspended: z.literal(false),
    selectedRepositoryCount: z.literal(1),
    selectedRepositoriesDigest: z.string().regex(DIGEST_PATTERN),
    settingsUrl: SafeUrlSchema,
  }).strict(),
  repository: z.object({
    repositoryId: z.string().regex(GITHUB_ID_PATTERN),
    fullName: z.string().regex(REPOSITORY_PATTERN),
    visibility: z.enum(['public', 'private', 'internal']),
    defaultBranch: z.string().min(1).max(255).refine(
      (value) => !value.includes('..') && !value.includes('//') && !/[\0\r\n]/.test(value),
    ),
    archived: z.boolean(),
    disabled: z.boolean(),
  }).strict(),
  dispatch: z.object({
    runId: z.string().regex(ID_PATTERN),
    runState: z.literal('awaiting_approval'),
    runVersion: z.number().int().positive(),
    taskRevision: z.string().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
    taskDigest: z.string().regex(DIGEST_PATTERN),
    baseSha: z.string().regex(SHA_PATTERN),
    planId: z.string().regex(ID_PATTERN),
    planVersion: z.number().int().positive(),
    planDigest: z.string().regex(DIGEST_PATTERN),
    attemptId: z.string().regex(ID_PATTERN),
    attemptStatus: z.literal('completed'),
    dispatchOutboxId: z.string().regex(ID_PATTERN),
    workflowPath: z.literal(WORKFLOW_PATH),
    workflowRef: z.string().min(1).max(500),
    workflowBlobSha: z.string().regex(SHA_PATTERN),
    workflowContentDigest: z.string().regex(DIGEST_PATTERN),
    actionRunId: z.string().regex(GITHUB_ID_PATTERN),
    actionUrl: SafeUrlSchema,
    actionConclusion: z.literal('success'),
    actionUpdatedAt: z.iso.datetime({ offset: true }),
  }).strict(),
  noDuplicate: z.object({
    selectedRepositories: z.literal(1),
    analysisAttempts: z.literal(1),
    analysisDispatchOutboxes: z.literal(1),
    githubActionRuns: z.literal(1),
    githubJobs: z.literal(1),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  let appUrl: URL;
  let settingsUrl: URL;
  try {
    appUrl = new URL(manifest.app.appUrl);
    settingsUrl = new URL(manifest.installation.settingsUrl);
  } catch {
    context.addIssue({ code: 'custom', message: 'GitHub App evidence URLs are invalid' });
    return;
  }
  const expectedWorkflowRef =
    `${manifest.repository.fullName}/${WORKFLOW_PATH}@refs/heads/${manifest.repository.defaultBranch}`;
  const expectedActionUrl =
    `https://github.com/${manifest.repository.fullName}/actions/runs/${manifest.dispatch.actionRunId}`;
  if (
    appUrl.hostname !== 'github.com' || appUrl.pathname !== `/apps/${manifest.app.slug}` ||
    settingsUrl.hostname !== 'github.com' ||
    !settingsUrl.pathname.endsWith(`/settings/installations/${manifest.installation.installationId}`) ||
    manifest.repository.fullName.split('/')[0] !== manifest.installation.targetLogin ||
    manifest.dispatch.workflowRef !== expectedWorkflowRef ||
    manifest.dispatch.actionUrl !== expectedActionUrl ||
    Date.parse(manifest.dispatch.actionUpdatedAt) > Date.parse(manifest.recordedAt)
  ) context.addIssue({ code: 'custom', message: 'GitHub App dispatch evidence is inconsistent' });
});

export type GitHubAppDispatchEvidenceManifestV1 = z.infer<
  typeof GitHubAppDispatchEvidenceManifestV1Schema
>;
