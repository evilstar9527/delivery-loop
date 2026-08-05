import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandExecutionRequest } from '../src/agent/command-runtime.js';
import {
  CodexExecutionAdapter,
  type CodexExecutionAdapterError,
} from '../src/agent/codex-execution-adapter.js';

describe('Codex execution adapter', () => {
  it('uses ephemeral workspace-write with approval never and embeds bounded untrusted context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-execution-agent-'));
    const workspace = join(root, 'repo');
    const contextFilePath = join(root, 'context.json');
    const outputFilePath = join(root, 'output.txt');
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(
      contextFilePath,
      JSON.stringify({ canary: 'CANARY_EXECUTION_CONTEXT_EMBEDDED' }),
      { mode: 0o600 },
    );
    await chmod(contextFilePath, 0o600);
    await writeFile(outputFilePath, '', { mode: 0o600, flag: 'wx' });
    let observed: CommandExecutionRequest | undefined;
    const adapter = new CodexExecutionAdapter({
      providerBaseUrl: 'https://relay.example.com/openai/v1/',
      execute: async (request) => {
        observed = request;
        const schemaPath = request.args[request.args.indexOf('--output-schema') + 1];
        expect(JSON.parse(await readFile(schemaPath!, 'utf8'))).toEqual({
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          additionalProperties: false,
          properties: {
            schemaVersion: { type: 'string', const: '1' },
            action: { type: 'string', enum: ['apply_fix'] },
          },
          required: ['schemaVersion', 'action'],
        });
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
      'model_provider="delivery_loop_relay"',
      '-c',
      'model_providers.delivery_loop_relay.name="Delivery Loop OpenAI-compatible relay"',
      '-c',
      'model_providers.delivery_loop_relay.base_url="https://relay.example.com/openai/v1"',
      '-c',
      'model_providers.delivery_loop_relay.wire_api="responses"',
      '-c',
      'model_providers.delivery_loop_relay.requires_openai_auth=true',
      '-c',
      'model_providers.delivery_loop_relay.supports_websockets=false',
      '-c',
      'model_reasoning_effort="medium"',
      '--output-schema',
      expect.stringMatching(/decision-schema\.json$/),
      '--output-last-message',
      outputFilePath,
      '--cd',
      workspace,
      '-',
    ]);
    expect(observed?.args).not.toContain('--yolo');
    const observedArgs = observed?.args ?? [];
    const schemaPath = observedArgs[observedArgs.indexOf('--output-schema') + 1];
    expect(schemaPath).toBeDefined();
    await expect(readFile(schemaPath!, 'utf8')).rejects.toThrow();
    expect(observed?.stdin).toContain(contextFilePath);
    expect(observed?.stdin).toContain('BEGIN_UNTRUSTED_EXECUTION_CONTEXT_JSON');
    expect(observed?.stdin).toContain('CANARY_EXECUTION_CONTEXT_EMBEDDED');
    expect(observed?.stdin).toContain('END_UNTRUSTED_EXECUTION_CONTEXT_JSON');
    expect(observed?.stdin).toContain('do not use a file tool to retrieve it');
    expect(observed?.stdin).toContain('untrusted reference material');
    expect(observed?.stdin).toContain('request_replan is forbidden');
    expect(observed?.stdin).toContain('at least one completed command_execution');
    expect(observed?.stdin).toContain('one completed file_change');
    expect(await readFile(join(workspace, 'fixed.txt'), 'utf8')).toBe('fixed\n');
  });

  it('rejects oversized or changed execution context before accepting a decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-execution-context-proof-'));
    const workspace = join(root, 'repo');
    const contextFilePath = join(root, 'context.json');
    const outputFilePath = join(root, 'output.txt');
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(outputFilePath, '', { mode: 0o600 });
    let calls = 0;
    const adapter = new CodexExecutionAdapter({
      execute: async () => {
        calls += 1;
        await writeFile(contextFilePath, JSON.stringify({ changed: true }), { mode: 0o600 });
        await writeFile(outputFilePath, JSON.stringify({
          schemaVersion: '1',
          action: 'apply_fix',
        }));
        return { exitCode: 0 };
      },
    });
    const input = {
      attemptId: 'attempt-execution-context-proof',
      workspacePath: workspace,
      contextFilePath,
      outputFilePath,
      timeoutMs: 60_000,
      allowPlanRevision: false,
    } as const;

    await writeFile(
      contextFilePath,
      JSON.stringify({ content: 'x'.repeat(256 * 1_024) }),
      { mode: 0o600 },
    );
    await expect(adapter.apply(input)).rejects.toThrow('execution Agent context proof is invalid');
    expect(calls).toBe(0);

    await writeFile(contextFilePath, JSON.stringify({ stable: true }), { mode: 0o600 });
    await expect(adapter.apply(input)).rejects.toThrow('execution Agent context proof is invalid');
    expect(calls).toBe(1);
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
    })).rejects.toThrow('execution Agent process failed');
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
    const decisionActions: string[][] = [];
    const adapter = new CodexExecutionAdapter({
      execute: async (request) => {
        prompt = request.stdin;
        const schemaPath = request.args[request.args.indexOf('--output-schema') + 1];
        const schema = JSON.parse(await readFile(schemaPath!, 'utf8')) as {
          properties: { action: { enum: string[] } };
        };
        decisionActions.push(schema.properties.action.enum);
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
    expect(decisionActions).toEqual([
      ['apply_fix', 'request_replan'],
      ['apply_fix'],
    ]);
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
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', status: 'completed', exit_code: 0 },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'file_change', status: 'completed' },
      }),
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

  it('runs metered implement as an edit turn and derives apply_fix from real tool activity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-execution-edit-turn-'));
    const workspace = join(root, 'repo');
    const contextFilePath = join(root, 'context.json');
    const outputFilePath = join(root, 'output.txt');
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(contextFilePath, '{}', { mode: 0o600 });
    await writeFile(outputFilePath, '', { mode: 0o600 });
    let observed: CommandExecutionRequest | undefined;
    const adapter = new CodexExecutionAdapter({
      execute: async (request) => {
        observed = request;
        request.onStdoutLine?.(JSON.stringify({
          type: 'item.completed',
          item: { type: 'command_execution', status: 'completed', exit_code: 0 },
        }));
        request.onStdoutLine?.(JSON.stringify({
          type: 'item.completed',
          item: { type: 'file_change', status: 'completed' },
        }));
        request.onStdoutLine?.(JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 11,
            cached_input_tokens: 3,
            output_tokens: 5,
            reasoning_output_tokens: 2,
          },
        }));
        return { exitCode: 0 };
      },
    });

    await expect(adapter.apply({
      attemptId: 'attempt-execution-edit-turn',
      workspacePath: workspace,
      contextFilePath,
      outputFilePath,
      timeoutMs: 60_000,
      allowPlanRevision: false,
      editTurn: 2,
      model: 'gpt-test',
    })).resolves.toEqual({ schemaVersion: '1', action: 'apply_fix' });
    expect(observed?.args).not.toContain('--output-schema');
    expect(observed?.args).not.toContain('--output-last-message');
    expect(observed?.stdin).toContain('Your final message is not an execution decision');
    expect(observed?.stdin).toContain('This is the single recovery turn');
    expect(observed?.stdin).toContain('Your first action must be a repository command');
  });

  it('rejects metered apply_fix before commit when no command or file change was observed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-execution-no-tool-activity-'));
    const workspace = join(root, 'repo');
    const contextFilePath = join(root, 'context.json');
    const outputFilePath = join(root, 'output.txt');
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(contextFilePath, '{}', { mode: 0o600 });
    await writeFile(outputFilePath, '', { mode: 0o600 });
    const adapter = new CodexExecutionAdapter({
      execute: async (request) => {
        request.onStdoutLine?.(JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'apply without tools' },
        }));
        request.onStdoutLine?.(JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 11,
            cached_input_tokens: 3,
            output_tokens: 5,
            reasoning_output_tokens: 2,
          },
        }));
        await writeFile(outputFilePath, JSON.stringify({
          schemaVersion: '1',
          action: 'apply_fix',
        }));
        return { exitCode: 0 };
      },
    });

    const rejected = adapter.apply({
      attemptId: 'attempt-execution-no-tool-activity',
      workspacePath: workspace,
      contextFilePath,
      outputFilePath,
      timeoutMs: 60_000,
      allowPlanRevision: false,
      model: 'gpt-test',
    });
    await expect(rejected).rejects.toMatchObject({
      name: 'CodexExecutionAdapterError',
      kind: 'decision_invalid',
      reason: 'no_tool_activity',
      message: 'execution Agent decision is invalid',
    } satisfies Partial<CodexExecutionAdapterError>);
  });

  it('classifies started-only tool activity as incomplete and ineligible for recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-execution-incomplete-tool-activity-'));
    const workspace = join(root, 'repo');
    const contextFilePath = join(root, 'context.json');
    const outputFilePath = join(root, 'output.txt');
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(contextFilePath, '{}', { mode: 0o600 });
    await writeFile(outputFilePath, '', { mode: 0o600 });
    const adapter = new CodexExecutionAdapter({
      execute: async (request) => {
        request.onStdoutLine?.(JSON.stringify({
          type: 'item.started',
          item: { type: 'command_execution' },
        }));
        request.onStdoutLine?.(JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 11,
            cached_input_tokens: 3,
            output_tokens: 5,
            reasoning_output_tokens: 2,
          },
        }));
        return { exitCode: 0 };
      },
    });

    await expect(adapter.apply({
      attemptId: 'attempt-execution-incomplete-tool-activity',
      workspacePath: workspace,
      contextFilePath,
      outputFilePath,
      timeoutMs: 60_000,
      allowPlanRevision: false,
      model: 'gpt-test',
    })).rejects.toMatchObject({
      name: 'CodexExecutionAdapterError',
      kind: 'decision_invalid',
      reason: 'incomplete_tool_activity',
      message: 'execution Agent decision is invalid',
    } satisfies Partial<CodexExecutionAdapterError>);
  });

  it('preserves only a fixed safe reason when the JSONL observer rejects stdout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-execution-transcript-rejected-'));
    const workspace = join(root, 'repo');
    const contextFilePath = join(root, 'context.json');
    const outputFilePath = join(root, 'output.txt');
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(contextFilePath, '{}', { mode: 0o600 });
    await writeFile(outputFilePath, '', { mode: 0o600 });
    const adapter = new CodexExecutionAdapter({
      execute: async () => ({ exitCode: 1, stdoutInvalid: true }),
    });

    const rejected = adapter.apply({
      attemptId: 'attempt-execution-transcript-rejected',
      workspacePath: workspace,
      contextFilePath,
      outputFilePath,
      timeoutMs: 60_000,
      allowPlanRevision: false,
      onTranscriptLine: () => undefined,
    });
    await expect(rejected).rejects.toMatchObject({
      name: 'CodexExecutionAdapterError',
      kind: 'transcript_invalid',
      message: 'execution Agent transcript is invalid',
    } satisfies Partial<CodexExecutionAdapterError>);
  });
});
