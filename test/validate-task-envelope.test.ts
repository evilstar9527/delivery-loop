import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const TSX = resolve('node_modules/.bin/tsx');
const SCRIPT = resolve('scripts/validate-task-envelope.ts');
const CANARY = 'CANARY_INVALID_TASK_BODY_7f93b2';

const validTask = {
  schemaVersion: '1',
  eventId: 'event-1',
  occurredAt: '2026-07-27T09:30:00.000+08:00',
  source: {
    system: 'manual',
    tenantKey: 'tenant-1',
    taskKey: 'task-1',
    revision: 'revision-1',
  },
  actor: { type: 'user', id: 'user-1' },
  target: { owner: 'evilstar9527', repo: 'delivery-loop' },
  intent: {
    kind: 'requirement',
    title: 'Validate task',
    description: 'A valid task for the contract checker.',
    acceptanceCriteria: ['The checker accepts this envelope.'],
  },
  policy: {},
};

function run(taskJson: string | undefined, eventPath?: string) {
  const env = { ...process.env };
  if (taskJson === undefined) {
    delete env.DELIVERY_TASK_JSON;
  } else {
    env.DELIVERY_TASK_JSON = taskJson;
  }
  if (eventPath === undefined) {
    delete env.GITHUB_EVENT_PATH;
  } else {
    env.GITHUB_EVENT_PATH = eventPath;
  }
  return spawnSync(TSX, [SCRIPT], {
    cwd: resolve('.'),
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('validate-task-envelope log boundary', () => {
  it('accepts a valid envelope and only prints its stable dedupe key', () => {
    const result = run(JSON.stringify(validTask));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      valid: true,
      dedupeKey: 'manual:tenant-1:task-1:revision-1',
    });
  });

  it('reads workflow_dispatch input from the runner event file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'delivery-loop-validate-'));
    const eventPath = join(directory, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ inputs: { task_json: JSON.stringify(validTask) } }));
    const result = run(undefined, eventPath);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      valid: true,
      dedupeKey: 'manual:tenant-1:task-1:revision-1',
    });
  });

  it.each([
    ['invalid JSON', `{ "intent": "${CANARY}`],
    ['invalid schema', JSON.stringify({ ...validTask, intent: { description: CANARY } })],
    ['missing input', undefined],
  ])('rejects %s without echoing untrusted input', (_caseName, taskJson) => {
    const result = run(taskJson);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('TaskEnvelope validation failed\n');
    expect(`${result.stdout}${result.stderr}`).not.toContain(CANARY);
  });
});
