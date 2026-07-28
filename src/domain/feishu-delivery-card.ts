/**
 * Feishu interactive-card encoding derived from Watt
 * packages/plugin-feishu/src/adapter/encode.ts@476e3cd.
 *
 * Delivery Loop narrows Watt's generic message model to immutable,
 * evidence-backed projections. No task/PR body, raw log, runner output, R2
 * reference, upstream response, or free-form error is accepted by the schema.
 */

import { z } from 'zod';
import {
  FeishuCardActionCommandSchema,
  type FeishuCardActionCommand,
} from './feishu-card-action.js';
import {
  ATTEMPTED_PATHS,
  ATTEMPTED_PATH_LABELS,
  HUMAN_INPUT_CODES,
  HUMAN_INPUT_PROMPTS,
} from './attempt-failure.js';
import { RUN_STATES } from './run.js';

export type PullRequestCardStatus = 'not_started' | 'publishing' | 'open';
export type MergeCardStatus = 'waiting' | 'ready' | 'merged';
export type DeploymentCardStatus =
  | 'not_started'
  | 'scheduled'
  | 'verifying'
  | 'in_progress'
  | 'succeeded'
  | 'failed';

export interface FeishuDeliveryCardSection<Status extends string> {
  status: Status;
  url: string | null;
}

const PullRequestCardStatusSchema = z.enum(['not_started', 'publishing', 'open']);
const MergeCardStatusSchema = z.enum(['waiting', 'ready', 'merged']);
const DeploymentCardStatusSchema = z.enum([
  'not_started',
  'scheduled',
  'verifying',
  'in_progress',
  'succeeded',
  'failed',
]);

/** Keeps untrusted external URLs from breaking out of a Lark Markdown link. */
export function safeFeishuDeliveryUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.length < 1 || raw.length > 2_048) return null;
  if (/\s|[()<>\\]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) return null;
  return url.toString();
}

const SafeUrlSchema = z.string().max(2_048).refine(
  (value) => safeFeishuDeliveryUrl(value) !== null,
  'card URL must be safe HTTPS',
).nullable();

const CardSectionSchemas = {
  pr: z.object({ status: PullRequestCardStatusSchema, url: SafeUrlSchema }).strict(),
  merge: z.object({ status: MergeCardStatusSchema, url: SafeUrlSchema }).strict(),
  deployment: z.object({ status: DeploymentCardStatusSchema, url: SafeUrlSchema }).strict(),
} as const;

export const FeishuDeliveryCardPresentationV1Schema = z.object({
  schemaVersion: z.literal('1'),
  cardId: z.string().min(1).max(200),
  presentationId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  runVersion: z.number().int().nonnegative(),
  pr: CardSectionSchemas.pr,
  merge: CardSectionSchemas.merge,
  testDeploy: CardSectionSchemas.deployment,
  productionDeploy: CardSectionSchemas.deployment,
}).strict();

export type FeishuDeliveryCardPresentationV1 = z.infer<
  typeof FeishuDeliveryCardPresentationV1Schema
>;

const CardSummarySchema = z.string().min(1).max(240).refine(
  (value) => !/[\0\r\n]/.test(value),
  'card summary must be one line',
);

const CardProgressSchema = z.object({
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  requiredPassed: z.number().int().nonnegative(),
  requiredTotal: z.number().int().nonnegative(),
  inProgress: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
}).strict().superRefine((progress, context) => {
  if (
    progress.passed > progress.total ||
    progress.requiredPassed > progress.requiredTotal ||
    progress.requiredPassed > progress.passed ||
    progress.requiredTotal > progress.total ||
    progress.passed + progress.inProgress + progress.failed + progress.blocked > progress.total
  ) {
    context.addIssue({ code: 'custom', message: 'card progress counts are inconsistent' });
  }
});

const CardBlockerSchema = z.object({
  reason: z.enum(['repeated_fingerprint', 'attempt_limit']),
  attemptCount: z.number().int().positive(),
  attemptedPaths: z.array(z.enum(ATTEMPTED_PATHS)).max(ATTEMPTED_PATHS.length)
    .refine((paths) => new Set(paths).size === paths.length, 'attempted paths must be unique'),
  neededHumanInput: z.enum(HUMAN_INPUT_CODES),
}).strict();

const ApprovalEffectSchema = z.enum([
  'repo_write',
  'test_deploy',
  'merge',
  'production_deploy',
]);

