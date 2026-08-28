import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir } from 'node:fs/promises';

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const MAX_OUTPUT_BYTES = 1_048_576;
const GIT_TIMEOUT_MS = 2 * 60_000;
// After the deadline we SIGTERM the process group, then escalate to SIGKILL if
// the child still has not closed. `git fetch` spawns network helper
// subprocesses (git-remote-https) that can outlive a SIGTERM to the parent, so
// without a group kill + SIGKILL the child may never `close` and the awaiting
// Promise would hang forever — the observed pre-heartbeat analysis freeze.
const GIT_SIGKILL_GRACE_MS = 5_000;

export class ExecutorRepositoryCheckoutError extends Error {
  constructor() {
    super('Executor repository checkout failed');
    this.name = 'ExecutorRepositoryCheckoutError';
  }
}

export interface ExecutorGitCommandInput {
  repositoryPath: string;
  args: readonly string[];
  authorizationHeader?: string;
}

export interface ExecutorGitCommandResult {
  exitCode: number;
  stdout: string;
}

export type ExecutorGitCommand = (
  input: ExecutorGitCommandInput,
) => Promise<ExecutorGitCommandResult>;

// Test seam: inject a fake spawn and shrink the timers so the deadline /
// SIGKILL-escalation / guaranteed-settlement paths can be exercised
// deterministically without a real hung git. Production uses the defaults.
export interface ExecutorGitCommandOptions {
  spawnFn?: typeof spawn;
  timeoutMs?: number;
  sigkillGraceMs?: number;
}

export function makeExecutorGitCommand(
  options: ExecutorGitCommandOptions = {},
): ExecutorGitCommand {
  const spawnFn = options.spawnFn ?? spawn;
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const sigkillGraceMs = options.sigkillGraceMs ?? GIT_SIGKILL_GRACE_MS;
  return async (input) =>
  await new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      ...(input.authorizationHeader === undefined
        ? {}
        : {
            DELIVERY_GIT_AUTH_HEADER: input.authorizationHeader,
          }),
    };
    const args = input.authorizationHeader === undefined
      ? [...input.args]
      : [
          '--config-env=http.extraHeader=DELIVERY_GIT_AUTH_HEADER',
          '-c', 'http.followRedirects=false',
          '-c', 'protocol.version=2',
          ...input.args,
        ];
    const child = spawnFn('git', args, {
      cwd: input.repositoryPath,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      // Own process group so we can signal git AND its network helper
      // subprocesses together; a bare child.kill only signals the parent.
      detached: true,
    });
    let stdout = '';
    let size = 0;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    // Signal the whole process group (negative pid). Falls back to the bare
    // child if the group signal fails (e.g. pid unavailable). Never throws.
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Child already gone / unsignalable — nothing to do.
        }
      }
    };
    const clearTimers = (): void => {
      clearTimeout(deadlineTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    // Guarantees the Promise settles exactly once even if the child never emits
    // `close` (a wedged, unkillable git helper) — the timeout path resolves with
    // a nonzero exit so the caller treats it as a failed git command.
    const settle = (result: ExecutorGitCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };
    const onDeadline = (): void => {
      signalGroup('SIGTERM');
      // Escalate to SIGKILL if SIGTERM did not produce a `close` in time, then
      // settle regardless so the await can never hang forever.
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        settle({ exitCode: 1, stdout });
      }, sigkillGraceMs);
    };
    const deadlineTimer = setTimeout(onDeadline, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_OUTPUT_BYTES) signalGroup('SIGTERM');
      else stdout += chunk;
    });
    child.once('error', (error) => {
      fail(error);
    });
    child.once('close', (code) => {
      settle({ exitCode: size > MAX_OUTPUT_BYTES ? 1 : code ?? 1, stdout });
    });
  });
}

/** Production git command: real spawn, 2-minute deadline, SIGKILL escalation. */
export const runExecutorGitCommand: ExecutorGitCommand = makeExecutorGitCommand();

