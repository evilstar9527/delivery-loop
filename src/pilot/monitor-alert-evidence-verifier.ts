import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import {
  MONITOR_ALERT_CONFIGURATION_NAMES,
  MonitorAlertEvidenceManifestV1Schema,
  MonitorAlertObservabilityReportV1Schema,
  type MonitorAlertEvidenceManifestV1,
  type MonitorAlertObservabilityReportV1,
} from '../domain/monitor-alert-evidence.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const TimestampSchema = z.iso.datetime({ offset: true });
const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/);

const CountsSchema = z.object({
  receipts: z.number().int().nonnegative().max(10_000),
  lineages: z.number().int().nonnegative().max(10_000),
  candidates: z.number().int().nonnegative().max(10_000),
  taskSources: z.number().int().nonnegative().max(10_000),
  runs: z.number().int().nonnegative().max(10_000),
  approvals: z.number().int().nonnegative().max(10_000),
  outboxes: z.number().int().nonnegative().max(10_000),
}).strict();

const MonitorProjectionSchema = z.object({
  schemaVersion: z.literal('1'),
  adapter: z.literal('generic'),
  tenantKey: z.string().min(1).max(200),
  eventId: z.string().min(1).max(200),
  found: z.boolean(),
  counts: CountsSchema,
  receipt: z.object({
    receiptId: IdSchema,
    lineageId: IdSchema,
    candidateId: IdSchema,
    occurrenceOrdinal: z.number().int().positive().max(10_000),
    suppressed: z.boolean(),
    occurredAt: TimestampSchema,
    receivedAt: TimestampSchema,
  }).strict().nullable(),
  mapping: z.object({
    repository: z.string().min(1).max(201),
    alertRuleId: z.string().min(1).max(200),
    environment: z.enum(['none', 'test', 'production']),
    severity: z.enum(['info', 'warning', 'error', 'critical']),
    suppressionWindowMs: z.number().int().min(60_000).max(86_400_000),
  }).strict().nullable(),
  candidate: z.object({
    candidateId: IdSchema,
    status: z.literal('triaging'),
    occurrenceCount: z.number().int().positive().max(10_000),
    lineageCount: z.number().int().positive().max(10_000),
    firstSeenAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
    suppressionExpiresAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  }).strict().nullable(),
  snapshot: z.object({
    objectPresent: z.boolean(),
    objectVerified: z.boolean(),
  }).strict().nullable(),
}).strict();

const CloudflareSettingsSchema = z.object({
  success: z.literal(true),
  errors: z.array(z.unknown()),
  messages: z.array(z.unknown()),
  result: z.object({
    bindings: z.array(z.object({
      name: z.string().min(1).max(200),
      type: z.string().min(1).max(100),
      text: z.string().max(100_000).optional(),
    }).passthrough()).max(10_000),
  }).passthrough(),
}).strict();

const SentryProjectSchema = z.object({
  id: z.union([z.string(), z.number().int().nonnegative()]),
  slug: z.string(),
  organization: z.object({ slug: z.string() }).passthrough(),
}).passthrough();

const SentryRuleSchema = z.object({
  id: z.union([z.string(), z.number().int().nonnegative()]),
  environment: z.string().nullable().optional(),
}).passthrough();

export type MonitorAlertEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'cloudflare_api_unavailable'
  | 'cloudflare_response_invalid'
  | 'cloudflare_configuration_mismatch'
  | 'observability_unavailable'
  | 'observability_response_invalid'
  | 'observability_digest_mismatch'
  | 'observation_mismatch'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'projection_mismatch'
  | 'effect_observed'
  | 'sentry_api_unavailable'
  | 'sentry_response_invalid'
  | 'sentry_fact_mismatch'
  | 'secret_leak_detected';

export class MonitorAlertEvidenceVerificationError extends Error {
  constructor(readonly code: MonitorAlertEvidenceVerificationErrorCode) {
    super(`Monitor alert evidence verification failed: ${code}`);
    this.name = 'MonitorAlertEvidenceVerificationError';
  }
}

