import { z } from 'zod';
import {
  VerificationCommandResultV1Schema,
  VerificationSuiteManifestV1Schema,
  verificationSuiteCommands,
  type VerificationCommandResultV1,
  type VerificationSuiteCommand,
  type VerificationSuiteManifestV1,
} from '../domain/verification-evidence.js';
import type { GitRepositoryWriteCredential } from './git-repository-writer.js';
import type {
  ExecutorPublisherCompletionReporter,
} from './executor-publisher-runner.js';
import type { VerificationEvidenceReporter } from './verification-execution-runner.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_RESPONSE_BYTES = 64 * 1_024;

const CredentialResponseSchema = z.object({
  credentialId: z.string().regex(ID_PATTERN),
  publicationId: z.string().regex(ID_PATTERN),
  publisherExecutionId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  targetBranch: z.string().min(1).max(240),
  approvalId: z.string().regex(ID_PATTERN),
  token: z.string().min(1).max(2_000),
  expiresAt: z.iso.datetime({ offset: true }),
  permissions: z.object({
    contents: z.literal('write'),
    pullRequests: z.literal('write'),
  }).strict(),
  created: z.boolean(),
}).strict();

const HeadResponseSchema = z.object({
  updateId: z.string().regex(ATTEMPT_ID_PATTERN),
  evidenceId: z.string().regex(ATTEMPT_ID_PATTERN),
  created: z.boolean(),
  version: z.number().int().nonnegative(),
  leaseGeneration: z.number().int().positive(),
  parentSha: z.string().regex(/^[a-f0-9]{40}$/),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  branch: z.string().min(1).max(240),
}).strict();

const SuiteResponseSchema = z.object({
  suiteId: z.string().regex(ATTEMPT_ID_PATTERN),
  created: z.boolean(),
  status: z.enum(['running', 'failed', 'completed']),
  commands: z.array(z.object({
    position: z.number().int().nonnegative().max(99),
    phase: z.enum(['targeted', 'required_verify']),
    commandRef: z.string().min(1).max(80),
  }).strict()).min(2).max(100),
}).strict();

const EvidenceResponseSchema = z.object({
  evidenceId: z.string().regex(ATTEMPT_ID_PATTERN),
  created: z.boolean(),
  suiteStatus: z.enum(['running', 'failed', 'completed']),
}).strict();

const CompletionResponseSchema = z.object({ accepted: z.literal(true) }).strict();

export class ExecutorPublisherClientError extends Error {
  constructor() {
    super('Executor publisher control-plane request failed');
    this.name = 'ExecutorPublisherClientError';
  }
}

export interface ExecutorPublisherClientContext {
  controlPlaneUrl: string;
  attemptId: string;
  publisherExecutionId: string;
  publicationId: string;
}

function endpoint(context: ExecutorPublisherClientContext, suffix: string): string {
  let origin: URL;
  try {
    origin = new URL(context.controlPlaneUrl);
  } catch {
    throw new ExecutorPublisherClientError();
  }
  if (
    (origin.protocol !== 'https:' &&
      origin.origin !== 'http://control.delivery-loop.internal') ||
    origin.username !== '' || origin.password !== '' ||
    origin.pathname !== '/' || origin.search !== '' || origin.hash !== '' ||
    !ATTEMPT_ID_PATTERN.test(context.attemptId) ||
    !ID_PATTERN.test(context.publisherExecutionId) || !ID_PATTERN.test(context.publicationId)
  ) throw new ExecutorPublisherClientError();
  return new URL(
    `/v1/attempts/${encodeURIComponent(context.attemptId)}/executor-publisher/${suffix}`,
    origin,
  ).toString();
}

async function post(
  fetcher: typeof globalThis.fetch,
  url: string,
  body: unknown,
  statuses: readonly number[],
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: ['Bearer', 'executor-proxy-placeholder'].join(' '),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
    });
  } catch {
    throw new ExecutorPublisherClientError();
  }
  if (
    !statuses.includes(response.status) ||
    !response.headers.get('cache-control')?.toLowerCase().includes('no-store')
  ) {
    await response.body?.cancel();
    throw new ExecutorPublisherClientError();
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ExecutorPublisherClientError();
  }
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new ExecutorPublisherClientError();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ExecutorPublisherClientError();
  }
}

