import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WORKER_TRACE_PATTERN = /^[a-f0-9]{32}$/;
const TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true });

export const CORRELATION_PLATFORM_LOOKUP_KINDS = [
  'task',
  'run',
  'attempt',
  'github_run',
  'github_pr',
  'test_deployment',
  'production_deployment',
  'github_deployment',
  'trace',
] as const;

const LookupKindSchema = z.enum(CORRELATION_PLATFORM_LOOKUP_KINDS);

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

const SortedUniqueStringsSchema = z.array(z.string().regex(ID_PATTERN)).max(50)
  .superRefine((values, context) => {
    const sorted = [...new Set(values)].sort();
    if (values.length !== sorted.length || values.some((value, index) => value !== sorted[index])) {
      context.addIssue({ code: 'custom', message: 'identifier list must be sorted and unique' });
    }
  });

const SortedUniqueNumbersSchema = z.array(z.number().int().positive().safe()).max(50)
  .superRefine((values, context) => {
    const sorted = [...new Set(values)].sort((left, right) => left - right);
    if (values.length !== sorted.length || values.some((value, index) => value !== sorted[index])) {
      context.addIssue({ code: 'custom', message: 'number list must be sorted and unique' });
    }
  });

export const CorrelationPlatformLogRecordV1Schema = z.object({
  schemaVersion: z.literal('1'),
  level: z.literal('info'),
  component: z.literal('correlation'),
  event: z.literal('correlation_lookup'),
  correlationId: z.string().regex(ID_PATTERN),
  taskId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  attemptIds: SortedUniqueStringsSchema,
  githubRunIds: SortedUniqueStringsSchema,
  pullRequestNumbers: SortedUniqueNumbersSchema,
  deploymentIds: SortedUniqueStringsSchema,
  githubDeploymentIds: SortedUniqueStringsSchema,
  traceIds: SortedUniqueStringsSchema,
  matchedByKind: LookupKindSchema,
  matchedById: z.string().min(1).max(256),
  matchedByRepository: z.string().regex(REPOSITORY_PATTERN).optional(),
  observedAt: TIMESTAMP_SCHEMA,
}).strict().superRefine((record, context) => {
  const scoped = record.matchedByKind === 'github_pr' ||
    record.matchedByKind === 'github_deployment';
  if (scoped !== (record.matchedByRepository !== undefined)) {
    context.addIssue({ code: 'custom', message: 'log lookup scope is inconsistent' });
  }
  const pattern = record.matchedByKind.startsWith('github_')
    ? GITHUB_ID_PATTERN
    : ID_PATTERN;
  if (!pattern.test(record.matchedById)) {
    context.addIssue({ code: 'custom', message: 'log lookup identifier is invalid' });
  }
});

const lookupSchema = <Kind extends typeof CORRELATION_PLATFORM_LOOKUP_KINDS[number]>(
  kind: Kind,
  scoped = false,
) => z.object({
  kind: z.literal(kind),
  id: z.string().regex(kind.startsWith('github_') ? GITHUB_ID_PATTERN : ID_PATTERN),
  ...(scoped ? { repository: z.string().regex(REPOSITORY_PATTERN) } : {}),
  observedAt: TIMESTAMP_SCHEMA,
  logRecordDigest: z.string().regex(DIGEST_PATTERN),
  workerTraceId: z.string().regex(WORKER_TRACE_PATTERN),
}).strict();

const LookupsSchema = z.tuple([
  lookupSchema('task'),
  lookupSchema('run'),
  lookupSchema('attempt'),
  lookupSchema('github_run'),
  lookupSchema('github_pr', true),
  lookupSchema('test_deployment'),
  lookupSchema('production_deployment'),
  lookupSchema('github_deployment', true),
  lookupSchema('github_deployment', true),
  lookupSchema('trace'),
]);

