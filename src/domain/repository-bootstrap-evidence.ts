import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const RULE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;
const RULE_SOURCE_PATTERN = /^[A-Za-z0-9_./-]{1,200}$/;

const SafeGitHubUrlSchema = z.string().url().max(2_048).superRefine((raw, context) => {
  let url: URL;
  try { url = new URL(raw); } catch {
    context.addIssue({ code: 'custom', message: 'invalid URL' });
    return;
  }
  if (
    url.protocol !== 'https:' || url.hostname !== 'github.com' ||
    url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
  ) context.addIssue({ code: 'custom', message: 'unsafe GitHub URL' });
});

const RepositoryRuleSchema = z.object({
  rulesetId: z.string().regex(GITHUB_ID_PATTERN),
  type: z.string().regex(RULE_TYPE_PATTERN),
  rulesetSourceType: z.enum(['Repository', 'Organization', 'Enterprise']),
  rulesetSource: z.string().regex(RULE_SOURCE_PATTERN),
  enforcement: z.literal('active'),
  parametersDigest: z.string().regex(DIGEST_PATTERN),
}).strict();

const DecisionSchema = z.object({
  decisionId: z.string().regex(ID_PATTERN),
  confirmedAt: z.iso.datetime({ offset: true }),
  confirmedByPrincipalDigest: z.string().regex(DIGEST_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  visibility: z.enum(['public', 'private', 'internal']),
  defaultBranch: z.string().regex(BRANCH_PATTERN)
    .refine((value) => !value.includes('..') && !value.includes('//')),
  protectionRulesDigest: z.string().regex(DIGEST_PATTERN),
  selectionDigest: z.string().regex(DIGEST_PATTERN),
}).strict();

export const RepositoryBootstrapEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: z.iso.datetime({ offset: true }),
  decision: DecisionSchema,
  repository: z.object({
    githubRepositoryId: z.string().regex(GITHUB_ID_PATTERN),
    ownerLogin: z.string().regex(REPOSITORY_PART_PATTERN),
    ownerType: z.enum(['User', 'Organization']),
    name: z.string().regex(REPOSITORY_PART_PATTERN),
    fullName: z.string().regex(REPOSITORY_PATTERN),
    htmlUrl: SafeGitHubUrlSchema,
    visibility: z.enum(['public', 'private', 'internal']),
    defaultBranch: z.string().regex(BRANCH_PATTERN)
      .refine((value) => !value.includes('..') && !value.includes('//')),
    createdAt: z.iso.datetime({ offset: true }),
    archived: z.literal(false),
    disabled: z.literal(false),
    fork: z.literal(false),
  }).strict(),
  branch: z.object({
    name: z.string().regex(BRANCH_PATTERN)
      .refine((value) => !value.includes('..') && !value.includes('//')),
    headSha: z.string().regex(SHA_PATTERN),
    protected: z.literal(true),
  }).strict(),
  protection: z.object({
    rules: z.array(RepositoryRuleSchema).min(1).max(100),
    rulesDigest: z.string().regex(DIGEST_PATTERN),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const ruleKeys = manifest.protection.rules.map((rule) =>
    `${rule.rulesetId}\0${rule.type}\0${rule.parametersDigest}`);
  const sortedRuleKeys = [...ruleKeys].sort((left, right) => left.localeCompare(right));
  const confirmedAt = Date.parse(manifest.decision.confirmedAt);
  const recordedAt = Date.parse(manifest.recordedAt);
  const createdAt = Date.parse(manifest.repository.createdAt);
  const sourcesMatch = manifest.protection.rules.every((rule) =>
    rule.rulesetSourceType === 'Repository'
      ? rule.rulesetSource === manifest.repository.fullName
      : rule.rulesetSourceType === 'Organization'
        ? rule.rulesetSource === manifest.repository.ownerLogin
        : true);
  if (
    manifest.repository.fullName !== manifest.decision.repository ||
    manifest.repository.fullName !== `${manifest.repository.ownerLogin}/${manifest.repository.name}` ||
    manifest.repository.htmlUrl !== `https://github.com/${manifest.repository.fullName}` ||
    manifest.repository.visibility !== manifest.decision.visibility ||
    manifest.repository.defaultBranch !== manifest.decision.defaultBranch ||
    manifest.branch.name !== manifest.decision.defaultBranch ||
    manifest.protection.rulesDigest !== manifest.decision.protectionRulesDigest ||
    new Set(ruleKeys).size !== ruleKeys.length ||
    ruleKeys.some((key, index) => key !== sortedRuleKeys[index]) ||
    !sourcesMatch || createdAt > confirmedAt || confirmedAt > recordedAt
  ) context.addIssue({ code: 'custom', message: 'repository bootstrap evidence is inconsistent' });
});

export type RepositoryBootstrapEvidenceManifestV1 = z.infer<
  typeof RepositoryBootstrapEvidenceManifestV1Schema
>;
