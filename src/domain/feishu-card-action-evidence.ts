import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;

const IdSchema = z.string().regex(ID_PATTERN);
const DigestSchema = z.string().regex(DIGEST_PATTERN);
const TimestampSchema = z.iso.datetime({ offset: true });

const SafeEvidenceUrlSchema = z.string().min(1).max(2_048).superRefine((raw, context) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    context.addIssue({ code: 'custom', message: 'evidence URL is invalid' });
    return;
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.hash !== ''
  ) context.addIssue({ code: 'custom', message: 'evidence URL is unsafe' });
});

export const FeishuCardActionSuccessScenarioSchema = z.enum([
  'approve',
  'reject',
  'cancel',
  'retry',
  'replay',
  'add_context',
]);

export const FeishuCardActionRejectionScenarioSchema = z.enum([
  'duplicate_nonce',
  'tampered_value',
  'forwarded_message',
  'stale_card',
  'stale_task_revision',
  'stale_plan_version',
  'stale_plan_digest',
  'stale_base_sha',
  'wrong_chat',
  'role_revoked',
  'unauthorized_account',
  'secret_add_context',
]);

const ApprovalEffectSchema = z.enum([
  'repo_write',
  'test_deploy',
  'merge',
  'production_deploy',
]);

const ActionEffectSchema = z.enum([
  'repo_write',
  'test_deploy',
  'merge',
  'production_deploy',
  'cancel_run',
  'retry_run',
  'replay_run',
  'add_context',
]);

const ResultKindSchema = z.enum([
  'approval',
  'cancellation',
  'recovery_attempt',
  'workflow_replay',
  'task_revision',
]);

const SuccessObservationBaseSchema = z.object({
  scenario: FeishuCardActionSuccessScenarioSchema,
  outcome: z.literal('applied'),
  eventId: IdSchema,
  deliveryId: IdSchema,
  requestDigest: DigestSchema,
  responseDigest: DigestSchema,
  statusCode: z.literal(200),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  latencyMs: z.number().int().nonnegative().max(60_000),
  operatorDigest: DigestSchema,
  actionReceiptId: IdSchema,
  command: FeishuCardActionSuccessScenarioSchema,
  effect: ActionEffectSchema,
  resultKind: ResultKindSchema,
  resultId: IdSchema,
}).strict();

const SuccessObservationSchema = SuccessObservationBaseSchema.superRefine((item, context) => {
  const expected = {
    approve: { resultKind: 'approval', effects: ApprovalEffectSchema.options },
    reject: { resultKind: 'approval', effects: ApprovalEffectSchema.options },
    cancel: { resultKind: 'cancellation', effects: ['cancel_run'] },
    retry: { resultKind: 'recovery_attempt', effects: ['retry_run'] },
    replay: { resultKind: 'workflow_replay', effects: ['replay_run'] },
    add_context: { resultKind: 'task_revision', effects: ['add_context'] },
  } as const;
  const shape = expected[item.scenario];
  if (
    item.command !== item.scenario || item.resultKind !== shape.resultKind ||
    !(shape.effects as readonly string[]).includes(item.effect) ||
    Date.parse(item.completedAt) - Date.parse(item.startedAt) !== item.latencyMs
  ) context.addIssue({ code: 'custom', message: 'success observation is inconsistent' });
});

const RejectionReasonSchema = z.enum([
  'invalid_request',
  'binding_conflict',
  'identity_unresolved',
  'actor_not_authorized',
  'replay_rejected',
  'secret_detected',
]);

const RejectionObservationBaseSchema = z.object({
  scenario: FeishuCardActionRejectionScenarioSchema,
  outcome: z.literal('rejected'),
  eventId: IdSchema,
  deliveryId: IdSchema,
  requestDigest: DigestSchema,
  responseDigest: DigestSchema,
  statusCode: z.union([z.literal(400), z.literal(403), z.literal(409)]),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  latencyMs: z.number().int().nonnegative().max(60_000),
  operatorDigest: DigestSchema.nullable(),
  reasonCode: RejectionReasonSchema,
  attemptedCommand: FeishuCardActionSuccessScenarioSchema.optional(),
  attemptedEffect: ActionEffectSchema.optional(),
}).strict();

