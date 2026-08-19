import type { ExecutorRepositoryAuthorization } from
  '../storage/executor-repository-authorization-store.js';
import { GITHUB_API_USER_AGENT } from '../github-api.js';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 256 * 1_048_576;

export interface GitHubRepositoryReadTokenProvider {
  getBaseObservationToken(repository: string): Promise<string>;
}

export interface ExecutorPublisherRepositoryAuthorization {
  repository: string;
  checkoutSha: string;
  targetBranch: string;
  targetBranchMode: 'new' | 'existing_fast_forward';
}

export type ExecutorRepositoryProxyErrorCode =
  | 'invalid_request'
  | 'credential_unavailable'
  | 'upstream_unavailable'
  | 'upstream_rejected';

export class ExecutorRepositoryProxyError extends Error {
  constructor(readonly code: ExecutorRepositoryProxyErrorCode) {
    super(`Executor repository proxy failed: ${code}`);
    this.name = 'ExecutorRepositoryProxyError';
  }
}

function gitOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExecutorRepositoryProxyError('upstream_unavailable');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.pathname !== '/' || url.search !== '' || url.hash !== ''
  ) throw new ExecutorRepositoryProxyError('upstream_unavailable');
  return url.origin;
}

async function boundedRequestBody(request: Request): Promise<ArrayBuffer> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) {
    throw new ExecutorRepositoryProxyError('invalid_request');
  }
  const reader = request.body?.getReader();
  if (reader === undefined) throw new ExecutorRepositoryProxyError('invalid_request');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ExecutorRepositoryProxyError('invalid_request');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ExecutorRepositoryProxyError) throw error;
    throw new ExecutorRepositoryProxyError('invalid_request');
  }
  if (length === 0) throw new ExecutorRepositoryProxyError('invalid_request');
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function boundedResponseBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let length = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      length += chunk.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        controller.error(new ExecutorRepositoryProxyError('upstream_rejected'));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

function upstreamAuthorization(token: string): string {
  if (token.length < 1 || token.length > 2_000 || /[\0\r\n]/.test(token)) {
    throw new ExecutorRepositoryProxyError('credential_unavailable');
  }
  return `Basic ${btoa(`x-access-token:${token}`)}`;
}

export function publisherGitToken(authorization: string | undefined): string | null {
  if (authorization === undefined || !authorization.startsWith('Basic ')) return null;
  let decoded: string;
  try {
    decoded = atob(authorization.slice('Basic '.length));
  } catch {
    return null;
  }
  const prefix = 'x-access-token:';
  const token = decoded.startsWith(prefix) ? decoded.slice(prefix.length) : '';
  return token.length > 0 && token.length <= 2_000 && !/[\0\r\n]/.test(token)
    ? token
    : null;
}

const SHALLOW_LINE = /^shallow [0-9a-f]{40}$/;

/**
 * Validate a git receive-pack request restricts the push to exactly the one
 * authorized branch update. The publisher checks out with `--depth=1`, so a
 * shallow clone prefixes its update with one or more `shallow <oid>` pkt-lines
 * before the ref-update command; those are legitimate protocol and must be
 * skipped, but everything else (exactly one command, to the authorized ref,
 * from the expected old-oid, terminated by a flush) stays strict.
 */
