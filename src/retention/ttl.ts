/**
 * Copied from Watt's packages/core/src/context/ttl.ts at commit
 * 476e3cdd2490d725fde174e7c697ebf00899edc6. Retention uses the same inclusive
 * TTL boundary as Watt namespace reclamation.
 */
export function isExpired(mountedAt: string, ttl: number | undefined, nowMs: number): boolean {
  if (ttl === undefined) return false;
  const mountedMs = Date.parse(mountedAt);
  const expiresMs = mountedMs + ttl * 1000;
  return nowMs >= expiresMs;
}
