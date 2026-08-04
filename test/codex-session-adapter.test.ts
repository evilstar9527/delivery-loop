import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentCheckpointV1 } from '../src/domain/checkpoint.js';
import { computeAgentCheckpointDigest } from '../src/domain/checkpoint.js';
import {
  launchCommand,
  type CommandExecutionRequest,
  type CommandExecutionResult,
  type CommandProcessHandle,
  type CommandProcessLauncher,
} from '../src/agent/command-runtime.js';
import {
  CodexSessionAdapter,
  type AgentSession,
} from '../src/agent/codex-session-adapter.js';

const HEAD_SHA = 'a'.repeat(40);
const OUTPUT_SCHEMA_PATH = resolve('schemas/agent-session-result-v1.schema.json');

function semanticCheckpoint(sequence = 1): AgentCheckpointV1 {
  return {
    schemaVersion: '1',
    sequence,
    provider: 'codex',
    planVersion: 3,
    planItemId: 'implement-session-adapter',
    headBranch: 'agent/task-session/attempt-session',
    headSha: HEAD_SHA,
    completedAcceptanceCriteria: [],
    evidenceRefs: [],
    summary: 'The adapter session has been initialized.',
    nextStep: 'Continue the active Plan Item from the trusted repository snapshot.',
    workingTreeDigest: `sha256:${'b'.repeat(64)}`,
  };
}

async function privateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function tempPaths(): Promise<{
  root: string;
  workspace: string;
  contextFile: string;
  checkpointFile: string;
  outputFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-codex-session-'));
  const workspace = join(root, 'repo');
  const contextFile = join(root, 'context.json');
  const checkpointFile = join(root, 'checkpoint.json');
  const outputFile = join(root, 'last-message.txt');
  await mkdir(workspace, { mode: 0o700 });
  await privateFile(contextFile, JSON.stringify({ canary: 'CANARY_CONTEXT_NOT_IN_PROMPT' }));
  await privateFile(checkpointFile, JSON.stringify(semanticCheckpoint()));
  return { root, workspace, contextFile, checkpointFile, outputFile };
}

function controlledProcess(): {
  handle: CommandProcessHandle;
  finish: (result: CommandExecutionResult) => void;
  interruptCount: () => number;
} {
  let finish!: (result: CommandExecutionResult) => void;
  let interrupts = 0;
  let settled = false;
  const completion = new Promise<CommandExecutionResult>((resolve) => {
    finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
  });
  return {
    handle: {
      completion,
      interrupt: async () => {
        interrupts += 1;
        finish({ exitCode: 143 });
        await completion;
      },
    },
    finish,
    interruptCount: () => interrupts,
  };
}

