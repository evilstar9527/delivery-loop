import { z } from 'zod';
import { canonicalSha256 } from './digest.js';
import { patchPathIsSafe } from './patch-proposal.js';

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

const nonBlank = (maximum: number): z.ZodString =>
  z.string().min(1).max(maximum).refine((value) => /\S/.test(value), 'must not be blank');

export const AutomatedReviewIdSchema = z.string()
  .regex(/^automated_review_[a-f0-9]{52}$/);

export const AutomatedReviewFindingV1Schema = z.object({
  severity: z.enum(['blocker', 'major', 'minor']),
  title: nonBlank(200),
  body: nonBlank(1_000),
  path: z.string().min(1).max(240).optional(),
  line: z.number().int().positive().max(10_000_000).optional(),
}).strict().superRefine((finding, context) => {
  if (finding.path !== undefined && !patchPathIsSafe(finding.path)) {
    context.addIssue({ code: 'custom', path: ['path'], message: 'review path is invalid' });
  }
  if (finding.line !== undefined && finding.path === undefined) {
    context.addIssue({ code: 'custom', path: ['line'], message: 'review line requires path' });
  }
});

export const AutomatedReviewResultV1Schema = z.object({
  schemaVersion: z.literal('1'),
  contextDigest: z.string().regex(DIGEST_PATTERN),
  verdict: z.enum(['approved', 'changes_requested']),
  summary: nonBlank(2_000),
  findings: z.array(AutomatedReviewFindingV1Schema).max(20),
}).strict().superRefine((result, context) => {
  const blocking = result.findings.some(
    (finding) => finding.severity === 'blocker' || finding.severity === 'major',
  );
  if ((result.verdict === 'changes_requested') !== blocking) {
    context.addIssue({
      code: 'custom',
      path: ['verdict'],
      message: 'review verdict must match blocker or major findings',
    });
  }
  const identities = new Set<string>();
  for (const [index, finding] of result.findings.entries()) {
    const identity = JSON.stringify([
      finding.severity,
      finding.path ?? '',
      finding.line ?? 0,
      finding.title,
    ]);
    if (identities.has(identity)) {
      context.addIssue({
        code: 'custom',
        path: ['findings', index],
        message: 'review findings must be unique',
      });
    }
    identities.add(identity);
  }
});

export type AutomatedReviewFindingV1 = z.infer<typeof AutomatedReviewFindingV1Schema>;
export type AutomatedReviewResultV1 = z.infer<typeof AutomatedReviewResultV1Schema>;

export const AutomatedReviewContextV1Schema = z.object({
  schemaVersion: z.literal('1'),
  kind: z.literal('automated_review'),
  attempt: z.object({
    id: z.string().regex(ID_PATTERN),
    runId: z.string().regex(ID_PATTERN),
    mode: z.literal('analysis'),
    version: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
    baseSha: z.string().regex(SHA_PATTERN),
  }).strict(),
  review: z.object({
    id: z.string().regex(ID_PATTERN),
    iteration: z.number().int().min(1).max(3),
    publicationId: z.string().regex(ID_PATTERN),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    pullRequestNumber: z.number().int().positive(),
    baseBranch: z.string().min(1).max(240),
    headBranch: z.string().min(1).max(240),
    headSha: z.string().regex(SHA_PATTERN),
  }).strict(),
  task: z.object({
    revision: z.string().min(1).max(500),
    digest: z.string().regex(DIGEST_PATTERN),
    title: nonBlank(1_000),
    description: nonBlank(20_000),
    acceptanceCriteria: z.array(nonBlank(2_000)).min(1).max(100),
  }).strict(),
  plan: z.object({
    id: z.string().regex(ID_PATTERN),
    version: z.number().int().positive(),
    digest: z.string().regex(DIGEST_PATTERN),
    objective: nonBlank(4_000),
    item: z.object({
      id: z.string().regex(ID_PATTERN),
      title: nonBlank(1_000),
      objective: nonBlank(4_000),
      doneWhen: z.array(nonBlank(2_000)).min(1).max(100),
      commandRefs: z.array(nonBlank(200)).max(100),
    }).strict(),
  }).strict(),
}).strict();

export type AutomatedReviewContextV1 = z.infer<typeof AutomatedReviewContextV1Schema>;

const AutomatedReviewDigestAttemptV1Schema = AutomatedReviewContextV1Schema.shape.attempt
  .omit({ version: true })
  .strip();

export async function automatedReviewContextDigest(
  context: AutomatedReviewContextV1,
): Promise<string> {
  const parsed = AutomatedReviewContextV1Schema.parse(context);
  return await canonicalSha256({
    ...parsed,
    attempt: AutomatedReviewDigestAttemptV1Schema.parse(parsed.attempt),
  });
}

export function blockingFindingCount(result: AutomatedReviewResultV1): number {
  return result.findings.filter(
    (finding) => finding.severity === 'blocker' || finding.severity === 'major',
  ).length;
}

export function minorFindingCount(result: AutomatedReviewResultV1): number {
  return result.findings.filter((finding) => finding.severity === 'minor').length;
}

export function renderAutomatedReviewFeedback(result: AutomatedReviewResultV1): string {
  const lines = [result.summary.trim()];
  for (const finding of result.findings.filter(
    (item) => item.severity === 'blocker' || item.severity === 'major',
  )) {
    const location = finding.path === undefined
      ? ''
      : ` (${finding.path}${finding.line === undefined ? '' : `:${finding.line}`})`;
    lines.push('', `[${finding.severity.toUpperCase()}] ${finding.title}${location}`, finding.body);
  }
  return lines.join('\n');
}

export const AUTOMATED_REVIEW_RESULT_V1_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'contextDigest', 'verdict', 'summary', 'findings'],
  properties: {
    schemaVersion: { type: 'string', const: '1' },
    contextDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    verdict: { type: 'string', enum: ['approved', 'changes_requested'] },
    summary: { type: 'string', minLength: 1, maxLength: 2_000 },
    findings: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'body', 'path', 'line'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          body: { type: 'string', minLength: 1, maxLength: 1_000 },
          path: { type: ['string', 'null'], minLength: 1, maxLength: 240 },
          line: { type: ['integer', 'null'], minimum: 1, maximum: 10_000_000 },
        },
      },
    },
  },
} as const;
