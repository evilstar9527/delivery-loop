import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PRINCIPAL_PATTERN = /^(?:user|service|agent):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const EVENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const TimestampSchema = z.iso.datetime({ offset: true });

const SourceSchema = z.object({
  provider: z.enum(['github', 'feishu']),
  tenantKey: z.string().regex(SUBJECT_PATTERN),
  externalEventId: z.string().regex(EVENT_PATTERN),
  externalSubject: z.string().regex(SUBJECT_PATTERN),
  sourceId: z.string().regex(ID_PATTERN),
  eventDigest: z.string().regex(DIGEST_PATTERN),
  channel: z.string().regex(CHANNEL_PATTERN),
  channelUserId: z.string().regex(SUBJECT_PATTERN),
  occurredAt: TimestampSchema,
}).strict();

const IdentitySchema = z.object({
  approverPrincipal: z.string().regex(PRINCIPAL_PATTERN),
  approverRoles: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/))
    .min(1).max(100),
  approverRolesDigest: z.string().regex(DIGEST_PATTERN),
  authorPrincipal: z.string().regex(PRINCIPAL_PATTERN),
  authorChannel: z.string().regex(CHANNEL_PATTERN),
  authorLogin: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  separationVerified: z.boolean(),
}).strict();

const GitHubContextSchema = z.object({
  pullRequestNumber: z.number().int().positive().safe(),
  headBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/),
  baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/),
  headSha: z.string().regex(SHA_PATTERN),
}).strict();

const BaseCaseSchema = z.object({
  caseId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  runVersion: z.number().int().nonnegative(),
  currentRunVersion: z.number().int().nonnegative(),
  taskRevision: z.string().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
  planId: z.string().regex(ID_PATTERN),
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(DIGEST_PATTERN),
  baseSha: z.string().regex(SHA_PATTERN),
  effect: z.enum(['merge', 'production_deploy']),
  decision: z.literal('approve'),
  source: SourceSchema,
  identity: IdentitySchema,
  github: GitHubContextSchema.nullable(),
  noEffect: z.object({
    mergeOutboxes: z.literal(0),
    merges: z.literal(0),
    productionOutboxes: z.literal(0),
    productionDeployments: z.literal(0),
  }).strict(),
}).strict();

const AcceptedCaseSchema = BaseCaseSchema.extend({
  outcome: z.literal('accepted'),
  approvalId: z.string().regex(ID_PATTERN),
  lineageId: z.string().regex(ID_PATTERN),
  rejectionId: z.null(),
  rejectionReason: z.null(),
  expiresAt: TimestampSchema,
}).strict();

const RejectedCaseSchema = BaseCaseSchema.extend({
  outcome: z.literal('rejected'),
  approvalId: z.null(),
  lineageId: z.null(),
  rejectionId: z.string().regex(ID_PATTERN),
  rejectionReason: z.enum([
    'identity_unresolved', 'actor_not_human', 'actor_not_authorized',
    'self_approval_denied', 'task_actor_self_approval',
  ]),
  expiresAt: z.null(),
}).strict();

export const IdentityApprovalEvidenceCaseSchema = z.discriminatedUnion('outcome', [
  AcceptedCaseSchema,
  RejectedCaseSchema,
]).superRefine((item, context) => {
  const sourceBindingInvalid =
    item.source.channel !== `${item.source.provider}:${item.source.tenantKey}` ||
    item.source.channelUserId !== item.source.externalSubject ||
    (item.source.provider === 'github' && item.source.tenantKey !== item.repository) ||
    (item.source.provider === 'github' && item.github === null) ||
    (item.source.provider === 'feishu' && item.github !== null) ||
    item.identity.approverRolesDigest === '';
  if (sourceBindingInvalid) {
    context.addIssue({ code: 'custom', message: 'identity approval source binding is inconsistent' });
  }
  if (item.github !== null && item.github.pullRequestNumber <= 0) {
    context.addIssue({ code: 'custom', message: 'GitHub approval context is invalid' });
  }
  if (item.outcome === 'accepted') {
    if (
      !item.identity.separationVerified ||
      item.identity.approverPrincipal === item.identity.authorPrincipal ||
      !item.identity.approverRoles.includes('human') ||
      !item.identity.approverRoles.includes(`approve:${item.effect}`) ||
      Date.parse(item.expiresAt) <= Date.parse(item.source.occurredAt)
    ) context.addIssue({ code: 'custom', message: 'accepted identity approval is inconsistent' });
  } else {
    const selfRejection = item.rejectionReason === 'self_approval_denied' ||
      item.rejectionReason === 'task_actor_self_approval';
    if (
      item.identity.separationVerified ||
      !selfRejection ||
      item.identity.approverPrincipal !== item.identity.authorPrincipal
    ) context.addIssue({ code: 'custom', message: 'rejected identity approval is inconsistent' });
  }
});

export const IdentityApprovalEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: TimestampSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  cases: z.array(IdentityApprovalEvidenceCaseSchema).min(4).max(20),
}).strict().superRefine((manifest, context) => {
  const caseIds = manifest.cases.map((item) => item.caseId);
  const sourceIds = manifest.cases.map((item) => item.source.sourceId);
  const runIds = manifest.cases.map((item) => item.runId);
  if (
    new Set(caseIds).size !== caseIds.length ||
    new Set(sourceIds).size !== sourceIds.length ||
    new Set(runIds).size !== runIds.length ||
    manifest.cases.some((item) => item.repository !== manifest.repository) ||
    !manifest.cases.some((item) => item.outcome === 'accepted' && item.effect === 'merge') ||
    !manifest.cases.some((item) => item.outcome === 'rejected' && item.effect === 'merge') ||
    !manifest.cases.some((item) => item.outcome === 'accepted' && item.effect === 'production_deploy') ||
    !manifest.cases.some((item) => item.outcome === 'rejected' && item.effect === 'production_deploy')
  ) context.addIssue({ code: 'custom', message: 'identity approval evidence cases are incomplete' });
  for (const item of manifest.cases) {
    if (
      item.currentRunVersion < item.runVersion ||
      item.identity.approverRolesDigest === '' ||
      item.identity.approverRoles.some((role, index) =>
        index > 0 && role <= item.identity.approverRoles[index - 1]!)
    ) context.addIssue({ code: 'custom', message: 'identity approval case ordering is invalid' });
  }
});

export type IdentityApprovalEvidenceManifestV1 = z.infer<
  typeof IdentityApprovalEvidenceManifestV1Schema
>;
