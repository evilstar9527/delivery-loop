import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir } from 'node:fs/promises';

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const MAX_OUTPUT_BYTES = 1_048_576;
const GIT_TIMEOUT_MS = 2 * 60_000;

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

export const runExecutorGitCommand: ExecutorGitCommand = async (input) =>
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
    const child = spawn('git', args, {
      cwd: input.repositoryPath,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let size = 0;
    const timeout = setTimeout(() => child.kill('SIGTERM'), GIT_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_OUTPUT_BYTES) child.kill('SIGTERM');
      else stdout += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: size > MAX_OUTPUT_BYTES ? 1 : code ?? 1, stdout });
    });
  });

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
    origin.protocol !== 'https:' || origin.username !== '' || origin.password !== '' ||
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
