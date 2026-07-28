import { z } from 'zod';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const LOGIN_PATTERN = /^[A-Za-z0-9_.\-[\]]{1,100}$/;

const safeUrl = z.url().max(2_000).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' &&
      url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}, 'merge URL must be a public HTTPS URL without query or fragment');

export const GitHubPullRequestMergeFactSchema = z.object({
  schemaVersion: z.literal('1'),
  repository: z.string().regex(REPOSITORY_PATTERN).max(201),
  number: z.number().int().positive().safe(),
  url: safeUrl,
  state: z.literal('closed'),
  merged: z.literal(true),
  headBranch: z.string().regex(BRANCH_PATTERN),
  headSha: z.string().regex(SHA_PATTERN),
  baseBranch: z.string().regex(BRANCH_PATTERN),
  mergeSha: z.string().regex(SHA_PATTERN),
  mergedByLogin: z.string().regex(LOGIN_PATTERN),
  mergedAt: z.iso.datetime({ offset: true }),
  externalUpdatedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((fact, context) => {
  if (Date.parse(fact.externalUpdatedAt) < Date.parse(fact.mergedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['externalUpdatedAt'],
      message: 'external update cannot precede merge time',
    });
  }
});

export type GitHubPullRequestMergeFact = z.infer<typeof GitHubPullRequestMergeFactSchema>;
