import { isIP } from 'node:net';

export interface ValidatedProviderEndpoint {
  readonly normalizedBaseUrl: string;
  readonly hostname: string;
  readonly port: number;
}

/** Shared provider URL boundary used by every Codex adapter and network preflight. */
export function parseProviderBaseUrl(raw: string): ValidatedProviderEndpoint {
  if (raw.length === 0 || raw.length > 2_048 || raw !== raw.trim()) {
    throw new Error('Codex provider base URL is invalid');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Codex provider base URL is invalid');
  }
  const hostname = url.hostname.toLowerCase();
  const ipCandidate = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    isIP(ipCandidate) !== 0
  ) {
    throw new Error('Codex provider base URL is invalid');
  }
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return {
    normalizedBaseUrl: `${url.origin}${pathname}`,
    hostname,
    port: url.port === '' ? 443 : Number(url.port),
  };
}

export function normalizeProviderBaseUrl(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : parseProviderBaseUrl(raw).normalizedBaseUrl;
}

export function executorModelProviderBaseUrl(attemptId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(attemptId)) {
    throw new Error('Executor model provider identity is invalid');
  }
  return `https://control.delivery-loop.internal/v1/attempts/${
    encodeURIComponent(attemptId)
  }/executor-model/v1`;
}

export function normalizeExecutorModelProviderBaseUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const match = /^https:\/\/control\.delivery-loop\.internal\/v1\/attempts\/([A-Za-z0-9][A-Za-z0-9_-]{0,199})\/executor-model\/v1$/.exec(raw);
  if (match === null || executorModelProviderBaseUrl(match[1]!) !== raw) {
    throw new Error('Executor model provider URL is invalid');
  }
  return raw;
}
