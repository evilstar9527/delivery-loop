import { describe, expect, it } from 'vitest';
import {
  PullRequestDraftError,
  renderPullRequestDraftBody,
  type PullRequestDraftBodyInput,
} from '../src/domain/pull-request-draft.js';

const HEAD_SHA = 'a'.repeat(40);
const BODY_INPUT: PullRequestDraftBodyInput = {
  source: {
    system: 'meegle',
    tenantKey: 'tenant-a',
    taskKey: 'task-123',
    revision: 'revision-7',
    url: 'https://tasks.example.test/item/(123)',
    title: 'Fix checkout <script>alert(1)</script> @reviewers',
  },
  repository: 'example/delivery-target',
  plan: {
    id: 'plan-pr-draft',
    version: 3,
    digest: `sha256:${'b'.repeat(64)}`,
    objective: 'Apply the smallest [safe](https://evil.example) source change.',
  },
  head: {
    branch: 'agent/task-123/attempt-456',
    sha: HEAD_SHA,
  },
  completedItems: [
    { id: 'change', title: 'Change checkout [handler](https://evil.example)' },
    { id: 'verify', title: 'Verify the fix' },
  ],
  acceptanceCriteria: [
    {
      index: 0,
      text: 'Checkout succeeds without a duplicate charge.\n<!-- hidden -->',
      status: 'passed',
      evidenceIds: ['evidence-test-1'],
    },
    {
      index: 1,
      text: 'Audit remains queryable.',
      status: 'passed',
      evidenceIds: ['evidence-test-2'],
    },
  ],
  risks: [
    'Repository write changes application behavior; review the exact diff before merge.',
  ],
  tests: [
    {
      evidenceId: 'evidence-test-1',
      commandRef: 'test:checkout',
      exitCode: 0,
      durationMs: 125,
      headSha: HEAD_SHA,
    },
    {
      evidenceId: 'evidence-test-2',
      commandRef: 'verify:all',
      exitCode: 0,
      durationMs: 480,
      headSha: HEAD_SHA,
    },
  ],
  unfinishedItems: [
    { id: 'optional-observability', title: 'Add an optional dashboard', status: 'pending' },
  ],
  rollback: `Revert bot commit ${HEAD_SHA}; no deployment is part of this Draft PR.`,
};

describe('Draft PR body renderer', () => {
  it('renders every required section deterministically and neutralizes untrusted Markdown/HTML', () => {
    const first = renderPullRequestDraftBody(BODY_INPUT);
    const second = renderPullRequestDraftBody(structuredClone(BODY_INPUT));
    expect(second).toBe(first);
    for (const heading of [
      '## Source task',
      '## Change summary',
      '## Acceptance criteria',
      '## Risks',
      '## Test evidence',
      '## Unfinished items',
      '## Rollback',
    ]) {
      expect(first).toContain(heading);
    }
    expect(first).toContain('Revision: `revision-7`');
    expect(first).toContain(`Head: \`${HEAD_SHA}\``);
    expect(first).toContain('- [x] AC 1:');
    expect(first).toContain('`test:checkout` — exit `0`, `125 ms`');
    expect(first).toContain('optional-observability');
    expect(first).toContain('Revert bot commit');
    expect(first).not.toContain('<script>');
    expect(first).not.toContain('<!--');
    expect(first).not.toContain('@reviewers');
    expect(first).not.toContain('[safe](https://evil.example)');
    expect(first).toContain('/item/%28123%29');
    expect(first).toContain('&#64;reviewers');
    expect(new TextEncoder().encode(first).length).toBeLessThanOrEqual(65_536);
  });

  it('rejects credential material and malformed/oversized snapshots before publication', () => {
    const secret = 'CANARY_PR_DRAFT_REGISTERED_SECRET';
    expect(() => renderPullRequestDraftBody({
      ...BODY_INPUT,
      risks: [`A copied log says ${secret}`],
    }, { secrets: [secret] })).toThrow(expect.objectContaining({
      name: PullRequestDraftError.name,
      code: 'secret_detected',
    }));
    expect(() => renderPullRequestDraftBody({
      ...BODY_INPUT,
      source: { ...BODY_INPUT.source, title: 'x'.repeat(10_001) },
    })).toThrow(expect.objectContaining({
      name: PullRequestDraftError.name,
      code: 'invalid_input',
    }));
  });
});
