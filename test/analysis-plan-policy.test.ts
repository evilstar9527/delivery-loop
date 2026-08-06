import { describe, expect, it } from 'vitest';
import { deriveAnalysisPlanPolicy } from '../src/domain/analysis-plan-policy.js';

describe('deriveAnalysisPlanPolicy', () => {
  it.each(['requirement', 'bug'] as const)(
    'requires a self-verifying repository change for writable %s intake',
    (intentKind) => {
      const policy = deriveAnalysisPlanPolicy(intentKind, true);

      expect(policy.requiresRepositoryChange).toBe(true);
      expect(policy.allowedEffects).toContain('repo_write');
      expect(policy.allowedCommandRefs).toEqual(
        expect.arrayContaining(['test:unit', 'verify:all']),
      );
      expect(policy.verificationCommandRefs).toEqual(['verify:all']);
    },
  );

  it.each(['requirement', 'bug'] as const)(
    'keeps read-only %s intake investigation-only',
    (intentKind) => {
      const policy = deriveAnalysisPlanPolicy(intentKind, false);

      expect(policy.requiresRepositoryChange).toBe(false);
      expect(policy.allowedEffects).not.toContain('repo_write');
      expect(policy.verificationCommandRefs).toEqual([]);
    },
  );
});
