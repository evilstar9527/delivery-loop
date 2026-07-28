import { z } from 'zod';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const GitHubRequiredCheckFactSchema = z.object({
  context: z.string().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
  integrationId: z.number().int().positive().safe().nullable(),
  state: z.enum(['missing', 'pending', 'passed', 'failed']),
}).strict();

export const GitHubMergeGateFactSchema = z.object({
  schemaVersion: z.literal('1'),
  repository: z.string().regex(REPOSITORY_PATTERN).max(201),
  number: z.number().int().positive().safe(),
  pullRequestAuthorLogin: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  headBranch: z.string().regex(BRANCH_PATTERN).refine(
    (value) => !value.includes('..') && !value.includes('//'),
  ),
  headSha: z.string().regex(SHA_PATTERN),
  baseBranch: z.string().regex(BRANCH_PATTERN).refine(
    (value) => !value.includes('..') && !value.includes('//'),
  ),
  baseSha: z.string().regex(SHA_PATTERN),
  pullRequestBaseSha: z.string().regex(SHA_PATTERN),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  mergeability: z.enum(['mergeable', 'conflicting', 'unknown']),
  mergeState: z.enum([
    'clean',
    'blocked',
    'behind',
    'dirty',
    'draft',
    'has_hooks',
    'unstable',
    'unknown',
  ]),
  reviewDecision: z.enum(['approved', 'review_required', 'changes_requested']),
  requiredApprovals: z.number().int().nonnegative().max(100),
  approvedReviewCount: z.number().int().nonnegative().max(100),
  requiredChecks: z.array(GitHubRequiredCheckFactSchema).max(100),
  policyDigest: z.string().regex(DIGEST_PATTERN),
  checksDigest: z.string().regex(DIGEST_PATTERN),
  reviewsDigest: z.string().regex(DIGEST_PATTERN),
  externalUpdatedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((fact, context) => {
  const identities = fact.requiredChecks.map(
    (check) => `${check.context}\0${check.integrationId ?? ''}`,
  );
  if (new Set(identities).size !== identities.length) {
    context.addIssue({ code: 'custom', message: 'required check identities must be unique' });
  }
  if (identities.some((identity, index) => index > 0 && identities[index - 1]! > identity)) {
    context.addIssue({ code: 'custom', message: 'required checks must be sorted' });
  }
});

export type GitHubRequiredCheckFact = z.infer<typeof GitHubRequiredCheckFactSchema>;
export type GitHubMergeGateFact = z.infer<typeof GitHubMergeGateFactSchema>;
