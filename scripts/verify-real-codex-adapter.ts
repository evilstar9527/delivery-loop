import { execFile } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CodexSessionAdapter } from '../src/agent/codex-session-adapter.js';
import { classifyProviderProcessFailure } from '../src/agent/provider-preflight-failure.js';
import { AgentSessionResultV1Schema } from '../src/domain/agent-session-result.js';
import {
  computeAgentCheckpointDigest,
  type AgentCheckpointV1,
} from '../src/domain/checkpoint.js';
import { canonicalSha256 } from '../src/domain/digest.js';
import { AgentAdapterEvidenceManifestV1Schema } from '../src/domain/agent-adapter-evidence.js';

const executeFile = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const outputSchemaPath = resolve(projectRoot, 'schemas/agent-session-result-v1.schema.json');
const MAX_OUTPUT_BYTES = 4 * 1_024;

class VerificationFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'VerificationFailure';
  }
}

class PrerequisiteFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PrerequisiteFailure';
  }
}

async function command(commandName: string, args: string[], cwd?: string): Promise<string> {
  const result = await executeFile(commandName, args, {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1_024,
  });
  return result.stdout.trim();
}

async function privateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
}

function checkpoint(headSha: string, sequence: number): AgentCheckpointV1 {
  return {
    schemaVersion: '1',
    sequence,
    provider: 'codex',
    planVersion: 1,
    planItemId: 'verify-real-codex-adapter',
    headBranch: 'main',
    headSha,
    completedAcceptanceCriteria: [],
    evidenceRefs: [],
    summary: sequence === 1
      ? 'The trusted read-only session is ready to start.'
      : 'The real Codex process started under the trusted adapter contract.',
    nextStep: sequence === 1
      ? 'Start the authenticated non-interactive provider process.'
      : 'Verify structured output, clean Git state, and process exit.',
    workingTreeDigest: `sha256:${'0'.repeat(64)}`,
  };
}

async function authenticationConfigured(): Promise<boolean> {
  if (process.env.CODEX_API_KEY !== undefined && process.env.CODEX_API_KEY.length > 0) {
    return true;
  }
  try {
    await command('codex', ['login', 'status']);
    return true;
  } catch {
    return false;
  }
}

