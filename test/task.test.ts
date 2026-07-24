import { describe, expect, it } from 'vitest';
import { TaskEnvelopeSchema, taskDedupeKey } from '../src/domain/task.js';

const validTask = {
  schemaVersion: '1',
  eventId: 'evt-1',
  occurredAt: '2026-07-24T10:00:00+08:00',
  source: {
    system: 'feishu',
    tenantKey: 'tenant-a',
    taskKey: 'task-42',
    revision: '7',
  },
  actor: { type: 'user', id: 'ou_123' },
  target: { owner: 'acme', repo: 'api' },
  intent: {
    kind: 'bug',
    title: '修复重复扣费',
    description: '同一回调被重复处理。',
    acceptanceCriteria: ['相同幂等键只扣费一次'],
  },
  policy: {},
} as const;

describe('TaskEnvelopeSchema', () => {
  it('fills safe defaults and produces a stable source revision key', () => {
    const task = TaskEnvelopeSchema.parse(validTask);

    expect(task.target.baseBranch).toBe('main');
    expect(task.policy.allowRepositoryWrite).toBe(false);
    expect(task.policy.requireHumanApproval).toBe(true);
    expect(taskDedupeKey(task)).toBe('feishu:tenant-a:task-42:7');
  });

  it('rejects a task without executable acceptance criteria', () => {
    const result = TaskEnvelopeSchema.safeParse({
      ...validTask,
      intent: { ...validTask.intent, acceptanceCriteria: [] },
    });

    expect(result.success).toBe(false);
  });
});