export interface MonitorAlertEvidenceVerifierOptions {
  cloudflareApiUrl: string;
  cloudflareApiToken: string;
  canary: string;
  controlPlaneOrigin?: string;
  operationsToken?: string;
  observabilityReportUrl?: string;
  observabilityToken?: string;
  sentryApiOrigin?: string;
  sentryReadToken?: string;
  fetcher?: typeof fetch;
}

export type MonitorAlertEvidenceVerificationSummary = {
  schemaVersion: '1';
  evidenceId: string;
  productionDecision: 'not_enabled';
  cloudflareConfiguration: 'absent';
  plaintextLeaks: 0;
  humanReview: 'required_and_recorded';
} | {
  schemaVersion: '1';
  evidenceId: string;
  productionDecision: 'enabled';
  provider: 'sentry';
  cloudflareConfiguration: 'present_and_bound';
  acceptedEvents: 4;
  suppressedEvents: 2;
  triageCandidates: 2;
  rejectedEventsWithoutReceipt: 3;
  authorityEffects: 0;
  privateSnapshots: 'verified';
  plaintextLeaks: 0;
  humanReview: 'required_and_recorded';
};

type HttpSource = 'cloudflare' | 'observability' | 'control_plane' | 'sentry';

function unavailable(source: HttpSource): MonitorAlertEvidenceVerificationErrorCode {
  if (source === 'cloudflare') return 'cloudflare_api_unavailable';
  if (source === 'observability') return 'observability_unavailable';
  if (source === 'control_plane') return 'control_plane_unavailable';
  return 'sentry_api_unavailable';
}

function invalid(source: HttpSource): MonitorAlertEvidenceVerificationErrorCode {
  if (source === 'cloudflare') return 'cloudflare_response_invalid';
  if (source === 'observability') return 'observability_response_invalid';
  if (source === 'control_plane') return 'control_plane_response_invalid';
  return 'sentry_response_invalid';
}

function safeUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new MonitorAlertEvidenceVerificationError('configuration_invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.hash !== ''
  ) throw new MonitorAlertEvidenceVerificationError('configuration_invalid');
  return url.toString();
}

function safeOrigin(raw: string): string {
  const normalized = safeUrl(raw);
  const url = new URL(normalized);
  if (url.search !== '' || (url.pathname !== '' && url.pathname !== '/')) {
    throw new MonitorAlertEvidenceVerificationError('configuration_invalid');
  }
  return url.origin;
}

async function boundedText(response: Response): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  source: HttpSource,
  scanner: SecretScanner,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new MonitorAlertEvidenceVerificationError(unavailable(source));
  }
  if (!response.ok || /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new MonitorAlertEvidenceVerificationError(unavailable(source));
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new MonitorAlertEvidenceVerificationError(invalid(source));
  }
  let text: string | null;
  try { text = await boundedText(response); }
  catch { throw new MonitorAlertEvidenceVerificationError(invalid(source)); }
  if (text === null) throw new MonitorAlertEvidenceVerificationError(invalid(source));
  if (scanner.scanText(text, `$.${source}`).length > 0) {
    throw new MonitorAlertEvidenceVerificationError('secret_leak_detected');
  }
  try { return JSON.parse(text) as unknown; }
  catch { throw new MonitorAlertEvidenceVerificationError(invalid(source)); }
}

function requiredToken(value: string | undefined): string {
  if (value === undefined || !TOKEN_PATTERN.test(value)) {
    throw new MonitorAlertEvidenceVerificationError('configuration_invalid');
  }
  return value;
}

