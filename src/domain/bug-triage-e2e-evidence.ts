import { z } from 'zod';
import { DIAGNOSTIC_LOCATOR_KINDS } from './diagnostic-evidence.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const IdSchema = z.string().regex(ID_PATTERN);
const DigestSchema = z.string().regex(DIGEST_PATTERN);
const TimestampSchema = z.iso.datetime({ offset: true });
const SafeEvidenceUrlSchema = z.string().min(1).max(2_048).superRefine((raw, context) => {
  let url: URL;
  try { url = new URL(raw); }
  catch {
    context.addIssue({ code: 'custom', message: 'evidence URL is invalid' });
    return;
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) context.addIssue({ code: 'custom', message: 'evidence URL is unsafe' });
});

export const BugTriageE2EEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  scenario: z.literal('E2E-2'),
  evidenceId: IdSchema,
  recordedAt: TimestampSchema,
  components: z.object({
    analysisAction: z.object({
      evidenceId: IdSchema,
      manifestDigest: DigestSchema,
    }).strict(),
  }).strict(),
  lineage: z.object({
    repository: z.string().regex(REPOSITORY_PATTERN),
    taskId: IdSchema,
    taskRevision: z.string().min(1).max(500).refine((value) => !/[\0\r\n]/.test(value)),
    taskDigest: DigestSchema,
    runId: IdSchema,
    runVersion: z.number().int().positive().max(1_000_000),
    planId: IdSchema,
    planVersion: z.number().int().positive().max(1_000_000),
    planDigest: DigestSchema,
    baseSha: z.string().regex(SHA_PATTERN),
    analysisAttemptId: IdSchema,
    analysisActionRunId: z.string().regex(GITHUB_ID_PATTERN),
  }).strict(),
  diagnosis: z.object({
    evidenceId: IdSchema,
    evidenceRef: z.string().regex(/^d1:\/\/evidence\/[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/),
    locatorKinds: z.array(z.enum(DIAGNOSTIC_LOCATOR_KINDS)).min(1).max(3),
    locatorDigest: DigestSchema,
    rootCauseDigest: DigestSchema,
    evidenceDigest: DigestSchema,
    logsTraceId: IdSchema,
    requestTraceId: IdSchema,
    observedAt: TimestampSchema,
  }).strict(),
  safety: z.object({ canaryDigest: DigestSchema }).strict(),
  review: z.object({
    reviewer: IdSchema,
    reviewedAt: TimestampSchema,
    sourceEvidenceUrl: SafeEvidenceUrlSchema,
    locatorInputReviewed: z.literal(true),
    rootCauseReviewed: z.literal(true),
    noProductionWriteReviewed: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  if (
    manifest.diagnosis.evidenceRef !== `d1://evidence/${manifest.diagnosis.evidenceId}` ||
    manifest.diagnosis.logsTraceId === manifest.diagnosis.requestTraceId ||
    new Set(manifest.diagnosis.locatorKinds).size !== manifest.diagnosis.locatorKinds.length ||
    manifest.diagnosis.locatorKinds.some((kind, index) =>
      index > 0 && DIAGNOSTIC_LOCATOR_KINDS.indexOf(kind) <=
        DIAGNOSTIC_LOCATOR_KINDS.indexOf(manifest.diagnosis.locatorKinds[index - 1]!)) ||
    Date.parse(manifest.diagnosis.observedAt) > Date.parse(manifest.recordedAt) ||
    Date.parse(manifest.review.reviewedAt) > Date.parse(manifest.recordedAt)
  ) context.addIssue({ code: 'custom', message: 'E2E-2 evidence is inconsistent' });
});

export type BugTriageE2EEvidenceManifestV1 = z.infer<
  typeof BugTriageE2EEvidenceManifestV1Schema
>;