const ApprovedEffectSchema = z.object({
  effect: ApprovalEffectSchema,
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();

export const FeishuDeliveryCardPresentationV2Schema = z.object({
  schemaVersion: z.literal('2'),
  cardId: z.string().min(1).max(200),
  presentationId: z.string().min(1).max(200),
  /** Server-generated operations repair epoch; never rendered as card content. */
  refreshRequestId: z.string().min(1).max(200).optional(),
  runId: z.string().min(1).max(200),
  runVersion: z.number().int().nonnegative(),
  runState: z.enum(RUN_STATES),
  taskRevision: CardSummarySchema,
  targetRepository: CardSummarySchema,
  baseSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  planVersion: z.number().int().positive().nullable(),
  planDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  progress: CardProgressSchema,
  currentGoal: CardSummarySchema,
  actionUrl: SafeUrlSchema,
  checkUrl: SafeUrlSchema,
  checkpointSummary: CardSummarySchema.nullable(),
  evidenceSummary: CardSummarySchema.nullable(),
  evidenceUrl: SafeUrlSchema,
  blocker: CardBlockerSchema.nullable(),
  approvedEffects: z.array(ApprovedEffectSchema).max(4).refine(
    (effects) => new Set(effects.map((effect) => effect.effect)).size === effects.length,
    'approved effects must be unique',
  ),
  actions: z.array(FeishuCardActionCommandSchema).max(16).superRefine((actions, context) => {
    if (
      new Set(actions.map((action) => action.actionId)).size !== actions.length ||
      new Set(actions.map((action) => action.nonce)).size !== actions.length
    ) context.addIssue({ code: 'custom', message: 'card actions must be unique' });
  }).optional(),
  pr: CardSectionSchemas.pr,
  merge: CardSectionSchemas.merge,
  testDeploy: CardSectionSchemas.deployment,
  productionDeploy: CardSectionSchemas.deployment,
}).strict().superRefine((presentation, context) => {
  if ((presentation.planVersion === null) !== (presentation.planDigest === null)) {
    context.addIssue({
      code: 'custom',
      path: ['planVersion'],
      message: 'plan version and digest must be present together',
    });
  }
});

export type FeishuDeliveryCardPresentationV2 = z.infer<
  typeof FeishuDeliveryCardPresentationV2Schema
>;

export const FeishuDeliveryCardPresentationSchema = z.discriminatedUnion('schemaVersion', [
  FeishuDeliveryCardPresentationV1Schema,
  FeishuDeliveryCardPresentationV2Schema,
]);

export type FeishuDeliveryCardPresentation = z.infer<
  typeof FeishuDeliveryCardPresentationSchema
>;

export interface FeishuDeliveryCardJson {
  config: { wide_screen_mode: true; update_multi: true };
  header: {
    template: 'blue';
    title: { tag: 'plain_text'; content: 'Delivery Loop 交付状态' };
  };
  elements: Array<
    | { tag: 'div'; text: { tag: 'lark_md'; content: string } }
    | {
        tag: 'input';
        name: 'delivery_loop_context';
        placeholder: { tag: 'plain_text'; content: string };
      }
    | {
        tag: 'action';
        actions: Array<{
          tag: 'button';
          text: { tag: 'plain_text'; content: string };
          type: 'default';
          value: { id: string; signal: FeishuCardActionCommand };
        }>;
      }
  >;
}

const STATUS_LABELS = {
  pr: {
    not_started: '未创建',
    publishing: '发布中',
    open: '已创建',
  },
  merge: {
    waiting: '等待合并条件',
    ready: '可以合并',
    merged: '已合并',
  },
  deployment: {
    not_started: '未开始',
    scheduled: '已调度',
    verifying: '等待外部核验',
    in_progress: '进行中',
    succeeded: '成功',
    failed: '失败',
  },
  run: {
    received: '已接收',
    triaging: '分诊中',
    awaiting_approval: '等待批准',
    queued: '已排队',
    planning: '规划中',
    executing: '执行中',
    verifying: '验证中',
    pull_request_open: 'PR 已打开',
    awaiting_review: '等待评审',
    ready_to_merge: '可以合并',
    merging: '合并中',
    deploying: '部署中',
    succeeded: '成功',
    blocked: '阻塞',
    failed: '失败',
    cancelled: '已取消',
  },
} as const;

function escapeLarkMarkdown(raw: string): string {
  return raw.replaceAll(/([\\`*_{}[\]()<>#~])/g, '\\$1');
}

function div(content: string): FeishuDeliveryCardJson['elements'][number] {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

const ACTION_LABELS: Record<FeishuCardActionCommand['command'], string> = {
  approve: '批准',
  reject: '拒绝',
  cancel: '取消 Run',
  retry: '重试',
  replay: '回放',
  add_context: '补充上下文',
};

/** Button encoding copied directly from Watt encode.ts@476e3cd. */
function renderCardActions(
  actions: readonly FeishuCardActionCommand[],
): FeishuDeliveryCardJson['elements'] {
  if (actions.length === 0) return [];
  const elements: FeishuDeliveryCardJson['elements'] = [];
  if (actions.some((action) => action.command === 'add_context')) {
    elements.push({
      tag: 'input',
      name: 'delivery_loop_context',
      placeholder: { tag: 'plain_text', content: '补充上下文（仅补充操作读取）' },
    });
  }
  elements.push({
    tag: 'action',
    actions: actions.map((action) => ({
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: action.command === 'approve' || action.command === 'reject'
          ? `${ACTION_LABELS[action.command]} ${action.effect}`
          : action.command === 'add_context'
            ? `${ACTION_LABELS[action.command]}·${action.contextMode === 'new_run' ? '新 Run' : '当前 Run'}`
            : ACTION_LABELS[action.command],
      },
      type: 'default',
      value: { id: action.actionId, signal: action },
    })),
  });
  return elements;
}

function link(label: string, rawUrl: string | null): string {
  const url = safeFeishuDeliveryUrl(rawUrl);
  return url === null ? '' : ` · [${label}](${url})`;
}

function section(title: string, label: string, rawUrl: string | null) {
  return div(`**${title}**\n${escapeLarkMarkdown(label)}${link('查看', rawUrl)}`);
}

function renderDeliverySections(presentation: Pick<
  FeishuDeliveryCardPresentation,
  'pr' | 'merge' | 'testDeploy' | 'productionDeploy'
>): FeishuDeliveryCardJson['elements'] {
  return [
    section('PR', STATUS_LABELS.pr[presentation.pr.status], presentation.pr.url),
    section('Merge', STATUS_LABELS.merge[presentation.merge.status], presentation.merge.url),
    section(
      'Test Deploy',
      STATUS_LABELS.deployment[presentation.testDeploy.status],
      presentation.testDeploy.url,
    ),
    section(
      'Production Deploy',
      STATUS_LABELS.deployment[presentation.productionDeploy.status],
      presentation.productionDeploy.url,
    ),
  ];
}

function renderV2(presentation: FeishuDeliveryCardPresentationV2): FeishuDeliveryCardJson['elements'] {
  const plan = presentation.planVersion === null
    ? '尚未生成'
    : `v${presentation.planVersion} · ${presentation.planDigest!}`;
  const progress = presentation.progress;
  const runtimeLinks = [
    link('Action', presentation.actionUrl),
    link('Check', presentation.checkUrl),
  ].filter(Boolean).join('');
  const checkpoint = presentation.checkpointSummary === null
    ? '暂无安全 checkpoint 摘要'
    : escapeLarkMarkdown(presentation.checkpointSummary);
  const evidence = presentation.evidenceSummary === null
    ? '暂无已核验证据摘要'
    : escapeLarkMarkdown(presentation.evidenceSummary);
  const blocker = presentation.blocker === null
    ? '无 active blocker'
    : [
        `原因：${presentation.blocker.reason}`,
        `尝试：${presentation.blocker.attemptCount}`,
        ...presentation.blocker.attemptedPaths.map(
          (path) => escapeLarkMarkdown(ATTEMPTED_PATH_LABELS[path]),
        ),
        escapeLarkMarkdown(HUMAN_INPUT_PROMPTS[presentation.blocker.neededHumanInput]),
      ].join(' · ');
  const approvals = presentation.approvedEffects.length === 0
    ? '无有效 effect 批准'
    : presentation.approvedEffects.map(
        (approval) => `${approval.effect}（至 ${approval.expiresAt}）`,
      ).join(' · ');

  return [
    div(
      `**当前状态**\n${STATUS_LABELS.run[presentation.runState]} ` +
      `(${presentation.runState}) · Run v${presentation.runVersion}`,
    ),
    div(
      `**任务快照**\nrevision: ${escapeLarkMarkdown(presentation.taskRevision)} · ` +
      `repo: ${escapeLarkMarkdown(presentation.targetRepository)}` +
      (presentation.baseSha === null ? '' : ` · base: ${presentation.baseSha}`),
    ),
    div(`**ExecutionPlan**\n${plan}`),
    div(
      `**DoD Item 进度**\n${progress.passed}/${progress.total} · ` +
      `required ${progress.requiredPassed}/${progress.requiredTotal} · ` +
      `in_progress ${progress.inProgress} · failed ${progress.failed} · blocked ${progress.blocked}`,
    ),
    div(`**本轮目标（不可信数据）**\n数据：${escapeLarkMarkdown(presentation.currentGoal)}`),
    div(`**Action / Check**\n${runtimeLinks.length === 0 ? '暂无已核验链接' : runtimeLinks}`),
    div(`**最近 checkpoint**\n摘要：${checkpoint}`),
    div(`**最近已核验证据**\n摘要：${evidence}${link('受控详情', presentation.evidenceUrl)}`),
    div(`**Blocker**\n${blocker}`),
    div(`**已批准 effects**\n${approvals}`),
    ...renderDeliverySections(presentation),
    ...renderCardActions(presentation.actions ?? []),
  ];
}

/**
 * Returns classic interactive-card JSON accepted by create and message-card
 * PATCH. `update_multi` is mandatory on both versions.
 */
export function renderFeishuDeliveryCard(
  rawPresentation: FeishuDeliveryCardPresentation,
): FeishuDeliveryCardJson {
  const presentation = FeishuDeliveryCardPresentationSchema.parse(rawPresentation);
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Delivery Loop 交付状态' },
    },
    elements: presentation.schemaVersion === '1'
      ? renderDeliverySections(presentation)
      : renderV2(presentation),
  };
}
