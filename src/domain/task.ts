import { z } from 'zod';
import { canonicalSha256 } from './digest.js';

export const TaskSourceSystemSchema = z.enum([
  'feishu',
  'meego',
  'github',
  'monitor',
  'manual',
]);

export const TaskKindSchema = z.enum(['requirement', 'bug']);

export const TaskPrioritySchema = z.enum(['p0', 'p1', 'p2', 'p3']);

export const TaskEnvelopeSchema = z.object({
  schemaVersion: z.literal('1'),
  eventId: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
  source: z.object({
    system: TaskSourceSystemSchema,
    tenantKey: z.string().min(1),
    taskKey: z.string().min(1),
    revision: z.string().min(1),
    url: z.url().optional(),
  }).strict(),
  actor: z.object({
    type: z.enum(['user', 'bot', 'system']),
    id: z.string().min(1),
    displayName: z.string().min(1).optional(),
  }).strict(),
  coordination: z.object({
    owner: z.object({
      id: z.string().min(1),
      displayName: z.string().min(1).optional(),
    }).strict(),
  }).strict().optional(),
  target: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    baseBranch: z.string().min(1).default('main'),
    environment: z.enum(['none', 'test', 'production']).default('test'),
  }).strict(),
  intent: z.object({
    kind: TaskKindSchema,
    title: z.string().min(1).max(200),
    description: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    priority: TaskPrioritySchema.default('p2'),
  }).strict(),
  policy: z.object({
    allowRepositoryWrite: z.boolean().default(false),
    allowTestDeploy: z.boolean().default(false),
    allowProductionDeploy: z.boolean().default(false),
    requireHumanApproval: z.boolean().default(true),
  }).strict(),
}).strict();

export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;

export function taskDedupeKey(task: TaskEnvelope): string {
  return [
    task.source.system,
    task.source.tenantKey,
    task.source.taskKey,
    task.source.revision,
  ].join(':');
}

function taskRevisionIdentity(task: TaskEnvelope): {
  system: TaskEnvelope['source']['system'];
  tenantKey: string;
  taskKey: string;
  revision: string;
} {
  return {
    system: task.source.system,
    tenantKey: task.source.tenantKey,
    taskKey: task.source.taskKey,
    revision: task.source.revision,
  };
}

/** Platform delivery metadata is excluded so event retries do not mutate business identity. */
function taskRevisionSnapshot(task: TaskEnvelope): Omit<
  TaskEnvelope,
  'eventId' | 'occurredAt'
> {
  return {
    schemaVersion: task.schemaVersion,
    source: task.source,
    actor: task.actor,
    target: task.target,
    intent: task.intent,
    policy: task.policy,
  };
}

export async function taskRevisionDigest(task: TaskEnvelope): Promise<string> {
  return await canonicalSha256(taskRevisionSnapshot(task));
}

export interface TaskRevisionIds {
  taskId: string;
  runId: string;
  workflowCreateOutboxId: string;
}

export async function taskRevisionIds(task: TaskEnvelope): Promise<TaskRevisionIds> {
  const identityDigest = await canonicalSha256(taskRevisionIdentity(task));
  const suffix = identityDigest.slice('sha256:'.length, 'sha256:'.length + 56);
  return {
    taskId: `task_${suffix}`,
    runId: `run_${suffix}`,
    workflowCreateOutboxId: `outbox_workflow_${suffix}`,
  };
}