function validateCloudflareConfiguration(
  raw: unknown,
  manifest: MonitorAlertEvidenceManifestV1,
): void {
  const parsed = CloudflareSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MonitorAlertEvidenceVerificationError('cloudflare_response_invalid');
  }
  const targets = parsed.data.result.bindings.filter((binding) =>
    (MONITOR_ALERT_CONFIGURATION_NAMES as readonly string[]).includes(binding.name));
  if (new Set(targets.map((binding) => binding.name)).size !== targets.length) {
    throw new MonitorAlertEvidenceVerificationError('cloudflare_configuration_mismatch');
  }
  if (manifest.mode === 'disabled') {
    if (targets.length !== 0) {
      throw new MonitorAlertEvidenceVerificationError('cloudflare_configuration_mismatch');
    }
    return;
  }
  const byName = new Map(targets.map((binding) => [binding.name, binding]));
  const secret = byName.get('MONITOR_WEBHOOK_SECRET');
  const tenant = byName.get('MONITOR_TENANT_KEY');
  const repositories = byName.get('MONITOR_ALLOWED_REPOSITORIES');
  const window = byName.get('MONITOR_SUPPRESSION_WINDOW_SECONDS');
  if (
    targets.length !== MONITOR_ALERT_CONFIGURATION_NAMES.length ||
    secret?.type !== 'secret_text' ||
    tenant?.type !== 'plain_text' || tenant.text !== manifest.profile.tenantKey ||
    repositories?.type !== 'plain_text' ||
    repositories.text !== JSON.stringify(manifest.profile.allowedRepositories) ||
    window?.type !== 'plain_text' ||
    window.text !== String(manifest.profile.suppressionWindowMs / 1_000)
  ) throw new MonitorAlertEvidenceVerificationError('cloudflare_configuration_mismatch');
}

async function validateReport(
  raw: unknown,
  manifest: Extract<MonitorAlertEvidenceManifestV1, { mode: 'enabled' }>,
): Promise<MonitorAlertObservabilityReportV1> {
  const parsed = MonitorAlertObservabilityReportV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new MonitorAlertEvidenceVerificationError('observability_response_invalid');
  }
  const report = parsed.data;
  const { reportDigest, ...body } = report;
  if (
    report.evidenceId !== manifest.evidenceId ||
    reportDigest !== manifest.observabilityReportDigest ||
    await canonicalSha256(body) !== reportDigest ||
    Date.parse(report.generatedAt) > Date.parse(manifest.recordedAt)
  ) throw new MonitorAlertEvidenceVerificationError('observability_digest_mismatch');

  for (const event of manifest.events) {
    const observation = report.requests.find((item) => item.scenario === event.scenario);
    if (
      observation === undefined || observation.sourceEventId !== event.sourceEventId ||
      observation.eventId !== event.eventId || observation.receiptId !== event.receiptId ||
      observation.lineageId !== event.lineageId || observation.candidateId !== event.candidateId
    ) throw new MonitorAlertEvidenceVerificationError('observation_mismatch');
  }
  const primary = manifest.events.find((item) => item.scenario === 'primary')!;
  const retry = report.requests.find((item) => item.scenario === 'retry')!;
  if (
    retry.sourceEventId !== primary.sourceEventId || retry.eventId !== primary.eventId ||
    retry.receiptId !== primary.receiptId || retry.lineageId !== primary.lineageId ||
    retry.candidateId !== primary.candidateId
  ) throw new MonitorAlertEvidenceVerificationError('observation_mismatch');
  for (const rejection of manifest.rejections) {
    const observation = report.requests.find((item) => item.scenario === rejection.scenario);
    if (
      observation === undefined || observation.sourceEventId !== rejection.sourceEventId ||
      observation.eventId !== rejection.eventId ||
      observation.statusCode !== rejection.expectedStatus ||
      observation.reasonCode !== rejection.expectedReason
    ) throw new MonitorAlertEvidenceVerificationError('observation_mismatch');
  }
  return report;
}

function zeroAuthority(counts: z.infer<typeof CountsSchema>): boolean {
  return counts.taskSources === 0 && counts.runs === 0 &&
    counts.approvals === 0 && counts.outboxes === 0;
}