describe('Codex AgentAdapter session contract', () => {
  it('starts a non-interactive ephemeral session and exports only Runner-recorded checkpoints', async () => {
    const paths = await tempPaths();
    const process = controlledProcess();
    let observed: CommandExecutionRequest | undefined;
    const launch: CommandProcessLauncher = (request) => {
      observed = request;
      return process.handle;
    };
    const adapter = new CodexSessionAdapter({
      outputSchemaPath: OUTPUT_SCHEMA_PATH,
      providerBaseUrl: 'https://relay.example.com/openai/v1/',
      model: 'gpt-5.6-sol',
      launch,
    });
    const session = await adapter.start({
      attemptId: 'attempt-session-start',
      workspacePath: paths.workspace,
      contextFilePath: paths.contextFile,
      outputFilePath: paths.outputFile,
      timeoutMs: 60_000,
      initialCheckpoint: semanticCheckpoint(),
    });

    expect(session.status).toBe('running');
    expect(session.resumeStrategy).toBe('semantic-checkpoint');
    expect(observed).toMatchObject({ command: 'codex', cwd: paths.workspace });
    expect(observed?.args).toEqual([
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--color',
      'never',
      '--sandbox',
      'read-only',
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
      '--model',
      'gpt-5.6-sol',
      '--output-schema',
      OUTPUT_SCHEMA_PATH,
      '--output-last-message',
      paths.outputFile,
      '--cd',
      paths.workspace,
      '-',
    ]);
    expect(observed?.stdin).toContain(paths.contextFile);
    expect(observed?.stdin).not.toContain('CANARY_CONTEXT_NOT_IN_PROMPT');

    session.recordCheckpoint({
      ...semanticCheckpoint(2),
      summary: 'A verified repository inspection completed.',
      evidenceRefs: ['d1://evidence/session-adapter-inspection'],
    });
    const exported = await adapter.exportCheckpoint(session);
    expect(exported).toMatchObject({
      sequence: 2,
      planVersion: 3,
      planItemId: 'implement-session-adapter',
      summary: 'A verified repository inspection completed.',
    });
    exported.summary = 'caller mutation';
    expect((await adapter.exportCheckpoint(session)).summary).not.toBe('caller mutation');

    process.finish({ exitCode: 0 });
    expect(await session.completion).toEqual({ exitCode: 0 });
    expect(session.status).toBe('completed');
  });

  it.each([
    'http://relay.example.com/v1',
    'https://user:password@relay.example.com/v1',
    'https://relay.example.com/v1?token=credential',
    'https://relay.example.com/v1#fragment',
    'https://localhost/v1',
    'https://[::1]/v1',
  ])('rejects unsafe relay base URL %s', (providerBaseUrl) => {
    expect(() => new CodexSessionAdapter({
      outputSchemaPath: OUTPUT_SCHEMA_PATH,
      providerBaseUrl,
    })).toThrow('Codex provider base URL is invalid');
  });

  it.each(['', ' model', 'model name', 'model?token=value'])('rejects invalid model %s', (model) => {
    expect(() => new CodexSessionAdapter({
      outputSchemaPath: OUTPUT_SCHEMA_PATH,
      model,
    })).toThrow('Codex model is invalid');
  });

  it('resumes through a digest-verified semantic checkpoint without invoking native session resume', async () => {
    const paths = await tempPaths();
    const process = controlledProcess();
    let observed: CommandExecutionRequest | undefined;
    const adapter = new CodexSessionAdapter({
      outputSchemaPath: OUTPUT_SCHEMA_PATH,
      launch: (request) => {
        observed = request;
        return process.handle;
      },
    });
    const digest = await computeAgentCheckpointDigest(semanticCheckpoint());
    const session = await adapter.resume({
      attemptId: 'attempt-session-resume',
      workspacePath: paths.workspace,
      contextFilePath: paths.contextFile,
      checkpointFilePath: paths.checkpointFile,
      checkpointDigest: digest,
      outputFilePath: paths.outputFile,
      timeoutMs: 60_000,
      expectedPlanVersion: 3,
      expectedPlanItemId: 'implement-session-adapter',
      expectedHeadSha: HEAD_SHA,
    });

    expect(session.status).toBe('running');
    expect(observed?.args.slice(0, 2)).toEqual(['exec', '--ephemeral']);
    expect(observed?.args).not.toContain('resume');
    expect(observed?.args).not.toContain(semanticCheckpoint().summary);
    expect(observed?.stdin).toContain(paths.checkpointFile);
    expect(observed?.stdin).toContain('semantic checkpoint');
    expect(observed?.stdin).not.toContain(semanticCheckpoint().summary);
    expect(await adapter.exportCheckpoint(session)).toEqual(semanticCheckpoint());

    process.finish({ exitCode: 0 });
    await session.completion;

    await expect(
      adapter.resume({
        attemptId: 'attempt-session-tampered',
        workspacePath: paths.workspace,
        contextFilePath: paths.contextFile,
        checkpointFilePath: paths.checkpointFile,
        checkpointDigest: `sha256:${'c'.repeat(64)}`,
        outputFilePath: paths.outputFile,
        timeoutMs: 60_000,
        expectedPlanVersion: 3,
        expectedPlanItemId: 'implement-session-adapter',
        expectedHeadSha: HEAD_SHA,
      }),
    ).rejects.toThrow('Codex resume checkpoint is invalid');
  });

  it('interrupts an owned session once and rejects stale or foreign checkpoint mutation', async () => {
    const paths = await tempPaths();
    const process = controlledProcess();
    const adapter = new CodexSessionAdapter({
      outputSchemaPath: OUTPUT_SCHEMA_PATH,
      launch: () => process.handle,
    });
    const session = await adapter.start({
      attemptId: 'attempt-session-interrupt',
      workspacePath: paths.workspace,
      contextFilePath: paths.contextFile,
      outputFilePath: paths.outputFile,
      timeoutMs: 60_000,
      initialCheckpoint: semanticCheckpoint(),
    });

    expect(() => session.recordCheckpoint(semanticCheckpoint())).toThrow(
      'checkpoint sequence must increase',
    );
    expect(() =>
      session.recordCheckpoint({ ...semanticCheckpoint(2), planVersion: 4 }),
    ).toThrow('checkpoint binding changed');

    const reasonCanary = 'CANARY_INTERRUPT_REASON_NOT_FORWARDED';
    await adapter.interrupt(session, reasonCanary);
    await adapter.interrupt(session, reasonCanary);
    expect(process.interruptCount()).toBe(1);
    expect(session.status).toBe('interrupted');
    expect(await session.completion).toEqual({ exitCode: 143 });
    expect(() => session.recordCheckpoint(semanticCheckpoint(2))).toThrow(
      'session is not running',
    );

    const forged = {
      ...session,
      id: 'forged-session',
    } as AgentSession;
    await expect(adapter.interrupt(forged, 'stop')).rejects.toThrow(
      'Agent session is not owned by this adapter',
    );
  });

  it('terminates a real child process through the reusable command runtime', async () => {
    const handle = launchCommand({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      stdin: '',
      timeoutMs: 10_000,
    });
    await handle.interrupt();
    const result = await handle.completion;
    expect(result.exitCode).not.toBe(0);
  });
});