async function validExistingCheckout(
  repositoryPath: string,
  repositoryUrl: string,
  checkoutSha: string,
  runGit: ExecutorGitCommand,
): Promise<boolean> {
  const [head, status, remote] = await Promise.all([
    runGit({ repositoryPath, args: ['rev-parse', '--verify', 'HEAD'] }),
    runGit({ repositoryPath, args: ['status', '--porcelain=v1', '--untracked-files=all'] }),
    runGit({ repositoryPath, args: ['remote', 'get-url', 'origin'] }),
  ]);
  return head.exitCode === 0 && head.stdout.trim() === checkoutSha &&
    status.exitCode === 0 && status.stdout === '' &&
    remote.exitCode === 0 && remote.stdout.trim() === repositoryUrl;
}

/** Materializes one exact commit without exposing the upstream GitHub credential. */
export async function checkoutExecutorRepository(input: {
  controlPlaneUrl: string;
  attemptId: string;
  executionId: string;
  attemptToken: string;
  role?: 'work' | 'publisher';
  checkoutSha: string;
  repositoryPath: string;
  runGit?: ExecutorGitCommand;
}): Promise<void> {
  if (
    !ID_PATTERN.test(input.attemptId) || !ID_PATTERN.test(input.executionId) ||
    !SHA_PATTERN.test(input.checkoutSha) || input.attemptToken.length < 1 ||
    input.attemptToken.length > 4_096
  ) throw new ExecutorRepositoryCheckoutError();
  let origin: URL;
  try {
    origin = new URL(input.controlPlaneUrl);
  } catch {
    throw new ExecutorRepositoryCheckoutError();
  }
  if (
    (origin.protocol !== 'https:' &&
      origin.origin !== 'http://control.delivery-loop.internal') ||
    origin.username !== '' || origin.password !== '' ||
    origin.pathname !== '/' || origin.search !== '' || origin.hash !== ''
  ) throw new ExecutorRepositoryCheckoutError();
  const repositoryUrl = new URL(
    `/v1/attempts/${encodeURIComponent(input.attemptId)}/${
      input.role === 'publisher' ? 'executor-publisher/repository.git' : 'repository.git'
    }`,
    origin,
  ).toString();
  const runGit = input.runGit ?? runExecutorGitCommand;
  try {
    await mkdir(input.repositoryPath, { recursive: true, mode: 0o700 });
    const metadata = await lstat(input.repositoryPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ExecutorRepositoryCheckoutError();
    }
    const entries = await readdir(input.repositoryPath);
    if (entries.includes('.git')) {
      if (await validExistingCheckout(
        input.repositoryPath,
        repositoryUrl,
        input.checkoutSha,
        runGit,
      )) return;
      throw new ExecutorRepositoryCheckoutError();
    }
    if (entries.length !== 0) throw new ExecutorRepositoryCheckoutError();
    const init = await runGit({ repositoryPath: input.repositoryPath, args: ['init', '--quiet'] });
    if (init.exitCode !== 0) throw new ExecutorRepositoryCheckoutError();
    const remote = await runGit({
      repositoryPath: input.repositoryPath,
      args: ['remote', 'add', 'origin', repositoryUrl],
    });
    if (remote.exitCode !== 0) throw new ExecutorRepositoryCheckoutError();
    const fetched = await runGit({
      repositoryPath: input.repositoryPath,
      args: [
        'fetch', '--no-tags', '--no-recurse-submodules', '--depth=1',
        'origin', input.checkoutSha,
      ],
      authorizationHeader: `Authorization: Bearer ${input.attemptToken}`,
    });
    if (fetched.exitCode !== 0) throw new ExecutorRepositoryCheckoutError();
    const checkout = await runGit({
      repositoryPath: input.repositoryPath,
      args: ['checkout', '--detach', '--force', input.checkoutSha],
    });
    if (
      checkout.exitCode !== 0 ||
      !await validExistingCheckout(
        input.repositoryPath,
        repositoryUrl,
        input.checkoutSha,
        runGit,
      )
    ) throw new ExecutorRepositoryCheckoutError();
  } catch (error) {
    if (error instanceof ExecutorRepositoryCheckoutError) throw error;
    throw new ExecutorRepositoryCheckoutError();
  }
}
