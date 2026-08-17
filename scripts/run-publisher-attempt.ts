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
import { ExecutorPublisherRunner } from '../src/runner/executor-publisher-runner.js';
import { checkoutExecutorRepository } from '../src/runner/executor-repository-checkout.js';

const PATCH_PATH = '/workspace/.delivery-loop/publisher-patch.json';
const RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;

export class PublisherAttemptError extends Error {
  constructor(readonly code:
    | 'publisher_configuration_invalid'
    | 'publisher_patch_unavailable'
    | 'publisher_patch_conflict'
    | 'publisher_runtime_failed') {
    super(`Publisher attempt failed: ${code}`);
    this.name = 'PublisherAttemptError';
  }
}

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
  } catch {
    throw new PublisherAttemptError('publisher_runtime_failed');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPublisherAttempt().catch((error: unknown) => {
    const code = error instanceof PublisherAttemptError
      ? error.code
      : 'publisher_patch_unavailable';
    process.stderr.write(`delivery publisher failed: ${code}\n`);
    process.exitCode = 1;
  });
}
