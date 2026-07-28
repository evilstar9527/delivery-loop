import { z } from 'zod';
import { GitHubPullRequestMergeFactSchema } from './github-merge-status.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PRINCIPAL_PATTERN = /^(?:user|service|agent):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const EVENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true });

const SourceSchema = z.object({
  provider: z.enum(['github', 'feishu']),
  tenantKey: z.string().regex(SUBJECT_PATTERN),
  externalEventId: z.string().regex(EVENT_PATTERN),
  externalSubject: z.string().regex(SUBJECT_PATTERN),
  sourceId: z.string().regex(ID_PATTERN),
  eventDigest: z.string().regex(DIGEST_PATTERN),
  channel: z.string().regex(CHANNEL_PATTERN),
  channelUserId: z.string().regex(SUBJECT_PATTERN),
  occurredAt: TIMESTAMP_SCHEMA,
}).strict();

const IdentitySchema = z.object({
  approverPrincipal: z.string().regex(PRINCIPAL_PATTERN),
  approverRoles: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/))
    .min(1).max(100),
  approverRolesDigest: z.string().regex(DIGEST_PATTERN),
  authorPrincipal: z.string().regex(PRINCIPAL_PATTERN),
  authorLogin: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  separationVerified: z.boolean(),
}).strict();

const BindingSchema = z.object({
  approvalId: z.string().regex(ID_PATTERN),
  taskRevision: z.string().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
  planId: z.string().regex(ID_PATTERN),
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(DIGEST_PATTERN),
  baseSha: z.string().regex(SHA_PATTERN),
  mergeId: z.string().regex(ID_PATTERN),
  mergeSha: z.string().regex(SHA_PATTERN),
  environment: z.literal('production'),
  createdAt: TIMESTAMP_SCHEMA,
}).strict();

const CommonCaseSchema = z.object({
  caseId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  runVersion: z.number().int().nonnegative(),
  currentRunVersion: z.number().int().nonnegative(),
  runState: z.enum(['deploying', 'blocked']),
  repository: z.string().regex(REPOSITORY_PATTERN),
  taskRevision: z.string().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
  planId: z.string().regex(ID_PATTERN),
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(DIGEST_PATTERN),
  baseSha: z.string().regex(SHA_PATTERN),
  mergeId: z.string().regex(ID_PATTERN),
  mergeSha: z.string().regex(SHA_PATTERN),
  environment: z.literal('production'),
  source: SourceSchema,
  identity: IdentitySchema,
  mergeFact: GitHubPullRequestMergeFactSchema,
  noEffect: z.object({
    productionOutboxes: z.literal(0),
    productionDeployments: z.literal(0),
    productionAttempts: z.literal(0),
  }).strict(),
}).strict();

const AcceptedCaseSchema = CommonCaseSchema.extend({
  outcome: z.literal('accepted'),
  approvalId: z.string().regex(ID_PATTERN),
  lineageId: z.string().regex(ID_PATTERN),
  rejectionId: z.null(),
  rejectionReason: z.null(),
  expiresAt: TIMESTAMP_SCHEMA,
  binding: BindingSchema,
}).strict();

const RejectedCaseSchema = CommonCaseSchema.extend({
  outcome: z.literal('rejected'),
  approvalId: z.null(),
  lineageId: z.null(),
  rejectionId: z.string().regex(ID_PATTERN),
  rejectionReason: z.enum(['self_approval_denied', 'merge_binding_mismatch', 'approval_expired']),
  expiresAt: z.null(),
  binding: z.null(),
}).strict();

export const ProductionApprovalEvidenceCaseSchema = z.discriminatedUnion('outcome', [
  AcceptedCaseSchema,
  RejectedCaseSchema,
]).superRefine((item, context) => {
  const sourceChannel = `${item.source.provider}:${item.source.tenantKey}`;
  if (
    item.source.channel !== sourceChannel || item.source.channelUserId !== item.source.externalSubject ||
    item.repository !== item.mergeFact.repository || item.mergeSha !== item.mergeFact.mergeSha ||
    item.mergeId === item.approvalId || item.currentRunVersion !== item.runVersion ||
    item.noEffect.productionOutboxes !== 0 || item.noEffect.productionDeployments !== 0 ||
    item.noEffect.productionAttempts !== 0 || item.identity.approverRolesDigest === ''
  ) context.addIssue({ code: 'custom', message: 'production approval case binding is inconsistent' });
  if (item.outcome === 'accepted') {
    if (
      !item.identity.separationVerified ||
      item.identity.approverPrincipal === item.identity.authorPrincipal ||
      !item.identity.approverRoles.includes('human') ||
      !item.identity.approverRoles.includes('approve:production_deploy') ||
      Date.parse(item.expiresAt) <= Date.parse(item.source.occurredAt) ||
      item.binding.approvalId !== item.approvalId || item.binding.taskRevision !== item.taskRevision ||
      item.binding.planId !== item.planId || item.binding.planVersion !== item.planVersion ||
      item.binding.planDigest !== item.planDigest || item.binding.baseSha !== item.baseSha ||
      item.binding.mergeId !== item.mergeId || item.binding.mergeSha !== item.mergeSha ||
      item.binding.environment !== item.environment ||
      Date.parse(item.binding.createdAt) < Date.parse(item.source.occurredAt) ||
      Date.parse(item.binding.createdAt) < Date.parse(item.mergeFact.mergedAt)
    ) context.addIssue({ code: 'custom', message: 'accepted production approval is inconsistent' });
  } else if (item.identity.separationVerified || item.rejectionReason === 'approval_expired') {
    if (item.rejectionReason !== 'approval_expired' &&
      item.identity.approverPrincipal !== item.identity.authorPrincipal) {
      context.addIssue({ code: 'custom', message: 'rejected production approval is inconsistent' });
    }
  }
});

export const ProductionApprovalEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: TIMESTAMP_SCHEMA,
  repository: z.string().regex(REPOSITORY_PATTERN),
  cases: z.array(ProductionApprovalEvidenceCaseSchema).min(3).max(20),
}).strict().superRefine((manifest, context) => {
  const caseIds = manifest.cases.map((item) => item.caseId);
  const sourceIds = manifest.cases.map((item) => item.source.sourceId);
  const runIds = manifest.cases.map((item) => item.runId);
  if (
    new Set(caseIds).size !== caseIds.length || new Set(sourceIds).size !== sourceIds.length ||
    new Set(runIds).size !== runIds.length ||
    manifest.cases.some((item) => item.repository !== manifest.repository) ||
    !manifest.cases.some((item) => item.outcome === 'accepted') ||
    !manifest.cases.some((item) => item.outcome === 'rejected' && item.rejectionReason === 'self_approval_denied') ||
    !manifest.cases.some((item) => item.outcome === 'rejected' && item.rejectionReason === 'merge_binding_mismatch')
  ) context.addIssue({ code: 'custom', message: 'production approval evidence cases are incomplete' });
});

export type ProductionApprovalEvidenceManifestV1 = z.infer<
  typeof ProductionApprovalEvidenceManifestV1Schema
>;