function validateAcceptedProjection(
  raw: unknown,
  manifest: Extract<MonitorAlertEvidenceManifestV1, { mode: 'enabled' }>,
  expected: Extract<MonitorAlertEvidenceManifestV1, { mode: 'enabled' }>['events'][number],
): void {
  const parsed = MonitorProjectionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MonitorAlertEvidenceVerificationError('control_plane_response_invalid');
  }
  const projection = parsed.data;
  const candidateSize = expected.scenario === 'after_window' ? 1 : 3;
  if (
    projection.schemaVersion !== '1' || projection.adapter !== manifest.profile.adapter ||
    projection.tenantKey !== manifest.profile.tenantKey || projection.eventId !== expected.eventId ||
    !projection.found || projection.counts.receipts !== 1 || projection.counts.lineages !== 1 ||
    projection.counts.candidates !== 1 || !zeroAuthority(projection.counts) ||
    projection.receipt?.receiptId !== expected.receiptId ||
    projection.receipt.lineageId !== expected.lineageId ||
    projection.receipt.candidateId !== expected.candidateId ||
    projection.receipt.occurrenceOrdinal !== expected.occurrenceOrdinal ||
    projection.receipt.suppressed !== expected.suppressed ||
    projection.receipt.occurredAt !== expected.occurredAt ||
    projection.receipt.receivedAt !== expected.receivedAt ||
    projection.mapping?.repository !== manifest.profile.repository ||
    projection.mapping.alertRuleId !== manifest.profile.alertRuleId ||
    projection.mapping.environment !== manifest.profile.environment ||
    projection.mapping.severity !== manifest.profile.severity ||
    projection.mapping.suppressionWindowMs !== manifest.profile.suppressionWindowMs ||
    projection.candidate?.candidateId !== expected.candidateId ||
    projection.candidate.occurrenceCount !== candidateSize ||
    projection.candidate.lineageCount !== candidateSize ||
    projection.snapshot?.objectPresent !== true || projection.snapshot.objectVerified !== true
  ) {
    if (!zeroAuthority(projection.counts)) {
      throw new MonitorAlertEvidenceVerificationError('effect_observed');
    }
    throw new MonitorAlertEvidenceVerificationError('projection_mismatch');
  }
}

function validateRejectedProjection(
  raw: unknown,
  manifest: Extract<MonitorAlertEvidenceManifestV1, { mode: 'enabled' }>,
  eventId: string,
): void {
  const parsed = MonitorProjectionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MonitorAlertEvidenceVerificationError('control_plane_response_invalid');
  }
  const projection = parsed.data;
  if (!zeroAuthority(projection.counts)) {
    throw new MonitorAlertEvidenceVerificationError('effect_observed');
  }
  if (
    projection.tenantKey !== manifest.profile.tenantKey || projection.eventId !== eventId ||
    projection.found || Object.values(projection.counts).some((count) => count !== 0) ||
    projection.receipt !== null || projection.mapping !== null || projection.candidate !== null ||
    projection.snapshot !== null
  ) throw new MonitorAlertEvidenceVerificationError('projection_mismatch');
}

async function validateSentry(
  fetcher: typeof fetch,
  scanner: SecretScanner,
  token: string,
  origin: string,
  manifest: Extract<MonitorAlertEvidenceManifestV1, { mode: 'enabled' }>,
): Promise<void> {
  const projectRaw = await getJson(
    fetcher,
    `${origin}/api/0/projects/${encodeURIComponent(manifest.source.organizationSlug)}/` +
      `${encodeURIComponent(manifest.source.projectSlug)}/`,
    token,
    'sentry',
    scanner,
  );
  const project = SentryProjectSchema.safeParse(projectRaw);
  if (!project.success) {
    throw new MonitorAlertEvidenceVerificationError('sentry_response_invalid');
  }
  const ruleRaw = await getJson(
    fetcher,
    `${origin}/api/0/projects/${encodeURIComponent(manifest.source.organizationSlug)}/` +
      `${encodeURIComponent(manifest.source.projectSlug)}/rules/` +
      `${encodeURIComponent(manifest.source.ruleId)}/`,
    token,
    'sentry',
    scanner,
  );
  const rule = SentryRuleSchema.safeParse(ruleRaw);
  if (!rule.success) {
    throw new MonitorAlertEvidenceVerificationError('sentry_response_invalid');
  }
  const expectedEnvironment = manifest.profile.environment === 'none'
    ? null
    : manifest.profile.environment;
  if (
    String(project.data.id) !== manifest.source.projectId ||
    project.data.slug !== manifest.source.projectSlug ||
    project.data.organization.slug !== manifest.source.organizationSlug ||
    String(rule.data.id) !== manifest.source.ruleId ||
    (rule.data.environment ?? null) !== expectedEnvironment
  ) throw new MonitorAlertEvidenceVerificationError('sentry_fact_mismatch');
}

