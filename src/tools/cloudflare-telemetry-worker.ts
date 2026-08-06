import { Hono } from 'hono';
import { z } from 'zod';
import { SecretScanner } from '../security/redaction.js';

const MAX_RESPONSE_BYTES = 256 * 1_024;
const QUERY_WINDOW_MS = 24 * 60 * 60_000;
const QUERY_LIMIT = 5;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

interface TelemetryBindings {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_OBSERVABILITY_TOKEN: string;
  TELEMETRY_SOURCE_SERVICE: string;
  TOOL_BRIDGE_INTERNAL_TOKEN: string;
}

interface TelemetryWorkerOptions {
  fetcher?: typeof fetch;
  now?: () => Date;
}

const EnvelopeSchema = z.object({
  arguments: z.record(z.string(), z.json()),
}).strict();

const LogArgumentsSchema = z.object({
  uid: z.string().regex(ID_PATTERN).optional(),
  cid: z.string().regex(ID_PATTERN).optional(),
  path: z.string().regex(ID_PATTERN).optional(),
}).strict().refine((value) => value.uid !== undefined || value.cid !== undefined || value.path !== undefined, {
  message: 'one diagnostic locator is required',
});

const TraceArgumentsSchema = z.object({
  requestId: z.string().regex(REQUEST_ID_PATTERN),
}).strict();

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function sameSecret(left: string, right: string): Promise<boolean> {
  const bytes = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([bytes(left), bytes(right)]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let difference = av.length ^ bv.length;
  for (let index = 0; index < Math.min(av.length, bv.length); index += 1) {
    difference |= av[index]! ^ bv[index]!;
  }
  return difference === 0;
}

function bearer(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length);
  return token.length > 0 ? token : null;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('invalid_response');
  if (response.body === null) throw new Error('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('invalid_response');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as unknown;
}

function telemetryBody(
  view: 'events' | 'invocations',
  service: string,
  filters: Array<Record<string, unknown>>,
  now: Date,
): Record<string, unknown> {
  return {
    queryId: crypto.randomUUID(),
    view,
    dry: true,
    timeframe: { from: now.getTime() - QUERY_WINDOW_MS, to: now.getTime() },
    limit: QUERY_LIMIT,
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [
        { key: '$metadata.service', operation: 'eq', type: 'string', value: service },
        ...filters,
      ],
      groupBys: [],
      calculations: [],
    },
  };
}

function locatorFilters(input: z.infer<typeof LogArgumentsSchema>): Array<Record<string, unknown>> {
  const filters: Array<Record<string, unknown>> = [];
  if (input.uid !== undefined) {
    filters.push({ key: 'uid', operation: 'eq', type: 'string', value: input.uid });
  }
  if (input.cid !== undefined) {
    filters.push({ key: 'cid', operation: 'eq', type: 'string', value: input.cid });
  }
  if (input.path !== undefined) {
    filters.push({
      key: input.path.startsWith('/') ? 'path' : 'component',
      operation: 'eq',
      type: 'string',
      value: input.path,
    });
  }
  return filters;
}

function safeEvent(
  value: unknown,
  accountId: string,
  service: string,
  scanner: SecretScanner,
): { requestId: string; timestamp: string; source: unknown } {
  const event = record(value);
  const metadata = record(event?.$metadata);
  const workers = record(event?.$workers);
  const requestId = metadata?.requestId;
  const timestamp = event?.timestamp;
  if (
    event === null || metadata === null || workers === null ||
    metadata.account !== accountId || metadata.service !== service ||
    typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId) ||
    workers.requestId !== requestId || workers.truncated !== false ||
    event.dataset !== 'cloudflare-workers' || typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp) || record(event.source) === null ||
    scanner.scan(event.source).length > 0
  ) {
    throw new Error('invalid_response');
  }
  return {
    requestId,
    timestamp: new Date(timestamp).toISOString(),
    source: event.source,
  };
}

function telemetryResult(raw: unknown, accountId: string): Record<string, unknown> {
  const root = record(raw);
  const result = record(root?.result);
  const run = record(result?.run);
  if (
    root?.success !== true || !Array.isArray(root.errors) || root.errors.length !== 0 ||
    result === null || run === null || run.accountId !== accountId || run.dry !== true
  ) {
    throw new Error('invalid_response');
  }
  return result;
}