export async function requestExecutorPublisherCredential(
  context: ExecutorPublisherClientContext & { repository: string; targetBranch: string },
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<GitRepositoryWriteCredential> {
  const parsed = CredentialResponseSchema.safeParse(await post(
    fetcher,
    endpoint(context, 'write-token'),
    { publicationId: context.publicationId },
    [200, 201],
  ));
  if (
    !parsed.success || parsed.data.publicationId !== context.publicationId ||
    parsed.data.publisherExecutionId !== context.publisherExecutionId ||
    parsed.data.repository !== context.repository || parsed.data.targetBranch !== context.targetBranch ||
    Date.parse(parsed.data.expiresAt) <= Date.now()
  ) throw new ExecutorPublisherClientError();
  return {
    credentialId: parsed.data.credentialId,
    repository: parsed.data.repository,
    approvalId: parsed.data.approvalId,
    token: parsed.data.token,
    expiresAt: parsed.data.expiresAt,
    permissions: parsed.data.permissions,
  };
}

export class ExecutorPublisherHeadReporter {
  private readonly url: string;

  constructor(
    private readonly context: ExecutorPublisherClientContext,
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.url = endpoint(context, 'head');
  }

  async record(input: { parentSha: string; headSha: string; branch: string }): Promise<void> {
    const parsed = HeadResponseSchema.safeParse(await post(this.fetcher, this.url, {
      publicationId: this.context.publicationId,
      ...input,
    }, [200, 201]));
    if (
      !parsed.success || parsed.data.parentSha !== input.parentSha ||
      parsed.data.headSha !== input.headSha || parsed.data.branch !== input.branch
    ) throw new ExecutorPublisherClientError();
  }
}

export class ExecutorPublisherVerificationReporter implements VerificationEvidenceReporter {
  private readonly url: string;

  constructor(
    private readonly context: ExecutorPublisherClientContext,
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.url = endpoint(context, 'verifications');
  }

  async start(manifest: VerificationSuiteManifestV1): Promise<{
    suiteId: string;
    created: boolean;
    status: 'running' | 'failed' | 'completed';
    commands: VerificationSuiteCommand[];
  }> {
    const valid = VerificationSuiteManifestV1Schema.safeParse(manifest);
    if (!valid.success) throw new ExecutorPublisherClientError();
    const parsed = SuiteResponseSchema.safeParse(await post(this.fetcher, this.url, {
      publicationId: this.context.publicationId,
      manifest: valid.data,
    }, [200, 201]));
    const expected = verificationSuiteCommands(valid.data);
    if (
      !parsed.success || parsed.data.commands.length !== expected.length ||
      parsed.data.commands.some((command, index) =>
        command.position !== expected[index]?.position ||
        command.phase !== expected[index]?.phase ||
        command.commandRef !== expected[index]?.commandRef)
    ) throw new ExecutorPublisherClientError();
    return parsed.data;
  }

  async record(suiteId: string, result: VerificationCommandResultV1): Promise<{
    evidenceId: string;
    created: boolean;
    suiteStatus: 'running' | 'failed' | 'completed';
  }> {
    const valid = VerificationCommandResultV1Schema.safeParse(result);
    if (!ATTEMPT_ID_PATTERN.test(suiteId) || !valid.success) {
      throw new ExecutorPublisherClientError();
    }
    const parsed = EvidenceResponseSchema.safeParse(await post(
      this.fetcher,
      `${this.url}/${encodeURIComponent(suiteId)}/results`,
      { publicationId: this.context.publicationId, result: valid.data },
      [200, 201],
    ));
    if (!parsed.success) throw new ExecutorPublisherClientError();
    return parsed.data;
  }
}

export class ControlPlaneExecutorPublisherCompletionReporter
implements ExecutorPublisherCompletionReporter {
  private readonly url: string;

  constructor(
    private readonly context: ExecutorPublisherClientContext,
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.url = endpoint(context, 'complete');
  }

  async complete(input: Parameters<ExecutorPublisherCompletionReporter['complete']>[0]): Promise<void> {
    if (
      input.publicationId !== this.context.publicationId ||
      input.publisherExecutionId !== this.context.publisherExecutionId
    ) throw new ExecutorPublisherClientError();
    const parsed = CompletionResponseSchema.safeParse(await post(this.fetcher, this.url, {
      publicationId: input.publicationId,
      recomputedPatchDigest: input.recomputedPatchDigest,
      headSha: input.headSha,
      branch: input.branch,
      suiteId: input.suiteId,
      evidenceIds: input.evidenceIds,
    }, [200]));
    if (!parsed.success) throw new ExecutorPublisherClientError();
  }
}
