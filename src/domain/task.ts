import { z } from 'zod';

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
  }),
  actor: z.object({
    type: z.enum(['user', 'bot', 'system']),
    id: z.string().min(1),
    displayName: z.string().min(1).optional(),
  }),
  target: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    baseBranch: z.string().min(1).default('main'),
    environment: z.enum(['none', 'test', 'production']).default('test'),
  }),
  intent: z.object({
    kind: TaskKindSchema,
    title: z.string().min(1).max(200),
    description: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    priority: TaskPrioritySchema.default('p2'),
  }),
  policy: z.object({
    allowRepositoryWrite: z.boolean().default(false),
    allowTestDeploy: z.boolean().default(false),
    allowProductionDeploy: z.boolean().default(false),
    requireHumanApproval: z.boolean().default(true),
  }),
});

export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;

export function taskDedupeKey(task: TaskEnvelope): string {
  return [
    task.source.system,
    task.source.tenantKey,
    task.source.taskKey,
    task.source.revision,
  ].join(':');
}
