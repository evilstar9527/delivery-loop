import { z } from 'zod';
import {
  ATTEMPTED_PATHS,
  DEFAULT_MAX_ATTEMPTS,
  HUMAN_INPUT_CODES,
  REPEATED_FAILURE_LIMIT,
} from './attempt-failure.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;

const IdSchema = z.string().regex(ID_PATTERN);
const TimestampSchema = z.iso.datetime({ offset: true });

const BlockedAttemptSchema = z.object({
  attemptId: IdSchema,
  ordinal: z.number().int().positive(),
  pathCodes: z.array(z.enum(ATTEMPTED_PATHS)).min(1).max(ATTEMPTED_PATHS.length)
    .refine((paths) => new Set(paths).size === paths.length, 'path codes must be unique'),
}).strict();

const FailureBlockerSchema = z.object({
  blockerId: IdSchema,
  reason: z.enum(['repeated_fingerprint', 'attempt_limit']),
  fingerprintDigest: z.string().regex(DIGEST_PATTERN),
  attemptCount: z.number().int().positive().max(DEFAULT_MAX_ATTEMPTS),
  consecutiveFingerprintCount: z.number().int().positive().max(DEFAULT_MAX_ATTEMPTS),
  attempts: z.array(BlockedAttemptSchema).min(REPEATED_FAILURE_LIMIT).max(DEFAULT_MAX_ATTEMPTS),
  neededHumanInput: z.enum(HUMAN_INPUT_CODES),
  createdAt: TimestampSchema,
}).strict().superRefine((blocker, context) => {
  if (
    blocker.attemptCount !== blocker.attempts.length ||
    blocker.consecutiveFingerprintCount > blocker.attemptCount ||
    new Set(blocker.attempts.map((attempt) => attempt.attemptId)).size !== blocker.attempts.length
  ) {
    context.addIssue({ code: 'custom', message: 'blocker attempt lineage is inconsistent' });
  }
  for (let index = 1; index < blocker.attempts.length; index += 1) {
    if (blocker.attempts[index]!.ordinal <= blocker.attempts[index - 1]!.ordinal) {
      context.addIssue({ code: 'custom', message: 'attempt ordinals must increase' });
      break;
    }
  }
  if (
    blocker.reason === 'repeated_fingerprint' &&
    blocker.consecutiveFingerprintCount < REPEATED_FAILURE_LIMIT
  ) {
    context.addIssue({ code: 'custom', message: 'repeated fingerprint threshold is not met' });
  }
  if (
    blocker.reason === 'attempt_limit' &&
    blocker.attemptCount < DEFAULT_MAX_ATTEMPTS
  ) {
    context.addIssue({ code: 'custom', message: 'attempt limit threshold is not met' });
  }
});

const DeliveredCardSchema = z.object({
  presentationId: IdSchema,
  revision: z.number().int().positive(),
  presentationDigest: z.string().regex(DIGEST_PATTERN),
  renderedCardDigest: z.string().regex(DIGEST_PATTERN),
  outboxId: IdSchema,
  messageId: z.string().regex(MESSAGE_ID_PATTERN),
  appId: z.string().regex(TARGET_ID_PATTERN),
  tenantKey: z.string().regex(TARGET_ID_PATTERN),
  chatId: z.string().regex(TARGET_ID_PATTERN),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const FailureBlockerCardEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  recordedAt: TimestampSchema,
  taskId: IdSchema,
  runId: IdSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  blocker: FailureBlockerSchema,
  card: DeliveredCardSchema,
}).strict().superRefine((manifest, context) => {
  const blockerAt = Date.parse(manifest.blocker.createdAt);
  const createdAt = Date.parse(manifest.card.createdAt);
  const updatedAt = Date.parse(manifest.card.updatedAt);
  const recordedAt = Date.parse(manifest.recordedAt);
  if (createdAt > updatedAt || blockerAt > updatedAt || updatedAt > recordedAt) {
    context.addIssue({ code: 'custom', message: 'evidence timestamps are inconsistent' });
  }
});

export type FailureBlockerCardEvidenceManifestV1 = z.infer<
  typeof FailureBlockerCardEvidenceManifestV1Schema
>;
