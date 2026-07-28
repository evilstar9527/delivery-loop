import { describe, expect, it } from 'vitest';
import { IncrementalSha256, sha256Hex } from '../src/backup/incremental-sha256.js';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

describe('incremental SHA-256', () => {
  it('matches standard vectors across arbitrary chunk boundaries', () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    const value = new TextEncoder().encode('abc'.repeat(10_000));
    const digest = new IncrementalSha256();
    for (let offset = 0; offset < value.length; offset += 37) {
      digest.update(value.subarray(offset, offset + 37));
    }
    expect(hex(digest.digest())).toBe(
      '13b77af908a78a94f2e21cf8fc137ea16c8020873eeee7b6b96b6b0975555a02',
    );
  });
});