const RejectionObservationSchema = RejectionObservationBaseSchema.superRefine((item, context) => {
  const expected: Record<z.infer<typeof FeishuCardActionRejectionScenarioSchema>, {
    statusCode: 400 | 403 | 409;
    reasons: readonly z.infer<typeof RejectionReasonSchema>[];
  }> = {
    duplicate_nonce: { statusCode: 409, reasons: ['replay_rejected'] },
    tampered_value: { statusCode: 400, reasons: ['invalid_request'] },
    forwarded_message: { statusCode: 403, reasons: ['binding_conflict'] },
    stale_card: { statusCode: 403, reasons: ['binding_conflict'] },
    stale_task_revision: { statusCode: 403, reasons: ['binding_conflict'] },
    stale_plan_version: { statusCode: 403, reasons: ['binding_conflict'] },
    stale_plan_digest: { statusCode: 403, reasons: ['binding_conflict'] },
    stale_base_sha: { statusCode: 403, reasons: ['binding_conflict'] },
    wrong_chat: { statusCode: 403, reasons: ['binding_conflict'] },
    role_revoked: { statusCode: 403, reasons: ['actor_not_authorized'] },
    unauthorized_account: { statusCode: 403, reasons: ['identity_unresolved'] },
    secret_add_context: { statusCode: 403, reasons: ['secret_detected'] },
  };
  const shape = expected[item.scenario];
  const isUnauthorizedRepositoryWrite =
    item.scenario === 'role_revoked' || item.scenario === 'unauthorized_account';
  if (
    item.statusCode !== shape.statusCode || !shape.reasons.includes(item.reasonCode) ||
    Date.parse(item.completedAt) - Date.parse(item.startedAt) !== item.latencyMs ||
    (isUnauthorizedRepositoryWrite &&
      (item.attemptedCommand !== 'approve' || item.attemptedEffect !== 'repo_write')) ||
    (!isUnauthorizedRepositoryWrite &&
      (item.attemptedCommand !== undefined || item.attemptedEffect !== undefined))
  ) context.addIssue({ code: 'custom', message: 'rejection observation is inconsistent' });
});

export const FeishuCardActionObservabilityReportV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  service: z.literal('delivery-loop-feishu-action-observer'),
  callbackUrl: SafeEvidenceUrlSchema,
  generatedAt: TimestampSchema,
  requests: z.array(z.union([
    SuccessObservationSchema,
    RejectionObservationSchema,
  ])).length(18),
  reportDigest: DigestSchema,
}).strict().superRefine((report, context) => {
  const scenarios = report.requests.map((item) => item.scenario);
  const expected = [
    ...FeishuCardActionSuccessScenarioSchema.options,
    ...FeishuCardActionRejectionScenarioSchema.options,
  ];
  if (
    new Set(scenarios).size !== expected.length ||
    expected.some((scenario) => !scenarios.includes(scenario)) ||
    new Set(report.requests.map((item) => item.eventId)).size !== report.requests.length ||
    new Set(report.requests.map((item) => item.deliveryId)).size !== report.requests.length ||
    new Set(report.requests.map((item) => item.requestDigest)).size !== report.requests.length ||
    report.requests.some((item) => Date.parse(item.completedAt) > Date.parse(report.generatedAt))
  ) context.addIssue({ code: 'custom', message: 'action observation inventory is incomplete' });
});

const SuccessCaseSchema = SuccessObservationBaseSchema.omit({
  outcome: true,
  completedAt: true,
  latencyMs: true,
}).extend({
  actorKey: IdSchema,
  eventDigest: DigestSchema,
  commandDigest: DigestSchema,
  cardId: IdSchema,
  presentationId: IdSchema,
  messageId: z.string().regex(MESSAGE_ID_PATTERN),
  taskId: IdSchema,
  runId: IdSchema,
  runVersion: z.number().int().nonnegative(),
  taskRevisionDigest: DigestSchema,
  planId: IdSchema,
  planVersion: z.number().int().positive(),
  planDigest: DigestSchema,
  baseSha: z.string().regex(SHA_PATTERN),
  actionId: IdSchema,
  contextMode: z.enum(['new_run', 'apply_current']).nullable(),
}).strict().superRefine((item, context) => {
  const expected = {
    approve: { resultKind: 'approval', effects: ApprovalEffectSchema.options },
    reject: { resultKind: 'approval', effects: ApprovalEffectSchema.options },
    cancel: { resultKind: 'cancellation', effects: ['cancel_run'] },
    retry: { resultKind: 'recovery_attempt', effects: ['retry_run'] },
    replay: { resultKind: 'workflow_replay', effects: ['replay_run'] },
    add_context: { resultKind: 'task_revision', effects: ['add_context'] },
  } as const;
  const shape = expected[item.scenario];
  if (
    item.command !== item.scenario || item.resultKind !== shape.resultKind ||
    !(shape.effects as readonly string[]).includes(item.effect) ||
    (item.command === 'add_context') !== (item.contextMode !== null)
  ) context.addIssue({ code: 'custom', message: 'success case is inconsistent' });
});

