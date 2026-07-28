import { describe, expect, it } from 'vitest';
import { isExpired } from '../src/retention/ttl.js';

// Copied from Watt's packages/core/src/context/ttl.test.ts at commit
// 476e3cdd2490d725fde174e7c697ebf00899edc6; only the policy TTL is adapted.
const CREATED_AT = '2026-06-01T00:00:00.000Z';
const createdAtMs = Date.parse(CREATED_AT);
const RAW_TTL_SECONDS = 30 * 24 * 60 * 60;

describe('raw Agent retention expiration', () => {
  it('does not expire without a TTL', () => {
    expect(isExpired(CREATED_AT, undefined, createdAtMs + 1e15)).toBe(false);
  });

  it('does not expire before 30 days', () => {
    expect(isExpired(CREATED_AT, RAW_TTL_SECONDS, createdAtMs +
      (RAW_TTL_SECONDS - 1) * 1000)).toBe(false);
  });

  it('expires at the inclusive 30-day boundary', () => {
    expect(isExpired(CREATED_AT, RAW_TTL_SECONDS, createdAtMs +
      RAW_TTL_SECONDS * 1000)).toBe(true);
  });

  it('remains expired after the boundary', () => {
    expect(isExpired(CREATED_AT, RAW_TTL_SECONDS, createdAtMs +
      (RAW_TTL_SECONDS + 1) * 1000)).toBe(true);
  });
});
