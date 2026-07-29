import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { TaskEnvelopeSchema } from '../src/domain/task.js';
import { SecretScanner } from '../src/security/redaction.js';
import {
  WorkflowHibernateLiveWindowError,
  WorkflowHibernateWindowAuthorizationV1Schema,
  executeWorkflowHibernateLiveWindow,
  resumeWorkflowHibernateLiveWindow,
} from '../src/pilot/workflow-hibernate-live-window.js';
import { createWorkflowHibernateLiveWindowDependencies } from
  '../src/pilot/workflow-hibernate-live-adapters.js';
import { WorkflowHibernateWindowGuardError } from
  '../src/pilot/workflow-hibernate-window-guard.js';

const MAX_INPUT_BYTES = 64 * 1_024;

class WindowInputError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid') { super(kind); }
}

function textEnv(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function secretEnv(name: string): string {
  return process.env[name] ?? '';
}

function outsideRepository(path: string, repositoryRoot: string): boolean {
  const relation = relative(repositoryRoot, path);
  return relation === '..' || relation.startsWith('../') || isAbsolute(relation);
}

async function jsonInput(
  path: string,
  repositoryRoot: string,
  scanner: SecretScanner,
): Promise<unknown> {
  if (!isAbsolute(path)) {
    throw new WindowInputError('invalid');
  }
  let lexicalMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    lexicalMetadata = await lstat(path);
  } catch { throw new WindowInputError('unavailable'); }
  if (lexicalMetadata.isSymbolicLink()) throw new WindowInputError('invalid');
  let canonicalPath: string;
  try { canonicalPath = await realpath(path); }
  catch { throw new WindowInputError('unavailable'); }
  if (!outsideRepository(canonicalPath, repositoryRoot)) throw new WindowInputError('invalid');
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new WindowInputError('invalid'); }
  let metadata: Awaited<ReturnType<typeof handle.stat>>;
  let source: string;
  try {
    metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_INPUT_BYTES) {
      throw new WindowInputError('invalid');
    }
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_INPUT_BYTES) throw new WindowInputError('invalid');
    source = buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
  if (
    (metadata.mode & 0o077) !== 0 || Buffer.byteLength(source, 'utf8') > MAX_INPUT_BYTES ||
    scanner.scanText(source, '$.input').length > 0
  ) throw new WindowInputError('invalid');
  try { return JSON.parse(source) as unknown; }
  catch { throw new WindowInputError('invalid'); }
}

async function main(): Promise<void> {
  // Watt-derived boundary: explicit opt-in, external bounded files and fixed 0/1/2 exits.
  if (process.env.DELIVERY_LOOP_WORKFLOW_HIBERNATE_WINDOW !== '1') {
    console.error(
      'workflow-hibernate-window: opt-in missing ' +
      '(set DELIVERY_LOOP_WORKFLOW_HIBERNATE_WINDOW=1)',
    );
    process.exitCode = 2;
    return;
  }
  const values = {
    authorizationFile: textEnv('WORKFLOW_HIBERNATE_WINDOW_AUTHORIZATION_FILE'),
    taskFile: textEnv('WORKFLOW_HIBERNATE_WINDOW_TASK_FILE'),
    sourceDirectory: textEnv('WORKFLOW_HIBERNATE_WINDOW_SOURCE_DIRECTORY'),
    wranglerBinary: textEnv('WORKFLOW_HIBERNATE_WINDOW_WRANGLER_BINARY'),
    controlPlaneOrigin: textEnv('WORKFLOW_HIBERNATE_WINDOW_CONTROL_PLANE_URL'),
    taskToken: secretEnv('WORKFLOW_HIBERNATE_WINDOW_TASK_TOKEN'),
    operationsToken: secretEnv('WORKFLOW_HIBERNATE_WINDOW_OPERATIONS_TOKEN'),
    githubToken: secretEnv('WORKFLOW_HIBERNATE_WINDOW_GITHUB_TOKEN'),
    cloudflareReadToken: secretEnv('WORKFLOW_HIBERNATE_WINDOW_CLOUDFLARE_READ_TOKEN'),
    cloudflareDeployToken: secretEnv('WORKFLOW_HIBERNATE_WINDOW_CLOUDFLARE_DEPLOY_TOKEN'),
    cloudflareAccountId: textEnv('WORKFLOW_HIBERNATE_WINDOW_CLOUDFLARE_ACCOUNT_ID'),
  };
  if (Object.values(values).some((value) => value === '')) {
    console.error('workflow-hibernate-window: required production configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  const repositoryRoot = await realpath(resolve('.'));
  const scanner = new SecretScanner({ secrets: [
    values.taskToken,
    values.operationsToken,
    values.githubToken,
    values.cloudflareReadToken,
    values.cloudflareDeployToken,
  ] });
  let authorizationRaw: unknown;
  let taskRaw: unknown;
  try {
    [authorizationRaw, taskRaw] = await Promise.all([
      jsonInput(values.authorizationFile, repositoryRoot, scanner),
      jsonInput(values.taskFile, repositoryRoot, scanner),
    ]);
  } catch (error) {
    const kind = error instanceof WindowInputError ? error.kind : 'invalid';
    console.error(`workflow-hibernate-window: production input is ${kind}`);
    process.exitCode = kind === 'unavailable' ? 2 : 1;
    return;
  }
  const authorization = WorkflowHibernateWindowAuthorizationV1Schema.safeParse(authorizationRaw);
  const task = TaskEnvelopeSchema.safeParse(taskRaw);
  if (!authorization.success || !task.success) {
    console.error('workflow-hibernate-window: production input is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const execute = authorization.data.resumeExistingTask === true
      ? resumeWorkflowHibernateLiveWindow
      : executeWorkflowHibernateLiveWindow;
    const summary = await execute(
      authorization.data,
      task.data,
      createWorkflowHibernateLiveWindowDependencies({
        sourceDirectory: values.sourceDirectory,
        wranglerBinary: values.wranglerBinary,
        controlPlaneOrigin: values.controlPlaneOrigin,
        taskToken: values.taskToken,
        operationsToken: values.operationsToken,
        githubToken: values.githubToken,
        cloudflareReadToken: values.cloudflareReadToken,
        cloudflareDeployToken: values.cloudflareDeployToken,
        cloudflareAccountId: values.cloudflareAccountId,
        ...(textEnv('WORKFLOW_HIBERNATE_WINDOW_GITHUB_API_URL') === ''
          ? {} : { githubApiOrigin: textEnv('WORKFLOW_HIBERNATE_WINDOW_GITHUB_API_URL') }),
        ...(textEnv('WORKFLOW_HIBERNATE_WINDOW_CLOUDFLARE_API_URL') === ''
          ? {} : { cloudflareApiOrigin: textEnv('WORKFLOW_HIBERNATE_WINDOW_CLOUDFLARE_API_URL') }),
      }),
    );
    const output = JSON.stringify(summary);
    if (scanner.scanText(output, '$.summary').length > 0) {
      throw new WorkflowHibernateLiveWindowError('secret_leak_detected');
    }
    console.log(output);
  } catch (error) {
    const code = error instanceof WorkflowHibernateLiveWindowError ||
      error instanceof WorkflowHibernateWindowGuardError
      ? error.code : 'execution_failed';
    console.error(`workflow-hibernate-window: FAIL ${code}`);
    process.exitCode = code === 'configuration_invalid' ? 2 : 1;
  }
}

await main();
