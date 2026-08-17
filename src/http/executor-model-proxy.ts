import { normalizeProviderBaseUrl } from '../agent/provider-base-url.js';
import type { ExecutorModelGrantAuthorization } from
  '../storage/executor-model-grant-store.js';

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 16 * 1_048_576;

export interface ExecutorModelProxyRuntime {
  provider: string;
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export class ExecutorModelProxyError extends Error {
  constructor(readonly code:
    | 'invalid_request'
    | 'policy_denied'
    | 'provider_unavailable'
    | 'provider_rejected') {
    super(`Executor model proxy failed: ${code}`);
    this.name = 'ExecutorModelProxyError';
  }
}

export function executorModelProxyRuntimeFromEnv(env: {
  EXECUTOR_MODEL_PROVIDER?: string;
  EXECUTOR_MODEL_BASE_URL?: string;
  EXECUTOR_MODEL_API_KEY?: string;
}): ExecutorModelProxyRuntime | null {
  const provider = env.EXECUTOR_MODEL_PROVIDER;
  const baseUrl = env.EXECUTOR_MODEL_BASE_URL;
  const apiKey = env.EXECUTOR_MODEL_API_KEY;
  if (provider === undefined || baseUrl === undefined || apiKey === undefined) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(provider)) return null;
  try {
    return { provider, baseUrl: normalizeProviderBaseUrl(baseUrl)!, apiKey };
  } catch {
    return null;
  }
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) {
    throw new ExecutorModelProxyError('invalid_request');
  }
  let text: string;
  try { text = await request.text(); } catch {
    throw new ExecutorModelProxyError('invalid_request');
  }
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new ExecutorModelProxyError('invalid_request');
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ExecutorModelProxyError('invalid_request');
  }
}

function bounded(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let length = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      length += chunk.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        controller.error(new ExecutorModelProxyError('provider_rejected'));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

/** Exact Responses/SSE relay; provider identity and model are control-plane bindings. */
export async function proxyExecutorModelResponse(input: {
  request: Request;
  authorization: ExecutorModelGrantAuthorization;
  runtime: ExecutorModelProxyRuntime;
}): Promise<Response> {
  const url = new URL(input.request.url);
  if (
    input.request.method !== 'POST' || !url.pathname.endsWith('/executor-model/v1/responses') ||
    url.search !== '' || input.request.headers.get('content-type')?.split(';', 1)[0]
      ?.trim().toLowerCase() !== 'application/json' ||
    input.runtime.provider !== input.authorization.provider ||
    input.runtime.apiKey.length < 1 || input.runtime.apiKey.length > 4_096 ||
    /[\0\r\n]/.test(input.runtime.apiKey)
  ) throw new ExecutorModelProxyError('policy_denied');
  const body = await requestJson(input.request);
  if (body.model !== input.authorization.model || body.stream !== true) {
    throw new ExecutorModelProxyError('policy_denied');
  }
  let baseUrl: string;
  try { baseUrl = normalizeProviderBaseUrl(input.runtime.baseUrl)!; } catch {
    throw new ExecutorModelProxyError('provider_unavailable');
  }
  const target = `${baseUrl.replace(/\/+$/, '')}/responses`;
  let upstream: Response;
  try {
    upstream = await (input.runtime.fetch ?? globalThis.fetch)(target, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${input.runtime.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
  } catch {
    throw new ExecutorModelProxyError('provider_unavailable');
  }
  if (upstream.status !== 200 || upstream.body === null) {
    await upstream.body?.cancel();
    throw new ExecutorModelProxyError(
      upstream.status >= 400 && upstream.status < 500
        ? 'provider_rejected'
        : 'provider_unavailable',
    );
  }
  if (upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
    'text/event-stream') {
    await upstream.body.cancel();
    throw new ExecutorModelProxyError('provider_rejected');
  }
  return new Response(bounded(upstream.body), {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/event-stream',
      'x-content-type-options': 'nosniff',
    },
  });
}