async function run(): Promise<void> {
  // Exit layering is directly derived from Watt scripts/e2e/lib.ts:
  // 0=verified, 1=assertion/fact failure, 2=explicit prerequisite missing.
  if (process.env.DELIVERY_LOOP_CODEX_ADAPTER_E2E !== '1') {
    console.error(
      'real-codex-adapter-e2e: opt-in missing (set DELIVERY_LOOP_CODEX_ADAPTER_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  if (!(await authenticationConfigured())) {
    console.error('real-codex-adapter-e2e: authenticated Codex CLI is unavailable');
    process.exitCode = 2;
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-real-codex-'));
  try {
    const workspace = join(root, 'repo');
    const contextFilePath = join(root, 'context.json');
    const outputFilePath = join(root, 'agent-result.json');
    await mkdir(workspace, { mode: 0o700 });
    await command('git', ['init', '--initial-branch=main'], workspace);
    await command('git', ['config', 'user.name', 'Delivery Loop E2E'], workspace);
    await command('git', ['config', 'user.email', 'delivery-loop-e2e@example.test'], workspace);
    await writeFile(
      join(workspace, 'README.md'),
      '# Read-only adapter fixture\n\nReturn the trusted structured completion marker.\n',
      { mode: 0o600, flag: 'wx' },
    );
    await command('git', ['add', 'README.md'], workspace);
    await command('git', ['commit', '-m', 'create read-only adapter fixture'], workspace);
    const headSha = await command('git', ['rev-parse', 'HEAD'], workspace);
    if (!/^[a-f0-9]{40}$/.test(headSha)) throw new VerificationFailure('git_head_invalid');
    await privateFile(contextFilePath, JSON.stringify({
      schemaVersion: '1',
      objective: 'Inspect the repository in read-only mode and return the schema marker.',
      authority: 'No repository writes or external effects are permitted.',
    }));
    await privateFile(outputFilePath, '');

    const providerBaseUrl = process.env.OPENAI_BASE_URL;
    const model = process.env.DELIVERY_LOOP_CODEX_ADAPTER_MODEL;
    const adapter = new CodexSessionAdapter({
      outputSchemaPath,
      ...(providerBaseUrl === undefined ? {} : { providerBaseUrl }),
      ...(model === undefined ? {} : { model }),
    });
    const session = await adapter.start({
      attemptId: 'attempt-real-codex-adapter-e2e',
      workspacePath: workspace,
      contextFilePath,
      outputFilePath,
      timeoutMs: 120_000,
      initialCheckpoint: checkpoint(headSha, 1),
    });
    session.recordCheckpoint(checkpoint(headSha, 2));
    const exportedCheckpoint = await adapter.exportCheckpoint(session);
    const checkpointDigest = await computeAgentCheckpointDigest(exportedCheckpoint);
    const completion = await session.completion;
    if (completion.exitCode !== 0 || session.status !== 'completed') {
      const failureCode = classifyProviderProcessFailure(completion.stderr);
      if (failureCode === 'provider_authentication_failed') {
        throw new PrerequisiteFailure(failureCode);
      }
      throw new VerificationFailure(failureCode);
    }

    const metadata = await stat(outputFilePath);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_OUTPUT_BYTES) {
      throw new VerificationFailure('structured_output_invalid');
    }
    let rawOutput: unknown;
    try {
      rawOutput = JSON.parse(await readFile(outputFilePath, 'utf8')) as unknown;
    } catch {
      throw new VerificationFailure('structured_output_invalid');
    }
    const output = AgentSessionResultV1Schema.safeParse(rawOutput);
    if (!output.success) throw new VerificationFailure('structured_output_invalid');
    const [finalHead, finalStatus] = await Promise.all([
      command('git', ['rev-parse', 'HEAD'], workspace),
      command('git', ['status', '--porcelain=v1', '--untracked-files=all'], workspace),
    ]);
    if (finalHead !== headSha || finalStatus !== '') {
      throw new VerificationFailure('repository_mutated');
    }
    if (exportedCheckpoint.sequence !== 2 || exportedCheckpoint.headSha !== headSha) {
      throw new VerificationFailure('checkpoint_invalid');
    }
    const cliVersion = (await command('codex', ['--version'])).replaceAll(/\s+/g, '-');
    const evidence = AgentAdapterEvidenceManifestV1Schema.parse({
      schemaVersion: '1',
      evidenceId: 'real-codex-adapter-e2e',
      recordedAt: new Date().toISOString(),
      provider: 'codex',
      cliVersion,
      resultSchema: 'AgentSessionResultV1',
      status: 'passed',
      processExitCode: completion.exitCode,
      sessionStatus: session.status,
      structuredOutputDigest: await canonicalSha256(output.data),
      checkpoint: {
        sequence: exportedCheckpoint.sequence,
        digest: checkpointDigest,
        planVersion: exportedCheckpoint.planVersion,
        planItemId: exportedCheckpoint.planItemId,
        headBranch: exportedCheckpoint.headBranch ?? 'main',
        headSha: exportedCheckpoint.headSha,
      },
      workspace: {
        headSha,
        headBranch: 'main',
        repositoryClean: true,
        ephemeral: true,
      },
    });
    console.log(JSON.stringify(evidence));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

try {
  await run();
} catch (error) {
  if (error instanceof PrerequisiteFailure) {
    console.error(`real-codex-adapter-e2e: prerequisite missing ${error.code}`);
    process.exitCode = 2;
  } else {
    const code = error instanceof VerificationFailure ? error.code : 'verification_failed';
    console.error(`real-codex-adapter-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}
