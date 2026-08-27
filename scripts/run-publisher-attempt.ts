import { readFile, writeFile } from 'node:fs/promises';
import {
  ExecutorPatchClientError,
  downloadExecutorPublisherPatch,
  type ExecutorPublisherPatch,
} from '../src/runner/executor-patch-client.js';
import { loadDeliveryPolicyAtCommit } from '../src/runner/delivery-policy-loader.js';
import {
  ControlPlaneExecutorPublisherCompletionReporter,
  ExecutorPublisherHeadReporter,
  ExecutorPublisherVerificationReporter,
  requestExecutorPublisherCredential,
} from '../src/runner/executor-publisher-client.js';
import {
  ExecutorPublisherRunner,
  ExecutorPublisherRunnerError,
} from '../src/runner/executor-publisher-runner.js';
import { checkoutExecutorRepository } from '../src/runner/executor-repository-checkout.js';

const PATCH_PATH = '/workspace/.delivery-loop/publisher-patch.json';
const RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;

export class PublisherAttemptError extends Error {
  constructor(readonly code:
    | 'publisher_configuration_invalid'
    | 'publisher_patch_unavailable'
    | 'publisher_patch_conflict'
    | 'publisher_runtime_failed',
    readonly runnerCode?: string) {
    super(`Publisher attempt failed: ${code}${runnerCode === undefined ? '' : `:${runnerCode}`}`);
    this.name = 'PublisherAttemptError';
  }
}

// Distinct process exit codes per publisher failure step. The executor records
// the container exit code in executor_observations (readable in D1), so a
// non-zero code below tells an operator exactly which step failed without any
// new reporting endpoint or relying on sandbox stderr.
const PUBLISHER_EXIT_CODES: Record<string, number> = {
  invalid_context: 10,
  checkout_failed: 11,
  setup_failed: 12,
  patch_failed: 13,
  commit_failed: 14,
  push_failed: 15,
  head_report_failed: 16,
  verification_failed: 17,
  completion_failed: 18,
};

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (value === undefined || value.length === 0) {
    throw new PublisherAttemptError('publisher_configuration_invalid');
  }
  return value;
}

export async function downloadPublisherPatch(
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  wait: (milliseconds: number) => Promise<void> = async (milliseconds) =>
    await new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<ExecutorPublisherPatch> {
  const input = {
    controlPlaneUrl: required(environment, 'DELIVERY_CONTROL_PLANE_URL'),
    attemptId: required(environment, 'DELIVERY_ATTEMPT_ID'),
    executionId: required(environment, 'DELIVERY_EXECUTION_ID'),
    patchId: required(environment, 'DELIVERY_PATCH_ARTIFACT_ID'),
  };
  let lastError: unknown;
  for (const delay of [0, ...RETRY_DELAYS_MS]) {
    if (delay > 0) await wait(delay);
    try {
      return await downloadExecutorPublisherPatch(input, fetcher);
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof ExecutorPatchClientError) ||
        (error.code !== 'request_failed' &&
          !(error.code === 'response_rejected' &&
            error.status !== undefined && [401, 409, 503].includes(error.status)))
      ) break;
    }
  }
  if (lastError instanceof ExecutorPatchClientError && lastError.code === 'response_invalid') {
    throw new PublisherAttemptError('publisher_patch_conflict');
  }
  throw new PublisherAttemptError('publisher_patch_unavailable');
}

async function persistExactPatch(patch: ExecutorPublisherPatch): Promise<void> {
  const serialized = JSON.stringify(patch.proposal);
  try {
    await writeFile(PATCH_PATH, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return;
  } catch {
    let existing: string;
    try {
      existing = await readFile(PATCH_PATH, 'utf8');
    } catch {
      throw new PublisherAttemptError('publisher_patch_conflict');
    }
    if (existing !== serialized) throw new PublisherAttemptError('publisher_patch_conflict');
  }
}

export async function runPublisherAttempt(
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const patch = await downloadPublisherPatch(environment, fetcher);
  if (
    patch.repository !== required(environment, 'DELIVERY_TARGET_REPOSITORY') ||
    patch.checkoutSha !== required(environment, 'DELIVERY_CHECKOUT_SHA')
  ) throw new PublisherAttemptError('publisher_patch_conflict');
  await persistExactPatch(patch);
  const controlPlaneUrl = required(environment, 'DELIVERY_CONTROL_PLANE_URL');
  const attemptId = required(environment, 'DELIVERY_ATTEMPT_ID');
  const executionId = required(environment, 'DELIVERY_EXECUTION_ID');
  const repositoryPath = required(environment, 'DELIVERY_REPOSITORY_PATH');
  const checkout = async (): Promise<void> => await checkoutExecutorRepository({
    controlPlaneUrl,
    attemptId,
    executionId,
    attemptToken: 'executor-proxy-placeholder',
    role: 'publisher',
    checkoutSha: patch.checkoutSha,
    repositoryPath,
  });
  try {
    await checkout();
    const deliveryPolicy = await loadDeliveryPolicyAtCommit(repositoryPath, patch.checkoutSha);
    const context = {
      controlPlaneUrl,
      attemptId,
      publisherExecutionId: executionId,
      publicationId: patch.publicationId,
    };
    const credential = await requestExecutorPublisherCredential({
      ...context,
      repository: patch.repository,
      targetBranch: patch.targetBranch,
    }, fetcher);
    await new ExecutorPublisherRunner({
      repositoryPath,
      repository: patch.repository,
      taskId: patch.taskId,
      attemptId,
      publisherExecutionId: executionId,
      publicationId: patch.publicationId,
      checkoutSha: patch.checkoutSha,
      baseBranch: patch.baseBranch,
      targetBranch: patch.targetBranch,
      targetBranchMode: patch.targetBranchMode,
      planVersion: patch.planVersion,
      planItemId: patch.planItemId,
      targetedCommandRefs: patch.targetedCommandRefs,
      requiredVerifyCommandRefs: patch.requiredVerifyCommandRefs,
      deliveryPolicy,
      proposal: patch.proposal,
      patchDigest: patch.patchDigest,
      credential,
    }, {
      checkout,
      headReporter: new ExecutorPublisherHeadReporter(context, fetcher),
      evidenceReporter: new ExecutorPublisherVerificationReporter(context, fetcher),
      completionReporter: new ControlPlaneExecutorPublisherCompletionReporter(context, fetcher),
    }).run();
  } catch (error) {
    // Preserve the specific publisher failure step. The generic
    // 'publisher_runtime_failed' erased which step failed (checkout/setup/patch/
    // commit/push/verification), and publisher stderr does not reach D1 — so the
    // step was invisible. Carry the specific kind out to the exit handler, which
    // maps it to a distinct process exit code the executor records in
    // executor_observations (a readable D1 signal without a new endpoint).
    if (error instanceof ExecutorPublisherRunnerError) {
      throw new PublisherAttemptError('publisher_runtime_failed', error.code);
    }
    throw new PublisherAttemptError('publisher_runtime_failed');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPublisherAttempt().catch((error: unknown) => {
    const code = error instanceof PublisherAttemptError
      ? error.code
      : 'publisher_patch_unavailable';
    const runnerCode = error instanceof PublisherAttemptError ? error.runnerCode : undefined;
    process.stderr.write(
      `delivery publisher failed: ${code}${runnerCode === undefined ? '' : `:${runnerCode}`}\n`,
    );
    process.exitCode = runnerCode !== undefined && runnerCode in PUBLISHER_EXIT_CODES
      ? PUBLISHER_EXIT_CODES[runnerCode]
      : 1;
  });
}
