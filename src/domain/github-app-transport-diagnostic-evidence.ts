import { z } from 'zod';
import { SAFE_TRANSPORT_FAILURE_KINDS } from '../security/transport-error.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const WORKER_TRACE_PATTERN = /^[a-f0-9]{32}$/;
const TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true });
const FailureKindSchema = z.enum(SAFE_TRANSPORT_FAILURE_KINDS);

const SafeUrlSchema = z.string().url().max(2_048).superRefine((raw, context) => {
  let url: URL;
  try { url = new URL(raw); }
  catch {
    context.addIssue({ code: 'custom', message: 'invalid URL' });
    return;
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) context.addIssue({ code: 'custom', message: 'unsafe URL' });
});

export const GitHubAppTransportDiagnosticLogRecordV1Schema = z.object({
  schemaVersion: z.literal('1'),
  level: z.literal('warn'),
  component: z.literal('github_app_credential'),
  event: z.literal('github_app_installation_token_transport_failed'),
  operation: z.literal('installation_token_exchange'),
  failureKind: FailureKindSchema,
  requestAttempts: z.literal(1),
  observedAt: TIMESTAMP_SCHEMA,
}).strict();

export const GitHubAppTransportDiagnosticPublicSummaryV1Schema = z.object({
  requestAttempts: z.literal(1),
  status: z.literal(503),
  ready: z.literal(false),
  reason: z.literal('credential_transport_unavailable'),
  cacheControl: z.literal('no-store'),
}).strict();

export const GitHubAppTransportDiagnosticCollectionRequestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  collectionId: z.string().regex(ID_PATTERN),
  recordedAt: TIMESTAMP_SCHEMA,
  repository: z.string().regex(REPOSITORY_PATTERN),
  github: z.object({
    actor: z.string().regex(GITHUB_LOGIN_PATTERN),
    headSha: z.string().regex(SHA_PATTERN),
    runId: z.string().regex(GITHUB_ID_PATTERN),
    runAttempt: z.literal(1),
    readinessJobId: z.string().regex(GITHUB_ID_PATTERN),
    readinessStartedAt: TIMESTAMP_SCHEMA,
    readinessCompletedAt: TIMESTAMP_SCHEMA,
  }).strict(),
  cloudflare: z.object({
    accountIdDigest: z.string().regex(DIGEST_PATTERN),
    scriptName: z.string().min(1).max(255).regex(/^[a-z0-9][a-z0-9-]*$/),
    environment: z.literal('production'),
    deploymentId: z.string().regex(UUID_PATTERN),
    versionId: z.string().regex(UUID_PATTERN),
    window: z.object({ from: TIMESTAMP_SCHEMA, to: TIMESTAMP_SCHEMA }).strict(),
  }).strict(),
}).strict().superRefine((request, context) => {
  const [owner] = request.repository.split('/');
  const startedAt = Date.parse(request.github.readinessStartedAt);
  const completedAt = Date.parse(request.github.readinessCompletedAt);
  const recordedAt = Date.parse(request.recordedAt);
  if (request.github.actor !== owner) {
    context.addIssue({ code: 'custom', message: 'readiness actor must be repository owner' });
  }
  if (
    completedAt <= startedAt || completedAt - startedAt > 10 * 60_000 ||
    request.cloudflare.window.from !== request.github.readinessStartedAt ||
    request.cloudflare.window.to !== request.github.readinessCompletedAt
  ) context.addIssue({ code: 'custom', message: 'collection window is not the exact job window' });
  if (recordedAt < completedAt) {
    context.addIssue({ code: 'custom', message: 'collection request timeline is inconsistent' });
  }
});

export const GitHubAppTransportDiagnosticObservationV1Schema = z.object({
  schemaVersion: z.literal('1'),
  collectionId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  githubRunId: z.string().regex(GITHUB_ID_PATTERN),
  githubHeadSha: z.string().regex(SHA_PATTERN),
  githubRunAttempt: z.literal(1),
  readinessJobId: z.string().regex(GITHUB_ID_PATTERN),
  deploymentId: z.string().regex(UUID_PATTERN),
  versionId: z.string().regex(UUID_PATTERN),
  observedAt: TIMESTAMP_SCHEMA,
  workerTraceId: z.string().regex(WORKER_TRACE_PATTERN),
  failureKind: FailureKindSchema,
  logRecordDigest: z.string().regex(DIGEST_PATTERN),
  requestAttempts: z.literal(1),
  cloudflareLogQueries: z.literal(1),
  plaintextLeaks: z.literal(0),
  formalVerification: z.literal('still_required'),
}).strict();

export const GitHubAppTransportDiagnosticEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: TIMESTAMP_SCHEMA,
  repository: z.string().regex(REPOSITORY_PATTERN),
  github: z.object({
    actor: z.string().regex(GITHUB_LOGIN_PATTERN),
    headSha: z.string().regex(SHA_PATTERN),
    runId: z.string().regex(GITHUB_ID_PATTERN),
    runAttempt: z.literal(1),
    preflightJobId: z.string().regex(GITHUB_ID_PATTERN),
    readinessJobId: z.string().regex(GITHUB_ID_PATTERN),
    readinessStartedAt: TIMESTAMP_SCHEMA,
    readinessCompletedAt: TIMESTAMP_SCHEMA,
    publicSummary: GitHubAppTransportDiagnosticPublicSummaryV1Schema,
    publicSummaryDigest: z.string().regex(DIGEST_PATTERN),
  }).strict(),
  cloudflare: z.object({
    accountIdDigest: z.string().regex(DIGEST_PATTERN),
    scriptName: z.string().min(1).max(255).regex(/^[a-z0-9][a-z0-9-]*$/),
    environment: z.literal('production'),
    deploymentId: z.string().regex(UUID_PATTERN),
    versionId: z.string().regex(UUID_PATTERN),
    deploymentCreatedAt: TIMESTAMP_SCHEMA,
    window: z.object({ from: TIMESTAMP_SCHEMA, to: TIMESTAMP_SCHEMA }).strict(),
  }).strict(),
  diagnostic: z.object({
    observedAt: TIMESTAMP_SCHEMA,
    workerTraceId: z.string().regex(WORKER_TRACE_PATTERN),
    failureKind: FailureKindSchema,
    logRecordDigest: z.string().regex(DIGEST_PATTERN),
  }).strict(),
  safety: z.object({ canaryDigest: z.string().regex(DIGEST_PATTERN) }).strict(),
  review: z.object({
    reviewer: z.string().regex(ID_PATTERN),
    reviewedAt: TIMESTAMP_SCHEMA,
    githubRunEvidenceUrl: SafeUrlSchema,
    workerDeploymentEvidenceUrl: SafeUrlSchema,
    workersLogsEvidenceUrl: SafeUrlSchema,
    workersTracesEvidenceUrl: SafeUrlSchema,
    secretScanReviewed: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const [owner] = manifest.repository.split('/');
  const startedAt = Date.parse(manifest.github.readinessStartedAt);
  const completedAt = Date.parse(manifest.github.readinessCompletedAt);
  const observedAt = Date.parse(manifest.diagnostic.observedAt);
  const deploymentCreatedAt = Date.parse(manifest.cloudflare.deploymentCreatedAt);
  const recordedAt = Date.parse(manifest.recordedAt);
  const reviewedAt = Date.parse(manifest.review.reviewedAt);
  if (manifest.github.actor !== owner) {
    context.addIssue({ code: 'custom', message: 'readiness actor must be repository owner' });
  }
  if (
    completedAt <= startedAt || completedAt - startedAt > 10 * 60_000 ||
    manifest.cloudflare.window.from !== manifest.github.readinessStartedAt ||
    manifest.cloudflare.window.to !== manifest.github.readinessCompletedAt
  ) context.addIssue({ code: 'custom', message: 'telemetry window is not the exact job window' });
  if (deploymentCreatedAt >= startedAt) {
    context.addIssue({ code: 'custom', message: 'deployment must predate readiness' });
  }
  if (observedAt < startedAt || observedAt > completedAt) {
    context.addIssue({ code: 'custom', message: 'diagnostic is outside readiness window' });
  }
  if (recordedAt < completedAt || reviewedAt < recordedAt) {
    context.addIssue({ code: 'custom', message: 'evidence timeline is inconsistent' });
  }
  if (
    manifest.review.githubRunEvidenceUrl !==
      `https://github.com/${manifest.repository}/actions/runs/${manifest.github.runId}`
  ) context.addIssue({ code: 'custom', message: 'GitHub review URL is inconsistent' });
});

export type GitHubAppTransportDiagnosticLogRecordV1 = z.infer<
  typeof GitHubAppTransportDiagnosticLogRecordV1Schema
>;
export type GitHubAppTransportDiagnosticCollectionRequestV1 = z.infer<
  typeof GitHubAppTransportDiagnosticCollectionRequestV1Schema
>;
export type GitHubAppTransportDiagnosticObservationV1 = z.infer<
  typeof GitHubAppTransportDiagnosticObservationV1Schema
>;
export type GitHubAppTransportDiagnosticEvidenceManifestV1 = z.infer<
  typeof GitHubAppTransportDiagnosticEvidenceManifestV1Schema
>;
