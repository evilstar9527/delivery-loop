import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CodexReviewAdapter,
  CodexReviewAdapterError,
} from '../src/agent/codex-review-adapter.js';
import {
  AUTOMATED_REVIEW_RESULT_V1_JSON_SCHEMA,
  AutomatedReviewContextV1Schema,
  automatedReviewContextDigest,
} from '../src/domain/automated-review.js';
import type { CommandExecutionRequest } from '../src/agent/command-runtime.js';

const HEAD_SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

function context() {
  return AutomatedReviewContextV1Schema.parse({
    schemaVersion: '1',
    kind: 'automated_review',
    attempt: {
      id: 'attempt-review',
      runId: 'run-review',
      mode: 'analysis',
      version: 1,
      leaseGeneration: 1,
      baseSha: HEAD_SHA,
    },
    review: {
      id: 'review-1',
      iteration: 1,
      publicationId: 'publication-1',
      repository: 'example/repo',
      pullRequestNumber: 42,
      baseBranch: 'main',
      headBranch: 'agent/task/attempt',
      headSha: HEAD_SHA,
    },
    task: {
      revision: 'revision-1',
      digest: DIGEST,
      title: 'Fix the regression',
      description: 'Correct the observed behavior without changing the permission boundary.',
      acceptanceCriteria: ['The regression is fixed and trusted tests pass.'],
    },
    plan: {
      id: 'plan-1',
      version: 1,
      digest: DIGEST,
      objective: 'Implement and verify the requested correction.',
      item: {
        id: 'item-1',
        title: 'Implement and verify',
        objective: 'Apply the exact correction and preserve existing behavior.',
        doneWhen: ['The regression is fixed and verification passes.'],
        commandRefs: ['verify:all'],
      },
    },
  });
}

async function paths() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-review-adapter-'));
  const workspace = join(root, 'workspace');
  const temporary = join(root, 'temporary');
  await Promise.all([mkdir(workspace), mkdir(temporary)]);
  const contextFile = join(temporary, 'context.json');
  const outputFile = join(temporary, 'output.json');
  const schemaFile = join(temporary, 'schema.json');
  await Promise.all([
    writeFile(contextFile, JSON.stringify(context())),
    writeFile(outputFile, ''),
    writeFile(schemaFile, JSON.stringify(AUTOMATED_REVIEW_RESULT_V1_JSON_SCHEMA)),
  ]);
  return { workspace, contextFile, outputFile, schemaFile };
}

describe('Codex automated review adapter', () => {
  it('runs read-only and returns a digest-bound structured review', async () => {
    const input = await paths();
    let request: CommandExecutionRequest | undefined;
    const digest = await automatedReviewContextDigest(context());
    const adapter = new CodexReviewAdapter({
      outputSchemaPath: input.schemaFile,
      execute: async (observed) => {
        request = observed;
        await writeFile(input.outputFile, JSON.stringify({
          schemaVersion: '1',
          contextDigest: digest,
          verdict: 'changes_requested',
          summary: 'A correctness issue must be fixed.',
          findings: [{
            severity: 'major',
            title: 'Missing compare-and-set guard',
            body: 'The update can overwrite a concurrent state transition.',
            path: 'src/state.ts',
            line: 42,
          }],
        }));
        return { exitCode: 0 };
      },
    });
    const result = await adapter.start({
      workspacePath: input.workspace,
      contextFilePath: input.contextFile,
      outputFilePath: input.outputFile,
      timeoutMs: 60_000,
    });
    expect(result.verdict).toBe('changes_requested');
    expect(request?.args).toContain('read-only');
    expect(request?.args).toContain('approval_policy="never"');
    expect(request?.args).toContain('project_doc_max_bytes=0');
    expect(request?.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(request?.stdin).toContain(`TRUSTED_CONTEXT_DIGEST=${digest}`);
  });

  it('rejects an output bound to another context', async () => {
    const input = await paths();
    const adapter = new CodexReviewAdapter({
      outputSchemaPath: input.schemaFile,
      execute: async () => {
        await writeFile(input.outputFile, JSON.stringify({
          schemaVersion: '1',
          contextDigest: `sha256:${'f'.repeat(64)}`,
          verdict: 'approved',
          summary: 'No major findings remain.',
          findings: [],
        }));
        return { exitCode: 0 };
      },
    });
    await expect(adapter.start({
      workspacePath: input.workspace,
      contextFilePath: input.contextFile,
      outputFilePath: input.outputFile,
      timeoutMs: 60_000,
    })).rejects.toBeInstanceOf(CodexReviewAdapterError);
  });
});
