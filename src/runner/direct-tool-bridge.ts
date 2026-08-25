import { z } from 'zod';
import { SecretScanner } from '../security/redaction.js';

const MAX_RESPONSE_BYTES = 256 * 1_024;
const DEFAULT_TIMEOUT_MS = 20_000;
const QUERY_WINDOW_MINUTES = 14 * 24 * 60;
const QUERY_LIMIT = 20;
const SLS_TOOL_PATH = '/mcp/tipsy/tipsy-analytics__sls_query_logs';
const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,199}$/;

const LocatorArgumentsSchema = z.object({
  uid: z.string().max(200).default(''),
  cid: z.string().max(200).default(''),
  path: z.string().max(200).default(''),
}).strict().refine((value) => value.uid !== '' || value.cid !== '' || value.path !== '');

const TraceArgumentsSchema = z.object({
  requestId: z.string().regex(TRACE_ID_PATTERN),
}).strict();

export type DirectToolBridgeFailureCategory =
  | 'upstream_error'
  | 'timeout'
  | 'unavailable'
  | 'invalid_response';

export class DirectToolBridgeError extends Error {
  constructor(readonly category: DirectToolBridgeFailureCategory) {
    super(`Direct Tool Bridge call failed: ${category}`);
    this.name = 'DirectToolBridgeError';
  }
}

export interface DirectToolBridgeDiagnosticClientOptions {
  baseUrl: string;
  sk: string;
  logstore: string;
  environment: 'prod' | 'test';
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

function trustedBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Tool Bridge base URL is invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new Error('Tool Bridge base URL is invalid');
  return url.origin;
}

function traceIds(raw: string): string[] {
  const matches = [...raw.matchAll(/trace_id:\s*([A-Za-z0-9][A-Za-z0-9_-]{15,199})\b/g)]
    .map((match) => match[1]!)
    .filter((value) => TRACE_ID_PATTERN.test(value));
  return [...new Set(matches)].slice(0, QUERY_LIMIT);
}

async function boundedJsonString(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new DirectToolBridgeError('invalid_response');
  }
  if (response.body === null) throw new DirectToolBridgeError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new DirectToolBridgeError('invalid_response');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('unexpected response');
    }
    return value;
  } catch (error) {
    if (error instanceof DirectToolBridgeError) throw error;
    throw new DirectToolBridgeError('invalid_response');
  }
}

/** Executor-neutral trusted runtime client. Tool responses never pass through the control plane. */
export class DirectToolBridgeDiagnosticClient {
  private readonly baseUrl: string;
  private readonly sk: string;
  private readonly logstore: string;
  private readonly environment: 'prod' | 'test';
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: DirectToolBridgeDiagnosticClientOptions) {
    this.baseUrl = trustedBaseUrl(options.baseUrl);
    if (options.sk.length < 16 || options.sk.length > 4_096 || /[\0\r\n]/.test(options.sk)) {
      throw new Error('Tool Bridge credential is invalid');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.logstore)) {
      throw new Error('Tool Bridge logstore is invalid');
    }
    this.sk = options.sk;
    this.logstore = options.logstore;
    this.environment = options.environment;
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new Error('Tool Bridge timeout is invalid');
    }
  }

  async searchLogs(argumentsValue: Record<string, unknown>): Promise<unknown> {
    const parsed = LocatorArgumentsSchema.safeParse(argumentsValue);
    if (!parsed.success) throw new DirectToolBridgeError('invalid_response');
    const query = [parsed.data.uid, parsed.data.cid, parsed.data.path]
      .filter((value) => value !== '')
      .join(' AND ');
    const result = await this.query(query);
    // Zero matching trace ids is a valid empty locator result, not a tool
    // failure: the referenced conversation may simply predate the query window,
    // and the raw text ("返回 0 行") still lets the agent conclude that. Only a
    // response that is unreadable, oversized, or reflects the Secret — all
    // rejected in query() — is treated as invalid_response.
    return { schemaVersion: '1', requestIds: traceIds(result), result };
  }

  async getTrace(argumentsValue: Record<string, unknown>): Promise<unknown> {
    const parsed = TraceArgumentsSchema.safeParse(argumentsValue);
    if (!parsed.success) throw new DirectToolBridgeError('invalid_response');
    const result = await this.query(parsed.data.requestId);
    // A trace that is absent from the bounded query window is a valid
    // "not found", not a tool failure — a real bug's conversation is usually
    // older than log retention. The exact-id query means any returned rows
    // full-text match that id, and query() already fails closed on Secret
    // reflection, so handing the result back is safe; the agent reads whether
    // the trace was present and reasons from there.
    return { schemaVersion: '1', requestId: parsed.data.requestId, result };
  }

  private async query(query: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${SLS_TOOL_PATH}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.sk}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          logstore: this.logstore,
          query,
          minutes_ago: QUERY_WINDOW_MINUTES,
          limit: QUERY_LIMIT,
          env: this.environment,
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DirectToolBridgeError(
        error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'unavailable',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DirectToolBridgeError('upstream_error');
    }
    const result = await boundedJsonString(response);
    if (new SecretScanner({ secrets: [this.sk] }).scanText(result, '$.result').length > 0) {
      throw new DirectToolBridgeError('invalid_response');
    }
    return result;
  }
}
