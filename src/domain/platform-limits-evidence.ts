import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const ORGANIZATION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true });

export const GITHUB_ACTIONS_LIMITS_AUTHORITY = {
  owner: 'github',
  repository: 'docs',
  path: 'content/actions/reference/limits.md',
  commit: '071ed75ada2d9e80348639adfc7cca5b3902ed16',
  blobSha: 'f492e2ebd2859b4f91546cb2f270c83c7cae669a',
} as const;

export const CLOUDFLARE_WORKFLOWS_LIMITS_AUTHORITY = {
  owner: 'cloudflare',
  repository: 'cloudflare-docs',
  path: 'src/content/docs/workflows/reference/limits.mdx',
  commit: '862ae7b51ce028a30f1760e46e5d25ae76cc6832',
  blobSha: '926ed4527289522656999bbaa46efd8c4b98e247',
} as const;

export const CLOUDFLARE_PAID_WORKFLOW_LIMITS = {
  workerScriptSizeMb: 10,
  defaultStepCpuMs: 30_000,
  maximumStepCpuMs: 300_000,
  stepWallClockUnlimited: true,
  nonStreamStepResultBytes: 1_048_576,
  eventPayloadBytes: 1_048_576,
  persistedStateBytes: 1_073_741_824,
  maximumSleepDays: 365,
  defaultSteps: 10_000,
  maximumSteps: 25_000,
  concurrentInstances: 50_000,
  accountCreatePerSecond: 300,
  workflowCreatePerSecond: 100,
  queuedInstances: 2_000_000,
  completedStateRetentionDays: 30,
  defaultSubrequests: 10_000,
  maximumSubrequests: 10_000_000,
} as const;

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

function authoritySchema(authority: typeof GITHUB_ACTIONS_LIMITS_AUTHORITY | typeof CLOUDFLARE_WORKFLOWS_LIMITS_AUTHORITY) {
  return z.object({
    owner: z.literal(authority.owner),
    repository: z.literal(authority.repository),
    path: z.literal(authority.path),
    commit: z.literal(authority.commit),
    blobSha: z.literal(authority.blobSha),
    contentDigest: z.string().regex(DIGEST_PATTERN),
  }).strict();
}

const PaidLimitsSchema = z.object({
  workerScriptSizeMb: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.workerScriptSizeMb),
  defaultStepCpuMs: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.defaultStepCpuMs),
  maximumStepCpuMs: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.maximumStepCpuMs),
  stepWallClockUnlimited: z.literal(true),
  nonStreamStepResultBytes: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.nonStreamStepResultBytes),
  eventPayloadBytes: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.eventPayloadBytes),
  persistedStateBytes: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.persistedStateBytes),
  maximumSleepDays: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.maximumSleepDays),
  defaultSteps: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.defaultSteps),
  maximumSteps: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.maximumSteps),
  concurrentInstances: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.concurrentInstances),
  accountCreatePerSecond: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.accountCreatePerSecond),
  workflowCreatePerSecond: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.workflowCreatePerSecond),
  queuedInstances: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.queuedInstances),
  completedStateRetentionDays: z.literal(
    CLOUDFLARE_PAID_WORKFLOW_LIMITS.completedStateRetentionDays,
  ),
  defaultSubrequests: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.defaultSubrequests),
  maximumSubrequests: z.literal(CLOUDFLARE_PAID_WORKFLOW_LIMITS.maximumSubrequests),
}).strict();

const WorkflowSourceSchema = z.object({
  workflowPath: z.enum([
    '.github/workflows/platform-concurrency-probe.yml',
    '.github/workflows/platform-duration-probe.yml',
  ]),
  workflowHeadSha: z.string().regex(SHA_PATTERN),
  workflowBlobSha: z.string().regex(SHA_PATTERN),
  workflowContentDigest: z.string().regex(DIGEST_PATTERN),
}).strict();

