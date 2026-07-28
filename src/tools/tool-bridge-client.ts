import type { Bindings } from '../env.js';

export type ToolBridgeFailureCategory =
  | 'upstream_error'
  | 'timeout'
  | 'unavailable'
  | 'invalid_response';

export interface ToolBridgeCall {
  traceId: string;
  runId: string;
  attemptId: string;
  toolPath: string;
  arguments: Record<string, unknown>;
}

export type ToolBridgeCallResult =
  | { ok: true; result: unknown }
  | {
      ok: false;
      category: ToolBridgeFailureCategory;
      retryable: boolean;
      /** Untrusted diagnostics may exist in adapters/tests; callers must never persist or return them. */
      unsafeDetail?: unknown;
    };

export interface ToolBridgeClient {
  call(input: ToolBridgeCall): Promise<ToolBridgeCallResult>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1_024;

async function readBoundedResponse(response: Response): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

interface ServiceBindingToolBridgeClientOptions {
  timeoutMs?: number;
  authorizationToken?: string;
}

/**
 * Transport core adapted from Watt's executeToolRequest. This client talks to a
 * tool-bridge service binding, forwards Watt's {arguments} envelope, and only
 * returns fixed failure categories. Upstream error bodies are deliberately not read.
 */
export class ServiceBindingToolBridgeClient implements ToolBridgeClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly service: Fetcher,
    private readonly options: ServiceBindingToolBridgeClientOptions = {},
  ) {
    this.timeoutMs = Math.min(
      DEFAULT_TIMEOUT_MS,
      Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    );
  }

  async call(input: ToolBridgeCall): Promise<ToolBridgeCallResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const headers = new Headers({
      'content-type': 'application/json',
      'x-delivery-trace-id': input.traceId,
      'x-delivery-run-id': input.runId,
      'x-delivery-attempt-id': input.attemptId,
    });
    if (this.options.authorizationToken !== undefined) {
      headers.set('authorization', `Bearer ${this.options.authorizationToken}`);
    }

    try {
      const response = await this.service.fetch(
        `https://tool-bridge.internal/htbp/${input.toolPath}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ arguments: input.arguments }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        return {
          ok: false,
          category: 'upstream_error',
          retryable: response.status === 429 || response.status >= 500,
        };
      }

      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        return { ok: false, category: 'invalid_response', retryable: false };
      }
      const text = await readBoundedResponse(response);
      if (text === null) {
        return { ok: false, category: 'invalid_response', retryable: false };
      }
      try {
        return { ok: true, result: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, category: 'invalid_response', retryable: false };
      }
    } catch {
      return timedOut
        ? { ok: false, category: 'timeout', retryable: true }
        : { ok: false, category: 'unavailable', retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function toolBridgeClientFromEnv(env: Bindings): ToolBridgeClient | null {
  if (env.TOOL_BRIDGE === undefined) return null;
  return new ServiceBindingToolBridgeClient(env.TOOL_BRIDGE, {
    ...(env.TOOL_BRIDGE_INTERNAL_TOKEN === undefined
      ? {}
      : { authorizationToken: env.TOOL_BRIDGE_INTERNAL_TOKEN }),
  });
}
