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
        expect.arrayContaining(['test:smoke', 'verify:smoke']),
      );
      expect(policy.verificationCommandRefs).toEqual(['verify:smoke']);
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

  // In-sandbox refs are resolved against the target repository's own
  // delivery.yaml, and resolveDeliveryCommand throws 'untrusted_command' for an
  // id that contract does not declare. A single hardcoded set therefore only
  // works for one repository: tipsy-backend declares setup:modules / test:unit /
  // verify:all and would have failed at plan time against 'smoke'.
  it('offers the Go pilot repository the affordable smoke refs for a self-verifying plan', () => {
    // Measured on a standard-4 sandbox against a real checkout: the contract's
    // `test:unit` was still linking past 540s (its budget is 600s, and module
    // download already costs ~100s of that), while the smoketest build finished
    // in 114s. test:unit would guarantee a timeout kill, so it stays excluded.
    //
    // The smoketest build is declared under BOTH test:smoke and verify:smoke in
    // delivery.yaml. Both are required: a self-verifying change item — the only
    // shape that satisfies requiresRepositoryChange — needs one test:* ref and
    // one verify:* ref. Offering only verify:smoke made every plan impossible.
    const policy = deriveAnalysisPlanPolicy(
      'bug', true, false, 'none', 'lightspeed-intelligence/tipsy-backend',
    );

    expect(policy.verificationCommandRefs).toEqual(['verify:smoke']);
    expect(policy.allowedCommandRefs).toEqual(
      expect.arrayContaining(['test:smoke', 'verify:smoke']),
    );
    expect(policy.allowedCommandRefs).not.toContain('test:unit');
    expect(policy.allowedCommandRefs).not.toContain('verify:all');
  });

  it('keeps the default refs for a repository with no explicit mapping', () => {
    const policy = deriveAnalysisPlanPolicy(
      'bug', true, false, 'none', 'evilstar9527/delivery-loop',
    );

    expect(policy.verificationCommandRefs).toEqual(['verify:smoke']);
  });

  it('keeps the default refs when no repository is supplied', () => {
    // Existing callers that predate per-repository refs must not change shape.
    expect(deriveAnalysisPlanPolicy('bug', true).verificationCommandRefs)
      .toEqual(['verify:smoke']);
  });

  it('grants no command refs to a read-only intake regardless of repository', () => {
    const policy = deriveAnalysisPlanPolicy(
      'bug', false, false, 'none', 'lightspeed-intelligence/tipsy-backend',
    );

    expect(policy.verificationCommandRefs).toEqual([]);
    expect(policy.allowedCommandRefs).not.toContain('test:unit');
  });
});
