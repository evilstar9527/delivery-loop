import { describe, expect, it } from 'vitest';

describe('workerd fetch redirect compatibility', () => {
  it('accepts manual redirect handling and rejects the unsupported error mode', () => {
    expect(() => new Request('https://api.github.com', {
      redirect: 'manual',
    })).not.toThrow();
    expect(() => new Request('https://api.github.com', {
      redirect: 'error',
    })).toThrow(TypeError);
  });
});
