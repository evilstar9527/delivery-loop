import type { Context } from 'hono';
import type { Bindings } from '../env.js';

export type DeliveryErrorCode =
  | 'invalid_argument'
  | 'unauthenticated'
  | 'permission_denied'
  | 'not_found'
  | 'conflict'
  | 'stale_revision'
  | 'policy_denied'
  | 'rate_limited'
  | 'upstream_error'
  | 'timeout'
  | 'invalid_response'
  | 'unavailable'
  | 'internal';

export interface DeliveryError {
  code: DeliveryErrorCode;
  message: string;
  retryable: boolean;
  correlationId: string;
}

type ApiContext = Context<{ Bindings: Bindings }>;
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503 | 504;
const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requestCorrelationId(c: ApiContext): string {
  const supplied = c.req.header('x-correlation-id');
  if (supplied !== undefined && CORRELATION_ID_PATTERN.test(supplied)) return supplied;
  return crypto.randomUUID();
}

export function errorResponse(
  c: ApiContext,
  status: ErrorStatus,
  code: DeliveryErrorCode,
  message: string,
  retryable: boolean,
): Response {
  const body: DeliveryError = {
    code,
    message,
    retryable,
    correlationId: requestCorrelationId(c),
  };
  return c.json(body, status);
}