function assertPublisherReceivePack(
  body: ArrayBuffer,
  authorization: ExecutorPublisherRepositoryAuthorization,
): void {
  const bytes = new Uint8Array(body);
  const zero = '0'.repeat(40);
  const expectedOld = authorization.targetBranchMode === 'new'
    ? zero
    : authorization.checkoutSha;
  let offset = 0;
  let command: string | null = null;
  // Parse pkt-lines up to the first flush (0000). Skip leading shallow lines;
  // the first non-shallow line must be the sole ref-update command.
  for (;;) {
    if (offset + 4 > bytes.byteLength) {
      throw new ExecutorRepositoryProxyError('invalid_request');
    }
    let header: string;
    try {
      header = new TextDecoder('ascii', { fatal: true }).decode(bytes.slice(offset, offset + 4));
    } catch {
      throw new ExecutorRepositoryProxyError('invalid_request');
    }
    if (!/^[0-9a-f]{4}$/.test(header)) {
      throw new ExecutorRepositoryProxyError('invalid_request');
    }
    const packetLength = Number.parseInt(header, 16);
    if (packetLength === 0) break; // flush-pkt terminates the command list
    if (packetLength < 4 || offset + packetLength > bytes.byteLength) {
      throw new ExecutorRepositoryProxyError('invalid_request');
    }
    let line: string;
    try {
      line = new TextDecoder('utf-8', { fatal: true })
        .decode(bytes.slice(offset + 4, offset + packetLength))
        .split('\0', 1)[0]!
        .trimEnd();
    } catch {
      throw new ExecutorRepositoryProxyError('invalid_request');
    }
    offset += packetLength;
    if (SHALLOW_LINE.test(line)) continue;
    if (command !== null) {
      // A second non-shallow command means more than one ref update.
      throw new ExecutorRepositoryProxyError('invalid_request');
    }
    command = line;
  }
  if (command === null) throw new ExecutorRepositoryProxyError('invalid_request');
  const fields = command.split(' ');
  if (
    fields.length !== 3 || fields[0] !== expectedOld ||
    !/^[a-f0-9]{40}$/.test(fields[1] ?? '') || fields[1] === zero ||
    fields[2] !== `refs/heads/${authorization.targetBranch}`
  ) throw new ExecutorRepositoryProxyError('invalid_request');
}

/** Streams only Git upload-pack for one D1-authorized repository; no credential crosses back. */
export async function proxyExecutorRepositoryRequest(input: {
  request: Request;
  authorization: Pick<ExecutorRepositoryAuthorization, 'repository'>;
  tokenProvider: GitHubRepositoryReadTokenProvider;
  fetch?: typeof globalThis.fetch;
  githubGitOrigin?: string;
}): Promise<Response> {
  const { request, authorization } = input;
  if (!REPOSITORY_PATTERN.test(authorization.repository)) {
    throw new ExecutorRepositoryProxyError('invalid_request');
  }
  const source = new URL(request.url);
  const suffix = source.pathname.endsWith('/info/refs')
    ? 'info/refs'
    : source.pathname.endsWith('/git-upload-pack')
      ? 'git-upload-pack'
      : null;
  const isAdvertisement = request.method === 'GET' && suffix === 'info/refs';
  const isUpload = request.method === 'POST' && suffix === 'git-upload-pack';
  if (
    (!isAdvertisement && !isUpload) ||
    (isAdvertisement && source.search !== '?service=git-upload-pack') ||
    (isUpload && source.search !== '') ||
    request.headers.get('git-protocol') !== 'version=2'
  ) throw new ExecutorRepositoryProxyError('invalid_request');
  if (
    isUpload &&
    request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
      'application/x-git-upload-pack-request'
  ) throw new ExecutorRepositoryProxyError('invalid_request');

  let token: string;
  try {
    token = await input.tokenProvider.getBaseObservationToken(authorization.repository);
  } catch {
    throw new ExecutorRepositoryProxyError('credential_unavailable');
  }
  const [owner, repository] = authorization.repository.split('/');
  const target = new URL(
    `/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}.git/${suffix!}`,
    gitOrigin(input.githubGitOrigin ?? 'https://github.com'),
  );
  if (isAdvertisement) target.search = 'service=git-upload-pack';
  const headers = new Headers({
    accept: isAdvertisement
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-upload-pack-result',
    authorization: upstreamAuthorization(token),
    'user-agent': GITHUB_API_USER_AGENT,
  });
  const gitProtocol = request.headers.get('git-protocol');
  if (gitProtocol !== null) headers.set('git-protocol', gitProtocol);
  let body: ArrayBuffer | undefined;
  if (isUpload) {
    body = await boundedRequestBody(request);
    headers.set('content-type', 'application/x-git-upload-pack-request');
  }
  let upstream: Response;
  try {
    upstream = await (input.fetch ?? globalThis.fetch)(target, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
    });
  } catch {
    throw new ExecutorRepositoryProxyError('upstream_unavailable');
  }
  if (upstream.status !== 200 || upstream.body === null) {
    await upstream.body?.cancel();
    throw new ExecutorRepositoryProxyError(
      upstream.status === 401 || upstream.status === 403 || upstream.status === 404
        ? 'upstream_rejected'
        : 'upstream_unavailable',
    );
  }
  const expectedType = isAdvertisement
    ? 'application/x-git-upload-pack-advertisement'
    : 'application/x-git-upload-pack-result';
  if (upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== expectedType) {
    await upstream.body.cancel();
    throw new ExecutorRepositoryProxyError('upstream_rejected');
  }
  const declared = upstream.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await upstream.body.cancel();
    throw new ExecutorRepositoryProxyError('upstream_rejected');
  }
  return new Response(boundedResponseBody(upstream.body), {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': expectedType,
      'x-content-type-options': 'nosniff',
    },
  });
}

