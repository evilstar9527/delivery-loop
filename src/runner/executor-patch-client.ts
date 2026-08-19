import { z } from 'zod';
import { canonicalSha256, sha256Bytes } from '../domain/digest.js';
import { PatchProposalSchema, type PatchProposal } from '../domain/patch-proposal.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_RESPONSE_BYTES = 1_100_000;

const UploadResponseSchema = z.object({
  schemaVersion: z.literal('1'),
  patchId: z.string().regex(ID_PATTERN),
  workExecutionId: z.string().regex(ID_PATTERN),
  patchRef: z.string().regex(/^r2:\/\/executor-patches\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/),
  patchDigest: z.string().regex(DIGEST_PATTERN),
  changedPathsDigest: z.string().regex(DIGEST_PATTERN),
  byteLength: z.number().int().positive().max(1_048_576),
  created: z.boolean(),
  // The control plane's upload response also carries the scheduled publisher
  // handoff identifiers. The credential-free work lane does not consume them,
  // but the schema must accept them or a successful upload is misread as a
  // failure (stranding the publisher and blocking the run).
  publicationId: z.string().regex(ID_PATTERN).optional(),
  publisherExecutionId: z.string().regex(ID_PATTERN).optional(),
  publisherOutboxId: z.string().regex(ID_PATTERN).optional(),
  targetBranch: z.string().min(1).max(255).optional(),
}).strict();

const PublisherResponseSchema = z.object({
  schemaVersion: z.literal('1'),
  patchId: z.string().regex(ID_PATTERN),
  publicationId: z.string().regex(ID_PATTERN),
  publisherExecutionId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  taskId: z.string().regex(ATTEMPT_ID_PATTERN),
  baseSha: z.string().regex(SHA_PATTERN),
  checkoutSha: z.string().regex(SHA_PATTERN),
  baseBranch: z.string().min(1).max(240),
  targetBranch: z.string().min(1).max(240),
  targetBranchMode: z.enum(['new', 'existing_fast_forward']),
  planVersion: z.number().int().positive(),
  planItemId: z.string().regex(ATTEMPT_ID_PATTERN),
  targetedCommandRefs: z.array(z.string().regex(/^test:[A-Za-z0-9_-]{1,64}$/)).min(1).max(100),
  patchDigest: z.string().regex(DIGEST_PATTERN),
  changedPathsDigest: z.string().regex(DIGEST_PATTERN),
  proposal: PatchProposalSchema,
}).strict();

export class ExecutorPatchClientError extends Error {
  constructor(
    readonly code: 'invalid_config' | 'request_failed' | 'response_rejected' | 'response_invalid',
    readonly status?: number,
  ) {
    super(`Executor patch client failed: ${code}`);
    this.name = 'ExecutorPatchClientError';
  }
}

export interface UploadExecutorWorkPatchInput {
  controlPlaneUrl: string;
  attemptId: string;
  executionId: string;
  attemptToken: string;
  expectedVersion: number;
  leaseGeneration: number;
  proposal: PatchProposal;
}

export interface DownloadExecutorPublisherPatchInput {
  controlPlaneUrl: string;
  attemptId: string;
  executionId: string;
  patchId: string;
}

export type ExecutorWorkPatchUpload = z.infer<typeof UploadResponseSchema>;
export type ExecutorPublisherPatch = z.infer<typeof PublisherResponseSchema>;

function origin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExecutorPatchClientError('invalid_config');
  }
  if (
    (url.protocol !== 'https:' && url.origin !== 'http://control.delivery-loop.internal') ||
    url.username !== '' || url.password !== '' ||
    url.pathname !== '/' || url.search !== '' || url.hash !== ''
  ) throw new ExecutorPatchClientError('invalid_config');
  return url.origin;
}

function validBase(input: {
  attemptId: string;
  executionId: string;
}): void {
  if (!ATTEMPT_ID_PATTERN.test(input.attemptId) || !ID_PATTERN.test(input.executionId)) {
    throw new ExecutorPatchClientError('invalid_config');
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel();
    throw new ExecutorPatchClientError('response_rejected', response.status);
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new ExecutorPatchClientError('response_invalid');
  }
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new ExecutorPatchClientError('response_invalid');
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ExecutorPatchClientError('response_invalid');
  }
}

async function request(
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: 'error' });
  } catch {
    throw new ExecutorPatchClientError('request_failed');
  }
  return await boundedJson(response);
}

export async function uploadExecutorWorkPatch(
  input: UploadExecutorWorkPatchInput,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<ExecutorWorkPatchUpload> {
  validBase(input);
  const parsedProposal = PatchProposalSchema.safeParse(input.proposal);
  if (
    input.attemptToken.length < 1 || input.attemptToken.length > 4_096 ||
    !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
    !Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration <= 0 ||
    !parsedProposal.success
  ) throw new ExecutorPatchClientError('invalid_config');
  const value = await request(
    fetcher,
    `${origin(input.controlPlaneUrl)}/v1/attempts/${encodeURIComponent(input.attemptId)}` +
      '/executor-patches',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${input.attemptToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        schemaVersion: '1',
        workExecutionId: input.executionId,
        expectedVersion: input.expectedVersion,
        leaseGeneration: input.leaseGeneration,
        proposal: parsedProposal.data,
      }),
    },
  );
  const parsed = UploadResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.workExecutionId !== input.executionId) {
    throw new ExecutorPatchClientError('response_invalid');
  }
  return parsed.data;
}

export async function downloadExecutorPublisherPatch(
  input: DownloadExecutorPublisherPatchInput,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<ExecutorPublisherPatch> {
  validBase(input);
  if (!ID_PATTERN.test(input.patchId)) throw new ExecutorPatchClientError('invalid_config');
  const value = await request(
    fetcher,
    `${origin(input.controlPlaneUrl)}/v1/attempts/${encodeURIComponent(input.attemptId)}` +
      `/executor-patches/${encodeURIComponent(input.patchId)}`,
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        // The trusted Executor Worker replaces this only for publisher reads.
        authorization: ['Bearer', 'executor-proxy-placeholder'].join(' '),
      },
    },
  );
  const parsed = PublisherResponseSchema.safeParse(value);
  if (
    !parsed.success || parsed.data.patchId !== input.patchId ||
    parsed.data.publisherExecutionId !== input.executionId
  ) throw new ExecutorPatchClientError('response_invalid');
  const serialized = JSON.stringify(parsed.data.proposal);
  const [patchDigest, changedPathsDigest] = await Promise.all([
    sha256Bytes(new TextEncoder().encode(serialized)),
    canonicalSha256({
      schemaVersion: '1',
      paths: parsed.data.proposal.changes.map((change) => change.path),
    }),
  ]);
  if (
    patchDigest !== parsed.data.patchDigest ||
    changedPathsDigest !== parsed.data.changedPathsDigest
  ) throw new ExecutorPatchClientError('response_invalid');
  return parsed.data;
}