const RejectionCaseSchema = RejectionObservationBaseSchema.omit({
  outcome: true,
  completedAt: true,
  latencyMs: true,
}).extend({
  actorKey: IdSchema,
  eventDigest: DigestSchema,
  sourceSuccessEventId: IdSchema.nullable(),
}).strict().superRefine((item, context) => {
  const expected = {
    duplicate_nonce: { statusCode: 409, reasonCode: 'replay_rejected' },
    tampered_value: { statusCode: 400, reasonCode: 'invalid_request' },
    forwarded_message: { statusCode: 403, reasonCode: 'binding_conflict' },
    stale_card: { statusCode: 403, reasonCode: 'binding_conflict' },
    stale_task_revision: { statusCode: 403, reasonCode: 'binding_conflict' },
    stale_plan_version: { statusCode: 403, reasonCode: 'binding_conflict' },
    stale_plan_digest: { statusCode: 403, reasonCode: 'binding_conflict' },
    stale_base_sha: { statusCode: 403, reasonCode: 'binding_conflict' },
    wrong_chat: { statusCode: 403, reasonCode: 'binding_conflict' },
    role_revoked: { statusCode: 403, reasonCode: 'actor_not_authorized' },
    unauthorized_account: { statusCode: 403, reasonCode: 'identity_unresolved' },
    secret_add_context: { statusCode: 403, reasonCode: 'secret_detected' },
  } as const;
  const shape = expected[item.scenario];
  const isUnauthorizedRepositoryWrite =
    item.scenario === 'role_revoked' || item.scenario === 'unauthorized_account';
  if (
    item.statusCode !== shape.statusCode || item.reasonCode !== shape.reasonCode ||
    (isUnauthorizedRepositoryWrite &&
      (item.attemptedCommand !== 'approve' || item.attemptedEffect !== 'repo_write')) ||
    (!isUnauthorizedRepositoryWrite &&
      (item.attemptedCommand !== undefined || item.attemptedEffect !== undefined))
  ) {
    context.addIssue({ code: 'custom', message: 'rejection case is inconsistent' });
  }
});

const ActorReviewSchema = z.object({
  actorKey: IdSchema,
  openIdDigest: DigestSchema,
  principalDigest: DigestSchema.nullable(),
  rolesDigest: DigestSchema.nullable(),
  mappingStatus: z.enum(['mapped_human', 'revoked', 'unmapped']),
  reviewedAt: TimestampSchema,
}).strict().superRefine((actor, context) => {
  if (
    (actor.mappingStatus === 'mapped_human' &&
      (actor.principalDigest === null || actor.rolesDigest === null)) ||
    (actor.mappingStatus !== 'mapped_human' && actor.rolesDigest !== null) ||
    (actor.mappingStatus === 'unmapped' && actor.principalDigest !== null)
  ) context.addIssue({ code: 'custom', message: 'actor review is inconsistent' });
});