/** Push PEP: the one-time token is accepted only for the frozen branch command. */
export async function proxyExecutorPublisherRepositoryWrite(input: {
  request: Request;
  authorization: ExecutorPublisherRepositoryAuthorization;
  token: string;
  fetch?: typeof globalThis.fetch;
  githubGitOrigin?: string;
}): Promise<Response> {
  if (!REPOSITORY_PATTERN.test(input.authorization.repository)) {
    throw new ExecutorRepositoryProxyError('invalid_request');
  }
  const source = new URL(input.request.url);
  const suffix = source.pathname.endsWith('/info/refs')
    ? 'info/refs'
    : source.pathname.endsWith('/git-receive-pack')
      ? 'git-receive-pack'
      : null;
  const isAdvertisement = input.request.method === 'GET' && suffix === 'info/refs';
  const isReceive = input.request.method === 'POST' && suffix === 'git-receive-pack';
  const protocol = input.request.headers.get('git-protocol');
  if (
    (!isAdvertisement && !isReceive) ||
    (isAdvertisement && source.search !== '?service=git-receive-pack') ||
    (isReceive && source.search !== '') ||
    (protocol !== null && protocol !== 'version=2') ||
    input.request.headers.has('content-encoding') ||
    (isReceive && input.request.headers.get('content-type')?.split(';', 1)[0]
      ?.trim().toLowerCase() !== 'application/x-git-receive-pack-request')
  ) throw new ExecutorRepositoryProxyError('invalid_request');
  const [owner, repository] = input.authorization.repository.split('/');
  const target = new URL(
    `/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}.git/${suffix!}`,
    gitOrigin(input.githubGitOrigin ?? 'https://github.com'),
  );
  if (isAdvertisement) target.search = 'service=git-receive-pack';
  const headers = new Headers({
    accept: isAdvertisement
      ? 'application/x-git-receive-pack-advertisement'
      : 'application/x-git-receive-pack-result',
    authorization: upstreamAuthorization(input.token),
    'user-agent': GITHUB_API_USER_AGENT,
  });
  if (protocol !== null) headers.set('git-protocol', protocol);
  let body: ArrayBuffer | undefined;
  if (isReceive) {
    body = await boundedRequestBody(input.request);
    assertPublisherReceivePack(body, input.authorization);
    headers.set('content-type', 'application/x-git-receive-pack-request');
  }
  let upstream: Response;
  try {
    upstream = await (input.fetch ?? globalThis.fetch)(target, {
      method: input.request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
    });
  } catch {
    throw new ExecutorRepositoryProxyError('upstream_unavailable');
  }
  if (upstream.status !== 200 || upstream.body === null) {
    await upstream.body?.cancel();
    throw new ExecutorRepositoryProxyError(
      [401, 403, 404].includes(upstream.status) ? 'upstream_rejected' : 'upstream_unavailable',
    );
  }
  const expectedType = isAdvertisement
    ? 'application/x-git-receive-pack-advertisement'
    : 'application/x-git-receive-pack-result';
  if (upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== expectedType) {
    await upstream.body.cancel();
    throw new ExecutorRepositoryProxyError('upstream_rejected');
  }
  const declared = upstream.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await upstream.body.cancel();
    throw new ExecutorRepositoryProxyError('upstream_rejected');
  }
  return new Response(boundedResponseBody(upstream.body), {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': expectedType,
      'x-content-type-options': 'nosniff',
    },
  });
}
