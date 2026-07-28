import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandExecutionRequest } from '../src/agent/command-runtime.js';
import { CodexExecutionAdapter } from '../src/agent/codex-execution-adapter.js';

describe('Codex execution adapter', () => {
  it('uses ephemeral workspace-write with approval never and keeps context content out of prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-execution-agent-'));
    const workspace = join(root, 'repo');
    const contextFilePath = join(root, 'context.json');
    const outputFilePath = join(root, 'output.txt');
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(
      contextFilePath,
      JSON.stringify({ canary: 'CANARY_EXECUTION_CONTEXT_NOT_IN_PROMPT' }),
      { mode: 0o600 },
    );
    await chmod(contextFilePath, 0o600);
    await writeFile(outputFilePath, '', { mode: 0o600, flag: 'wx' });
    let observed: CommandExecutionRequest | undefined;
    const adapter = new CodexExecutionAdapter({
      providerBaseUrl: 'https://relay.example.com/openai/v1/',
      execute: async (request) => {
        observed = request;
        await writeFile(join(workspace, 'fixed.txt'), 'fixed\n');
        await writeFile(outputFilePath, JSON.stringify({
          schemaVersion: '1',
          action: 'apply_fix',
        }));
        return { exitCode: 0 };
      },
    });

    await expect(adapter.apply({
      attemptId: 'attempt-execution-agent',
      workspacePath: workspace,
      contextFilePath,
      outputFilePath,
      timeoutMs: 60_000,
      allowPlanRevision: false,
    })).resolves.toEqual({ schemaVersion: '1', action: 'apply_fix' });
    expect(observed).toMatchObject({ command: 'codex', cwd: workspace });
    expect(observed?.args).toEqual([
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--color',
      'never',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'project_doc_max_bytes=0',
      '-c',
      'shell_environment_policy.ignore_default_excludes=false',
      '-c',
      'shell_environment_policy.exclude=["*KEY*","*SECRET*","*TOKEN*","*PASSWORD*"]',
      '-c',
      'openai_base_url="https://relay.example.com/openai/v1"',
      '--output-last-message',
      outputFilePath,
      '--cd',
      workspace,
      '-',
    ]);
    expect(observed?.args).not.toContain('--yolo');
    expect(observed?.stdin).toContain(contextFilePath);
    expect(observed?.stdin).not.toContain('CANARY_EXECUTION_CONTEXT_NOT_IN_PROMPT');
    expect(observed?.stdin).toContain('untrusted reference material');
    expect(observed?.stdin).toContain('request_replan is forbidden');
    expect(await readFile(join(workspace, 'fixed.txt'), 'utf8')).toBe('fixed\n');
  });

  it.each([
    'http://relay.example.com/v1',
    'https://user:password@relay.example.com/v1',
    'https://relay.example.com/v1?token=credential',
    'https://relay.example.com/v1#fragment',
    'https://localhost/v1',
    'https://[::1]/v1',
  ])('rejects unsafe relay base URL %s', (providerBaseUrl) => {
    expect(() => new CodexExecutionAdapter({ providerBaseUrl }))
      .toThrow('Codex provider base URL is invalid');
  });

  it('rejects context/output files inside the repository and non-zero Agent exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-execution-agent-negative-'));
    const workspace = join(root, 'repo');
    await mkdir(workspace, { mode: 0o700 });
    const inside = join(workspace, 'context.json');
    const outside = join(root, 'context.json');
    const output = join(root, 'output.txt');
    await writeFile(inside, '{}', { mode: 0o600 });
    await writeFile(outside, '{}', { mode: 0o600 });
    await writeFile(output, '', { mode: 0o600 });
    const adapter = new CodexExecutionAdapter({
      execute: async () => ({ exitCode: 9, stderr: 'CANARY_AGENT_STDERR' }),
    });
    await expect(adapter.apply({
      attemptId: 'attempt-execution-inside',
      workspacePath: workspace,
      contextFilePath: inside,
      outputFilePath: output,
      timeoutMs: 60_000,
      allowPlanRevision: false,
    })).rejects.toThrow('execution Agent files must be outside repository');
    await expect(adapter.apply({
      attemptId: 'attempt-execution-failed',
      workspacePath: workspace,
      contextFilePath: outside,
      outputFilePath: output,
      timeoutMs: 60_000,
      allowPlanRevision: false,
    })).rejects.toThrow('execution Agent failed with exit code 9');
  });

  it('accepts a strict request_replan decision only for head-bound review feedback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-execution-replan-'));
    const workspace = join(root, 'repo');
    const contextFilePath = join(root, 'context.json');
    const outputFilePath = join(root, 'output.txt');
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(contextFilePath, '{}', { mode: 0o600 });
    await writeFile(outputFilePath, '', { mode: 0o600 });
    let prompt = '';
    const adapter = new CodexExecutionAdapter({
      execute: async (request) => {
        prompt = request.stdin;
        await writeFile(outputFilePath, JSON.stringify({
          schemaVersion: '1',
          action: 'request_replan',
        }));
        return { exitCode: 0 };
      },
    });
    const input = {
      attemptId: 'attempt-review-replan',
      workspacePath: workspace,
      contextFilePath,
      outputFilePath,
      timeoutMs: 60_000,
      allowPlanRevision: true,
    } as const;
    await expect(adapter.apply(input)).resolves.toEqual({
      schemaVersion: '1',
      action: 'request_replan',
    });
    expect(prompt).toContain('request_replan');
    await expect(adapter.apply({ ...input, allowPlanRevision: false }))
      .rejects.toThrow('execution Agent decision is invalid');
  });

  it('fans the same bounded Codex JSONL stream to transcript capture and usage accounting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-execution-transcript-'));
    const workspace = join(root, 'repo');
    const contextFilePath = join(root, 'context.json');
    const outputFilePath = join(root, 'output.txt');
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(contextFilePath, '{}', { mode: 0o600 });
    await writeFile(outputFilePath, '', { mode: 0o600 });
    const transcript: string[] = [];
    let usage: unknown;
    const lines = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'safe' } }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 11,
          cached_input_tokens: 3,
          output_tokens: 5,
          reasoning_output_tokens: 2,
        },
      }),
    ];
    const adapter = new CodexExecutionAdapter({
      execute: async (request) => {
        for (const line of lines) request.onStdoutLine?.(line);
        await writeFile(outputFilePath, JSON.stringify({
          schemaVersion: '1',
          action: 'apply_fix',
        }));
        expect(request.args).toContain('--json');
        expect(request.args).toContain('gpt-test');
        return { exitCode: 0 };
      },
    });

    await expect(adapter.apply({
      attemptId: 'attempt-execution-transcript',
      workspacePath: workspace,
      contextFilePath,
      outputFilePath,
      timeoutMs: 60_000,
      allowPlanRevision: false,
      model: 'gpt-test',
      onTranscriptLine: (line) => { transcript.push(line); },
      onUsage: (value) => { usage = value; },
    })).resolves.toEqual({ schemaVersion: '1', action: 'apply_fix' });
    expect(transcript).toEqual(lines);
    expect(usage).toEqual({
      inputTokens: 11,
      cachedInputTokens: 3,
      outputTokens: 5,
      reasoningOutputTokens: 2,
    });
  });
});