export const FeishuCardActionEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  recordedAt: TimestampSchema,
  application: z.object({
    appId: z.string().regex(TARGET_ID_PATTERN),
    tenantKey: z.string().regex(TARGET_ID_PATTERN),
    chatId: z.string().regex(TARGET_ID_PATTERN),
    callbackUrl: SafeEvidenceUrlSchema,
  }).strict(),
  observabilityReportUrl: SafeEvidenceUrlSchema,
  observabilityReportDigest: DigestSchema,
  successes: z.array(SuccessCaseSchema).length(6),
  rejections: z.array(RejectionCaseSchema).length(12),
  actors: z.array(ActorReviewSchema).min(3).max(20),
  safety: z.object({
    canaryDigest: DigestSchema,
  }).strict(),
  review: z.object({
    developerConsoleUrl: SafeEvidenceUrlSchema,
    permissionUrl: SafeEvidenceUrlSchema,
    chatUrl: SafeEvidenceUrlSchema,
    mappingEvidenceUrl: SafeEvidenceUrlSchema,
    screenshotBundleUrl: SafeEvidenceUrlSchema,
    reviewer: IdSchema,
    reviewedAt: TimestampSchema,
    eventSubscription: z.literal('active'),
    botMembership: z.literal('member'),
    scopes: z.array(z.enum([
      'im:message',
      'im:message:readonly',
      'im:message.group_msg',
      'im:message:send_as_bot',
      'im:message:update',
    ])).min(4).max(5).refine((items) => new Set(items).size === items.length),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const successScenarios = manifest.successes.map((item) => item.scenario);
  const rejectionScenarios = manifest.rejections.map((item) => item.scenario);
  const actors = new Map(manifest.actors.map((actor) => [actor.actorKey, actor]));
  const successActorKeys = new Set(manifest.successes.map((item) => item.actorKey));
  const successPrincipalDigests = new Set(
    [...successActorKeys].map((key) => actors.get(key)?.principalDigest),
  );
  const unauthorized = manifest.rejections.find((item) => item.scenario === 'unauthorized_account');
  const revoked = manifest.rejections.find((item) => item.scenario === 'role_revoked');
  const duplicate = manifest.rejections.find((item) => item.scenario === 'duplicate_nonce');
  const all = [...manifest.successes, ...manifest.rejections];
  if (
    new Set(successScenarios).size !== FeishuCardActionSuccessScenarioSchema.options.length ||
    FeishuCardActionSuccessScenarioSchema.options.some((item) => !successScenarios.includes(item)) ||
    new Set(rejectionScenarios).size !== FeishuCardActionRejectionScenarioSchema.options.length ||
    FeishuCardActionRejectionScenarioSchema.options.some((item) => !rejectionScenarios.includes(item)) ||
    successActorKeys.size < 2 || successPrincipalDigests.size < 2 ||
    [...successActorKeys].some((key) => actors.get(key)?.mappingStatus !== 'mapped_human') ||
    unauthorized === undefined || actors.get(unauthorized.actorKey)?.mappingStatus !== 'unmapped' ||
    revoked === undefined || actors.get(revoked.actorKey)?.mappingStatus !== 'revoked' ||
    duplicate?.sourceSuccessEventId === null ||
    duplicate === undefined ||
    !manifest.successes.some((item) => item.eventId === duplicate.sourceSuccessEventId) ||
    manifest.rejections.some((item) =>
      item.scenario !== 'duplicate_nonce' && item.sourceSuccessEventId !== null) ||
    new Set(all.map((item) => item.eventId)).size !== all.length ||
    new Set(all.map((item) => item.deliveryId)).size !== all.length ||
    new Set(all.map((item) => item.requestDigest)).size !== all.length ||
    all.some((item) => actors.get(item.actorKey)?.openIdDigest !== item.operatorDigest) ||
    all.some((item) => Date.parse(item.startedAt) > Date.parse(manifest.recordedAt)) ||
    manifest.actors.some((item) => Date.parse(item.reviewedAt) > Date.parse(manifest.recordedAt)) ||
    Date.parse(manifest.review.reviewedAt) > Date.parse(manifest.recordedAt)
  ) context.addIssue({ code: 'custom', message: 'Feishu action evidence is inconsistent' });

  const scopes = new Set(manifest.review.scopes);
  if (
    !scopes.has('im:message:send_as_bot') || !scopes.has('im:message:update') ||
    !scopes.has('im:message.group_msg') ||
    (!scopes.has('im:message') && !scopes.has('im:message:readonly'))
  ) context.addIssue({ code: 'custom', message: 'required Feishu scopes are incomplete' });
});

export type FeishuCardActionEvidenceManifestV1 = z.infer<
  typeof FeishuCardActionEvidenceManifestV1Schema
>;
export type FeishuCardActionObservabilityReportV1 = z.infer<
  typeof FeishuCardActionObservabilityReportV1Schema
>;
export type FeishuCardActionSuccessScenario = z.infer<
  typeof FeishuCardActionSuccessScenarioSchema
>;
export type FeishuCardActionRejectionScenario = z.infer<
  typeof FeishuCardActionRejectionScenarioSchema
>;
