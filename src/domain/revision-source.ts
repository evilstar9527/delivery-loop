import { z } from 'zod';
import { AutomatedReviewIdSchema } from './automated-review.js';
import { TaskEnvelopeSchema, TaskSourceSystemSchema } from './task.js';

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;

export const ReviewFeedbackRevisionDataSchema = z.object({
  schemaVersion: z.literal('1'),
  reviewId: z.union([z.string().regex(/^[0-9]+$/), AutomatedReviewIdSchema]),
  body: z.string().min(1).max(65_536),
  bodyDigest: z.string().regex(DIGEST_PATTERN),
  sourceHeadSha: z.string().regex(SHA_PATTERN),
  branch: z.string().min(1).max(240),
  url: z.url().max(2_000),
  submittedAt: z.iso.datetime({ offset: true }),
}).strict();

export const SupplementalContextDataSchema = z.object({
  schemaVersion: z.literal('1'),
  source: z.object({
    system: TaskSourceSystemSchema,
    tenantKey: z.string().min(1).max(200),
    taskKey: z.string().min(1).max(500),
    priorRevision: z.string().min(1).max(500),
    revision: z.string().min(1).max(500),
  }).strict(),
  actor: z.object({
    type: z.enum(['user', 'bot', 'system']),
    id: z.string().min(1).max(500),
  }).strict(),
  body: z.string().min(1).max(65_536).refine((value) => /\S/.test(value)),
}).strict();

export const SupplementalContextRevisionDataSchema = SupplementalContextDataSchema.extend({
  taskRevision: z.object({
    digest: z.string().regex(DIGEST_PATTERN),
    task: TaskEnvelopeSchema,
  }).strict(),
}).strict();

export const BaseUpdateRevisionDataSchema = z.object({
  schemaVersion: z.literal('1'),
  repository: z.string().regex(REPOSITORY_PATTERN),
  baseBranch: z.string().regex(BRANCH_PATTERN),
  beforeSha: z.string().regex(SHA_PATTERN),
  afterSha: z.string().regex(SHA_PATTERN),
  relationship: z.literal('ahead'),
  aheadBy: z.number().int().positive(),
  referenceDigest: z.string().regex(DIGEST_PATTERN),
  comparisonDigest: z.string().regex(DIGEST_PATTERN),
}).strict();

export const AnalysisRevisionSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    schemaVersion: z.literal('1'),
    kind: z.literal('review_feedback'),
    digest: z.string().regex(DIGEST_PATTERN),
    data: ReviewFeedbackRevisionDataSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal('1'),
    kind: z.literal('supplemental_context'),
    digest: z.string().regex(DIGEST_PATTERN),
    data: SupplementalContextRevisionDataSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal('1'),
    kind: z.literal('base_update'),
    digest: z.string().regex(DIGEST_PATTERN),
    data: BaseUpdateRevisionDataSchema,
  }).strict(),
]);

export type SupplementalContextData = z.infer<typeof SupplementalContextDataSchema>;
export type AnalysisRevisionSource = z.infer<typeof AnalysisRevisionSourceSchema>;