export const CorrelationPlatformEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: TIMESTAMP_SCHEMA,
  repository: z.string().regex(REPOSITORY_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  lineage: z.object({
    taskId: z.string().regex(ID_PATTERN),
    attemptId: z.string().regex(ID_PATTERN),
    githubRun: z.object({
      id: z.string().regex(GITHUB_ID_PATTERN),
      headSha: z.string().regex(SHA_PATTERN),
    }).strict(),
    pullRequest: z.object({
      number: z.number().int().positive().safe(),
      headSha: z.string().regex(SHA_PATTERN),
      state: z.enum(['open', 'closed']),
      draft: z.boolean(),
    }).strict(),
    testDeployment: z.object({
      deploymentId: z.string().regex(ID_PATTERN),
      githubDeploymentId: z.string().regex(GITHUB_ID_PATTERN),
      sha: z.string().regex(SHA_PATTERN),
      environment: z.literal('test'),
    }).strict(),
    productionDeployment: z.object({
      deploymentId: z.string().regex(ID_PATTERN),
      githubDeploymentId: z.string().regex(GITHUB_ID_PATTERN),
      sha: z.string().regex(SHA_PATTERN),
      environment: z.literal('production'),
    }).strict(),
    toolTraceId: z.string().regex(ID_PATTERN),
  }).strict(),
  cloudflare: z.object({
    accountIdDigest: z.string().regex(DIGEST_PATTERN),
    scriptName: z.string().min(1).max(255).regex(/^[a-z0-9][a-z0-9-]*$/),
    environment: z.literal('production'),
    window: z.object({ from: TIMESTAMP_SCHEMA, to: TIMESTAMP_SCHEMA }).strict(),
    retentionDays: z.literal(7),
    logHeadSamplingRate: z.literal(1),
    traceHeadSamplingRate: z.literal(1),
    logsPersisted: z.literal(true),
    tracesPersisted: z.literal(true),
    invocationLogs: z.literal(false),
  }).strict(),
  lookups: LookupsSchema,
  safety: z.object({ canaryDigest: z.string().regex(DIGEST_PATTERN) }).strict(),
  review: z.object({
    reviewer: z.string().regex(ID_PATTERN),
    reviewedAt: TIMESTAMP_SCHEMA,
    workerDeploymentEvidenceUrl: SafeUrlSchema,
    workersLogsEvidenceUrl: SafeUrlSchema,
    workersTracesEvidenceUrl: SafeUrlSchema,
    retentionAndIndexReviewed: z.literal(true),
    secretScanReviewed: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const { lineage, lookups } = manifest;
  const expected = [
    ['task', lineage.taskId, undefined],
    ['run', manifest.runId, undefined],
    ['attempt', lineage.attemptId, undefined],
    ['github_run', lineage.githubRun.id, undefined],
    ['github_pr', String(lineage.pullRequest.number), manifest.repository],
    ['test_deployment', lineage.testDeployment.deploymentId, undefined],
    ['production_deployment', lineage.productionDeployment.deploymentId, undefined],
    ['github_deployment', lineage.testDeployment.githubDeploymentId, manifest.repository],
    ['github_deployment', lineage.productionDeployment.githubDeploymentId, manifest.repository],
    ['trace', lineage.toolTraceId, undefined],
  ] as const;
  if (lookups.some((lookup, index) => {
    const [kind, id, repository] = expected[index]!;
    return lookup.kind !== kind || lookup.id !== id ||
      ('repository' in lookup ? lookup.repository : undefined) !== repository;
  })) context.addIssue({ code: 'custom', message: 'lookup lineage is inconsistent' });
  if (manifest.runId === lineage.taskId || lineage.taskId === lineage.attemptId) {
    context.addIssue({ code: 'custom', message: 'lineage identifiers are not distinct' });
  }
  if (lineage.githubRun.headSha !== lineage.pullRequest.headSha) {
    context.addIssue({ code: 'custom', message: 'GitHub head lineage is inconsistent' });
  }
  const from = Date.parse(manifest.cloudflare.window.from);
  const to = Date.parse(manifest.cloudflare.window.to);
  const recordedAt = Date.parse(manifest.recordedAt);
  const reviewedAt = Date.parse(manifest.review.reviewedAt);
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;
  if (
    from >= to || to > recordedAt || recordedAt - from > sevenDaysMs ||
    reviewedAt > recordedAt || reviewedAt < to ||
    lookups.some((lookup) => {
      const observedAt = Date.parse(lookup.observedAt);
      return observedAt < from || observedAt > to;
    }) || new Set(lookups.map((lookup) => lookup.workerTraceId)).size !== lookups.length
  ) context.addIssue({ code: 'custom', message: 'telemetry window is inconsistent' });
  for (const raw of [
    manifest.review.workerDeploymentEvidenceUrl,
    manifest.review.workersLogsEvidenceUrl,
    manifest.review.workersTracesEvidenceUrl,
  ]) {
    try {
      if (new URL(raw).hostname !== 'dash.cloudflare.com') {
        context.addIssue({ code: 'custom', message: 'review URL is not Cloudflare dashboard' });
      }
    } catch { /* SafeUrlSchema reports shape errors. */ }
  }
});

export type CorrelationPlatformLogRecordV1 = z.infer<
  typeof CorrelationPlatformLogRecordV1Schema
>;
export type CorrelationPlatformEvidenceManifestV1 = z.infer<
  typeof CorrelationPlatformEvidenceManifestV1Schema
>;