export async function verifyMonitorAlertEvidence(
  input: MonitorAlertEvidenceManifestV1,
  options: MonitorAlertEvidenceVerifierOptions,
): Promise<MonitorAlertEvidenceVerificationSummary> {
  const parsed = MonitorAlertEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new MonitorAlertEvidenceVerificationError('manifest_invalid');
  const manifest = parsed.data;
  if (
    !TOKEN_PATTERN.test(options.cloudflareApiToken) ||
    !CANARY_PATTERN.test(options.canary) ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    manifest.safety.canaryDigest !== await canonicalSha256(options.canary)
  ) throw new MonitorAlertEvidenceVerificationError('configuration_invalid');
  const cloudflareUrl = safeUrl(options.cloudflareApiUrl);
  if (cloudflareUrl !== safeUrl(manifest.worker.settingsUrl)) {
    throw new MonitorAlertEvidenceVerificationError('configuration_invalid');
  }

  const enabledTokens = manifest.mode === 'enabled' ? {
    operations: requiredToken(options.operationsToken),
    observability: requiredToken(options.observabilityToken),
    sentry: requiredToken(options.sentryReadToken),
  } : null;
  const scanner = new SecretScanner({
    secrets: [
      options.cloudflareApiToken,
      options.canary,
      ...(enabledTokens === null ? [] : Object.values(enabledTokens)),
    ],
  });
  const fetcher = options.fetcher ?? fetch;
  const cloudflareRaw = await getJson(
    fetcher,
    cloudflareUrl,
    options.cloudflareApiToken,
    'cloudflare',
    scanner,
  );
  validateCloudflareConfiguration(cloudflareRaw, manifest);

  if (manifest.mode === 'disabled') {
    return {
      schemaVersion: '1',
      evidenceId: manifest.evidenceId,
      productionDecision: 'not_enabled',
      cloudflareConfiguration: 'absent',
      plaintextLeaks: 0,
      humanReview: 'required_and_recorded',
    };
  }
  if (enabledTokens === null) {
    throw new MonitorAlertEvidenceVerificationError('configuration_invalid');
  }

  const controlOrigin = safeOrigin(options.controlPlaneOrigin ?? '');
  const reportUrl = safeUrl(options.observabilityReportUrl ?? '');
  const sentryOrigin = safeOrigin(options.sentryApiOrigin ?? 'https://sentry.io');
  if (
    controlOrigin !== safeOrigin(manifest.controlPlaneOrigin) ||
    reportUrl !== safeUrl(manifest.observabilityReportUrl)
  ) throw new MonitorAlertEvidenceVerificationError('configuration_invalid');
  const reportRaw = await getJson(
    fetcher,
    reportUrl,
    enabledTokens.observability,
    'observability',
    scanner,
  );
  await validateReport(reportRaw, manifest);

  const evidenceUrl = `${controlOrigin}/v1/operations/monitor-alert/evidence`;
  for (const event of manifest.events) {
    const raw = await getJson(
      fetcher,
      `${evidenceUrl}?tenantKey=${encodeURIComponent(manifest.profile.tenantKey)}` +
        `&eventId=${encodeURIComponent(event.eventId)}`,
      enabledTokens.operations,
      'control_plane',
      scanner,
    );
    validateAcceptedProjection(raw, manifest, event);
  }
  for (const rejection of manifest.rejections) {
    const raw = await getJson(
      fetcher,
      `${evidenceUrl}?tenantKey=${encodeURIComponent(manifest.profile.tenantKey)}` +
        `&eventId=${encodeURIComponent(rejection.eventId)}`,
      enabledTokens.operations,
      'control_plane',
      scanner,
    );
    validateRejectedProjection(raw, manifest, rejection.eventId);
  }
  await validateSentry(
    fetcher,
    scanner,
    enabledTokens.sentry,
    sentryOrigin,
    manifest,
  );

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    productionDecision: 'enabled',
    provider: 'sentry',
    cloudflareConfiguration: 'present_and_bound',
    acceptedEvents: 4,
    suppressedEvents: 2,
    triageCandidates: 2,
    rejectedEventsWithoutReceipt: 3,
    authorityEffects: 0,
    privateSnapshots: 'verified',
    plaintextLeaks: 0,
    humanReview: 'required_and_recorded',
  };
}
