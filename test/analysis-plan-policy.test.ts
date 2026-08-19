import { describe, expect, it } from 'vitest';
import { deriveAnalysisPlanPolicy } from '../src/domain/analysis-plan-policy.js';

describe('deriveAnalysisPlanPolicy', () => {
  it.each(['requirement', 'bug'] as const)(
    'requires a self-verifying repository change for writable %s intake',
    (intentKind) => {
      const policy = deriveAnalysisPlanPolicy(intentKind, true);

      expect(policy.requiresRepositoryChange).toBe(true);
      expect(policy.requiresTestDeployment).toBe(false);
      expect(policy.allowedEffects).toContain('repo_write');
      expect(policy.allowedCommandRefs).toEqual(
        expect.arrayContaining(['test:typecheck', 'verify:typecheck']),
      );
      expect(policy.verificationCommandRefs).toEqual(['verify:typecheck']);
    },
  );

  it.each(['requirement', 'bug'] as const)(
    'keeps read-only %s intake investigation-only',
    (intentKind) => {
      const policy = deriveAnalysisPlanPolicy(intentKind, false);

      expect(policy.requiresRepositoryChange).toBe(false);
      expect(policy.requiresTestDeployment).toBe(false);
      expect(policy.allowedEffects).not.toContain('repo_write');
      expect(policy.verificationCommandRefs).toEqual([]);
    },
  );

  it('allows and requires test_deploy only for a writable test target with explicit authority', () => {
    const policy = deriveAnalysisPlanPolicy('bug', true, true, 'test');

    expect(policy.allowedEffects).toContain('test_deploy');
    expect(policy.requiresTestDeployment).toBe(true);
  });

  it.each([
    { allowRepositoryWrite: false, allowTestDeploy: true, environment: 'test' as const },
    { allowRepositoryWrite: true, allowTestDeploy: false, environment: 'test' as const },
    { allowRepositoryWrite: true, allowTestDeploy: true, environment: 'none' as const },
    { allowRepositoryWrite: true, allowTestDeploy: true, environment: 'production' as const },
  ])('denies test_deploy outside the exact writable test-target contract: $environment', (input) => {
    const policy = deriveAnalysisPlanPolicy(
      'bug', input.allowRepositoryWrite, input.allowTestDeploy, input.environment,
    );

    expect(policy.allowedEffects).not.toContain('test_deploy');
    expect(policy.requiresTestDeployment).toBe(false);
  });
});
