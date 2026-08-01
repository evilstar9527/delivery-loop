export const SAFE_TRANSPORT_FAILURE_KINDS = [
  'request_timed_out',
  'dns_failed',
  'tcp_failed',
  'tls_failed',
  'request_failed',
] as const;

export type SafeTransportFailureKind =
  typeof SAFE_TRANSPORT_FAILURE_KINDS[number];

function safeErrorField(value: unknown, field: 'name' | 'code' | 'cause'): unknown {
  try {
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)[field]
      : undefined;
  } catch {
    return undefined;
  }
}

/** Classifies only allowlisted transport metadata and never reads raw messages. */
export function classifySafeTransportFailure(error: unknown): SafeTransportFailureKind {
  const names = new Set<string>();
  const codes = new Set<string>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    const name = safeErrorField(current, 'name');
    const code = safeErrorField(current, 'code');
    if (typeof name === 'string') names.add(name);
    if (typeof code === 'string') codes.add(code.toUpperCase());
    current = safeErrorField(current, 'cause');
  }
  if (names.has('TimeoutError') || names.has('AbortError') || codes.has('ABORT_ERR')) {
    return 'request_timed_out';
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA'].some((code) => codes.has(code))) {
    return 'dns_failed';
  }
  if ([
    'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  ].some((code) => codes.has(code))) return 'tcp_failed';
  if ([...codes].some((code) =>
    code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') ||
    code.startsWith('CERT_') || [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
    ].includes(code))) return 'tls_failed';
  return 'request_failed';
}