async function queryTelemetry(
  env: TelemetryBindings,
  fetcher: typeof fetch,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}` +
      '/workers/observability/telemetry/query',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${env.CLOUDFLARE_OBSERVABILITY_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('upstream_error');
  }
  return telemetryResult(await boundedJson(response), env.CLOUDFLARE_ACCOUNT_ID);
}

export function createCloudflareTelemetryToolBridge(
  options: TelemetryWorkerOptions = {},
): Hono<{ Bindings: TelemetryBindings }> {
  const app = new Hono<{ Bindings: TelemetryBindings }>();
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());

  app.use('*', async (c, next) => {
    c.header('cache-control', 'no-store');
    const supplied = bearer(c.req.header('authorization'));
    if (supplied === null || !await sameSecret(supplied, c.env.TOOL_BRIDGE_INTERNAL_TOKEN)) {
      return c.json({ error: 'unauthenticated' }, 401);
    }
    await next();
  });

  app.post('/htbp/logs/search', async (c) => {
    const envelope = EnvelopeSchema.safeParse(await c.req.json().catch(() => null));
    const parsed = envelope.success
      ? LogArgumentsSchema.safeParse(envelope.data.arguments)
      : { success: false as const };
    if (!parsed.success) return c.json({ error: 'invalid_argument' }, 400);
    try {
      const result = await queryTelemetry(
        c.env,
        fetcher,
        telemetryBody('events', c.env.TELEMETRY_SOURCE_SERVICE, locatorFilters(parsed.data), now()),
      );
      const group = record(result.events);
      const events = Array.isArray(group?.events) ? group.events : null;
      if (group === null || events === null || events.length > QUERY_LIMIT || group.count !== events.length) {
        throw new Error('invalid_response');
      }
      const scanner = new SecretScanner({
        secrets: [c.env.CLOUDFLARE_OBSERVABILITY_TOKEN, c.env.TOOL_BRIDGE_INTERNAL_TOKEN],
      });
      c.header('cache-control', 'no-store');
      return c.json({
        schemaVersion: '1',
        matched: events.length,
        events: events.map((event) =>
          safeEvent(event, c.env.CLOUDFLARE_ACCOUNT_ID, c.env.TELEMETRY_SOURCE_SERVICE, scanner)),
      });
    } catch {
      return c.json({ error: 'upstream_unavailable' }, 503);
    }
  });

  app.post('/htbp/traces/get', async (c) => {
    const envelope = EnvelopeSchema.safeParse(await c.req.json().catch(() => null));
    const parsed = envelope.success
      ? TraceArgumentsSchema.safeParse(envelope.data.arguments)
      : { success: false as const };
    if (!parsed.success) return c.json({ error: 'invalid_argument' }, 400);
    try {
      const result = await queryTelemetry(
        c.env,
        fetcher,
        telemetryBody('invocations', c.env.TELEMETRY_SOURCE_SERVICE, [{
          key: '$metadata.requestId',
          operation: 'eq',
          type: 'string',
          value: parsed.data.requestId,
        }], now()),
      );
      const invocations = record(result.invocations);
      const rawEvents = invocations?.[parsed.data.requestId];
      if (invocations === null || !Array.isArray(rawEvents) || rawEvents.length < 1 || rawEvents.length > 100) {
        throw new Error('invalid_response');
      }
      const scanner = new SecretScanner({
        secrets: [c.env.CLOUDFLARE_OBSERVABILITY_TOKEN, c.env.TOOL_BRIDGE_INTERNAL_TOKEN],
      });
      c.header('cache-control', 'no-store');
      return c.json({
        schemaVersion: '1',
        requestId: parsed.data.requestId,
        events: rawEvents.map((event) => {
          const safe = safeEvent(
            event,
            c.env.CLOUDFLARE_ACCOUNT_ID,
            c.env.TELEMETRY_SOURCE_SERVICE,
            scanner,
          );
          if (safe.requestId !== parsed.data.requestId) throw new Error('invalid_response');
          return safe;
        }),
      });
    } catch {
      return c.json({ error: 'upstream_unavailable' }, 503);
    }
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}

export const cloudflareTelemetryToolBridge = createCloudflareTelemetryToolBridge();

export default { fetch: cloudflareTelemetryToolBridge.fetch };