export const PlatformLimitsEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: TIMESTAMP_SCHEMA,
  officialDocumentation: z.object({
    githubActions: authoritySchema(GITHUB_ACTIONS_LIMITS_AUTHORITY),
    cloudflareWorkflows: authoritySchema(CLOUDFLARE_WORKFLOWS_LIMITS_AUTHORITY),
  }).strict(),
  github: z.object({
    organization: z.string().regex(ORGANIZATION_PATTERN),
    repository: z.string().regex(REPOSITORY_PATTERN),
    organizationPolicy: z.object({
      digest: z.string().regex(DIGEST_PATTERN),
      enabledRepositories: z.enum(['all', 'none', 'selected']),
      allowedActions: z.enum(['all', 'local_only', 'selected']),
      defaultWorkflowPermissions: z.enum(['read', 'write']),
      canApprovePullRequestReviews: z.boolean(),
      artifactAndLogRetentionDays: z.number().int().min(1).max(400),
    }).strict(),
    billing: z.object({
      year: z.number().int().min(2024).max(2_100),
      month: z.number().int().min(1).max(12),
      actionsUsageDigest: z.string().regex(DIGEST_PATTERN),
      actionsUsageItemCount: z.number().int().min(1).max(10_000),
      unitTypes: z.array(z.string().min(1).max(100).regex(/^[A-Za-z0-9 _./-]+$/))
        .min(1).max(100),
      quantity: z.number().finite().nonnegative(),
      grossAmount: z.number().finite().nonnegative(),
      discountAmount: z.number().finite().nonnegative(),
      netAmount: z.number().finite().nonnegative(),
      reviewedAt: TIMESTAMP_SCHEMA,
      auditUrl: SafeUrlSchema,
    }).strict(),
    concurrencyProbe: WorkflowSourceSchema.extend({
      workflowPath: z.literal('.github/workflows/platform-concurrency-probe.yml'),
      runIds: z.array(z.string().regex(GITHUB_ID_PATTERN)).min(1).max(10),
      requestedJobCount: z.number().int().min(2).max(2_560),
      reviewedOrganizationLimit: z.number().int().min(1).max(1_000),
      observedMaximumConcurrency: z.number().int().min(1).max(1_000),
      startedAt: TIMESTAMP_SCHEMA,
      completedAt: TIMESTAMP_SCHEMA,
      auditUrls: z.array(SafeUrlSchema).min(1).max(10),
    }).strict(),
    durationProbe: WorkflowSourceSchema.extend({
      workflowPath: z.literal('.github/workflows/platform-duration-probe.yml'),
      runId: z.string().regex(GITHUB_ID_PATTERN),
      maximumJobDurationMinutes: z.literal(360),
      observedDurationMs: z.number().int().min(21_300_000).max(22_200_000),
      startedAt: TIMESTAMP_SCHEMA,
      completedAt: TIMESTAMP_SCHEMA,
      conclusion: z.literal('failure'),
      auditUrl: SafeUrlSchema,
    }).strict(),
  }).strict(),
  cloudflare: z.object({
    accountIdDigest: z.string().regex(DIGEST_PATTERN),
    paidPlanReviewedAt: TIMESTAMP_SCHEMA,
    paidPlanAuditUrl: SafeUrlSchema,
    paidLimits: PaidLimitsSchema,
  }).strict(),
  reusedEvidence: z.object({
    runnerHeartbeatEvidenceId: z.string().regex(ID_PATTERN),
    workflowHibernateEvidenceId: z.string().regex(ID_PATTERN),
    controlledReplayEvidenceId: z.string().regex(ID_PATTERN),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const concurrency = manifest.github.concurrencyProbe;
  const duration = manifest.github.durationProbe;
  const recordedAt = Date.parse(manifest.recordedAt);
  const concurrencyStart = Date.parse(concurrency.startedAt);
  const concurrencyEnd = Date.parse(concurrency.completedAt);
  const durationStart = Date.parse(duration.startedAt);
  const durationEnd = Date.parse(duration.completedAt);
  const billingReviewedAt = Date.parse(manifest.github.billing.reviewedAt);
  const planReviewedAt = Date.parse(manifest.cloudflare.paidPlanReviewedAt);
  if (
    manifest.github.repository.split('/')[0] !== manifest.github.organization ||
    concurrency.workflowHeadSha !== duration.workflowHeadSha ||
    new Set(concurrency.runIds).size !== concurrency.runIds.length ||
    concurrency.auditUrls.length !== concurrency.runIds.length ||
    concurrency.requestedJobCount <= concurrency.reviewedOrganizationLimit ||
    concurrency.observedMaximumConcurrency !== concurrency.reviewedOrganizationLimit ||
    concurrencyEnd <= concurrencyStart || durationEnd <= durationStart ||
    durationEnd - durationStart !== duration.observedDurationMs ||
    Math.max(concurrencyEnd, durationEnd, billingReviewedAt, planReviewedAt) > recordedAt
  ) context.addIssue({ code: 'custom', message: 'platform limits evidence is inconsistent' });

  const githubAuditUrls = [...concurrency.auditUrls, duration.auditUrl];
  for (const raw of githubAuditUrls) {
    try {
      const url = new URL(raw);
      if (
        url.hostname !== 'github.com' ||
        !url.pathname.startsWith(`/${manifest.github.repository}/actions/runs/`)
      ) context.addIssue({ code: 'custom', message: 'GitHub audit URL is not bound to repository' });
    } catch { /* SafeUrlSchema reports the shape error. */ }
  }
  try {
    const billingUrl = new URL(manifest.github.billing.auditUrl);
    if (
      billingUrl.hostname !== 'github.com' ||
      !billingUrl.pathname.startsWith(`/organizations/${manifest.github.organization}/settings/billing`)
    ) context.addIssue({ code: 'custom', message: 'billing audit URL is not bound to organization' });
  } catch { /* SafeUrlSchema reports the shape error. */ }
  try {
    if (new URL(manifest.cloudflare.paidPlanAuditUrl).hostname !== 'dash.cloudflare.com') {
      context.addIssue({ code: 'custom', message: 'Cloudflare audit URL is not authoritative' });
    }
  } catch { /* SafeUrlSchema reports the shape error. */ }
});

export type PlatformLimitsEvidenceManifestV1 = z.infer<
  typeof PlatformLimitsEvidenceManifestV1Schema
>;
