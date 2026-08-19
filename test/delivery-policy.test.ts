import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  DeliveryPolicyError,
  MAX_DELIVERY_POLICY_BYTES,
  deliveryPolicyCommandRefs,
  parseDeliveryPolicy,
  resolveDeliveryCommand,
  resolveTestRollbackCommand,
} from '../src/domain/delivery-policy.js';
import { testRollbackTargetFromPolicy } from '../src/domain/test-rollback.js';
import { loadDeliveryPolicyAtCommit } from '../src/runner/delivery-policy-loader.js';
import {
  ANALYSIS_PILOT_CHANGE_COMMAND_REFS,
  ANALYSIS_PILOT_VERIFICATION_COMMAND_REFS,
} from '../src/domain/analysis-plan-policy.js';
import { DeliveryCommandRunner } from '../src/runner/delivery-command-runner.js';

const executeFile = promisify(execFile);

const VALID_POLICY = `schemaVersion: '1'
commands:
  setup:
    install:
      argv: [pnpm, install, --frozen-lockfile]
      timeoutSeconds: 600
  targeted:
    unit:
      argv: [pnpm, exec, vitest, run]
      timeoutSeconds: 300
  verify:
    all:
      argv: [pnpm, run, verify]
      timeoutSeconds: 1200
  acceptance:
    smoke:
      argv: [pnpm, run, acceptance:test]
      timeoutSeconds: 300
protectedPaths:
  - delivery.yaml
  - .github/workflows/**
  - CODEOWNERS
deployment:
  mode: none
`;

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await executeFile('git', args, { cwd: repository, encoding: 'utf8' });
  return result.stdout.trim();
}

async function repositoryFixture(): Promise<{ repository: string; baseSha: string }> {
  const root = await mkdtemp(join(tmpdir(), 'delivery-policy-'));
  const repository = join(root, 'repo');
  await mkdir(repository, { mode: 0o700 });
  await git(repository, 'init');
  await git(repository, 'config', 'user.name', 'Delivery Loop Test');
  await git(repository, 'config', 'user.email', 'delivery-loop@example.test');
  await writeFile(join(repository, 'delivery.yaml'), VALID_POLICY);
  await git(repository, 'add', 'delivery.yaml');
  await git(repository, 'commit', '-m', 'trusted delivery policy');
  return { repository, baseSha: await git(repository, 'rev-parse', 'HEAD') };
}

describe('delivery.yaml v1', () => {
  it('parses the repository policy and resolves only canonical refs to argv without a shell', async () => {
    const source = await readFile(resolve('delivery.yaml'), 'utf8');
    const parsed = await parseDeliveryPolicy(source);
    expect(parsed.policy).toMatchObject({
      schemaVersion: '1',
      deployment: { mode: 'none' },
    });
    expect(parsed.policy.protectedPaths).toEqual(
      expect.arrayContaining(['delivery.yaml', '.github/workflows/**', 'CODEOWNERS']),
    );
    expect(parsed.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(parsed.policy)).toBe(true);
    expect(Object.isFrozen(parsed.policy.commands.verify.all?.argv)).toBe(true);
    expect(deliveryPolicyCommandRefs(parsed.policy)).toEqual([
      'setup:install',
      'test:smoke',
      'verify:smoke',
      'acceptance:smoke',
    ]);
    expect(ANALYSIS_PILOT_CHANGE_COMMAND_REFS).toEqual(
      deliveryPolicyCommandRefs(parsed.policy).filter((ref) => /^(?:test|verify):/.test(ref)),
    );
    expect(ANALYSIS_PILOT_VERIFICATION_COMMAND_REFS).toEqual(
      deliveryPolicyCommandRefs(parsed.policy).filter((ref) => ref.startsWith('verify:')),
    );
    const request = resolveDeliveryCommand(
      parsed.policy,
      'verify:smoke',
      '/trusted/repository',
    );
    expect(request).toEqual({
      ref: 'verify:smoke',
      category: 'verify',
      command: 'node',
      args: ['-e', "require('node:fs').accessSync('package.json')"],
      cwd: '/trusted/repository',
      stdin: '',
      timeoutMs: 120_000,
    });
    request.args.push('MUTATION');
    expect(resolveDeliveryCommand(parsed.policy, 'verify:smoke', '/trusted/repository').args)
      .toEqual(['-e', "require('node:fs').accessSync('package.json')"]);
    expect(resolveDeliveryCommand(
      parsed.policy,
      'acceptance:smoke',
      '/trusted/repository',
    )).toEqual({
      ref: 'acceptance:smoke',
      category: 'acceptance',
      command: 'node',
      args: ['-e', "require('node:fs').accessSync('package.json')"],
      cwd: '/trusted/repository',
      stdin: '',
      timeoutMs: 120_000,
    });
  });

  it('loads the immutable policy blob from the trusted base commit, not the mutable worktree', async () => {
    const fixture = await repositoryFixture();
    await writeFile(
      join(fixture.repository, 'delivery.yaml'),
      VALID_POLICY.replace('[pnpm, run, verify]', '[sh, -c, task-controlled-command]'),
    );
    const loaded = await loadDeliveryPolicyAtCommit(fixture.repository, fixture.baseSha);
    expect(loaded.baseSha).toBe(fixture.baseSha);
    expect(loaded.path).toBe('delivery.yaml');
    expect(resolveDeliveryCommand(loaded.policy, 'verify:all', fixture.repository)).toMatchObject({
      command: 'pnpm',
      args: ['run', 'verify'],
    });
    await expect(
      loadDeliveryPolicyAtCommit(fixture.repository, 'not-a-sha'),
    ).rejects.toThrow('delivery policy source is invalid');
  });

  it('rejects task-provided command strings and command-ref suffix injection', async () => {
    const { policy } = await parseDeliveryPolicy(VALID_POLICY);
    const execute = vi.fn(async () => ({ exitCode: 0 }));
    const runner = new DeliveryCommandRunner(policy, '/trusted/repository', execute);
    await expect(runner.run('test:unit')).resolves.toEqual({
      ref: 'test:unit',
      exitCode: 0,
    });
    expect(execute).toHaveBeenCalledWith({
      command: 'pnpm',
      args: ['exec', 'vitest', 'run'],
      cwd: '/trusted/repository',
      stdin: '',
      timeoutMs: 300_000,
    });
    for (const ref of [
      'rm -rf /',
      'verify:all -- --task-value',
      'verify:missing',
      'test:unit;curl example.test',
    ]) {
      expect(() => resolveDeliveryCommand(policy, ref, '/trusted/repository'))
        .toThrow('delivery command reference is not trusted');
      await expect(runner.run(ref)).rejects.toThrow(
        'delivery command reference is not trusted',
      );
    }
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      parseDeliveryPolicy(VALID_POLICY.replace('argv: [pnpm, run, verify]', 'run: pnpm run verify')),
    ).rejects.toBeInstanceOf(DeliveryPolicyError);
  });

  it('rejects YAML aliases, duplicate keys, unknown fields, traversal patterns, and missing sections', async () => {
    const invalidSources = [
      VALID_POLICY.replace('install:\n      argv:', 'install: &install\n      argv:')
        .replace('unit:\n      argv:', 'unit: *install\n      ignored:'),
      VALID_POLICY.replace("schemaVersion: '1'", "schemaVersion: '1'\nschemaVersion: '1'"),
      `${VALID_POLICY}taskCommand: rm -rf /\n`,
      VALID_POLICY.replace('  - CODEOWNERS', '  - ../outside/**'),
      VALID_POLICY.replace('  - CODEOWNERS', '  - /etc/passwd'),
      VALID_POLICY.replace(/ {2}targeted:[\s\S]*? {2}verify:/, '  verify:'),
      `${VALID_POLICY}\0`,
      `#${'x'.repeat(MAX_DELIVERY_POLICY_BYTES)}\n${VALID_POLICY}`,
      VALID_POLICY.replace(
        'deployment:\n  mode: none',
        'deployment:\n  mode: github_actions',
      ),
    ];
    for (const source of invalidSources) {
      await expect(parseDeliveryPolicy(source)).rejects.toBeInstanceOf(DeliveryPolicyError);
    }
  });

  it('validates a GitHub deployment contract against trusted verification refs', async () => {
    const source = VALID_POLICY.replace(
      'deployment:\n  mode: none',
      `deployment:
  mode: github_actions
  test:
    workflowPath: .github/workflows/delivery-test-deploy.yml
    environment: test
    oidcAudience: delivery-loop-test-deploy
    roleRef: test:delivery-loop-deployer
    command:
      argv: [pnpm, run, deploy:test]
      timeoutSeconds: 900
    verifyCommandRef: verify:all
    acceptanceCommandRef: acceptance:smoke
  production:
    workflowPath: .github/workflows/delivery-production-deploy.yml
    environment: production
    oidcAudience: delivery-loop-production-deploy
    roleRef: production:delivery-loop-deployer
    command:
      argv: [pnpm, run, deploy:production]
      timeoutSeconds: 900
    verifyCommandRef: verify:all`,
    );
    const { policy } = await parseDeliveryPolicy(source);
    expect(policy.deployment).toMatchObject({
      mode: 'github_actions',
      test: {
        environment: 'test',
        oidcAudience: 'delivery-loop-test-deploy',
        roleRef: 'test:delivery-loop-deployer',
        verifyCommandRef: 'verify:all',
        acceptanceCommandRef: 'acceptance:smoke',
      },
      production: {
        environment: 'production',
        oidcAudience: 'delivery-loop-production-deploy',
        roleRef: 'production:delivery-loop-deployer',
        verifyCommandRef: 'verify:all',
      },
    });
    await expect(
      parseDeliveryPolicy(source.replaceAll('verify:all', 'verify:missing')),
    ).rejects.toBeInstanceOf(DeliveryPolicyError);
    await expect(
      parseDeliveryPolicy(source.replace('acceptanceCommandRef: acceptance:smoke',
        'acceptanceCommandRef: acceptance:missing')),
    ).rejects.toBeInstanceOf(DeliveryPolicyError);
  });

  it('requires an explicit test-only rollback contract with a distinct role and fixed argv', async () => {
    const source = VALID_POLICY.replace(
      'deployment:\n  mode: none',
      `deployment:
  mode: github_actions
  test:
    workflowPath: .github/workflows/delivery-test-deploy.yml
    environment: test
    oidcAudience: delivery-loop-test-deploy
    roleRef: test:delivery-loop-deployer
    command: { argv: [pnpm, run, deploy:test], timeoutSeconds: 900 }
    verifyCommandRef: verify:all
    acceptanceCommandRef: acceptance:smoke
    rollback:
      workflowPath: .github/workflows/delivery-test-rollback.yml
      environment: test
      oidcAudience: delivery-loop-test-rollback
      roleRef: test:delivery-loop-rollback
      automaticOn: [deployment_failure, acceptance_failure]
      command:
        argv: [pnpm, run, rollback:test]
        timeoutSeconds: 600`,
    );
    const parsed = await parseDeliveryPolicy(source);
    expect(resolveTestRollbackCommand(parsed.policy, '/trusted/repository')).toEqual({
      environment: 'test',
      command: 'pnpm',
      args: ['run', 'rollback:test'],
      cwd: '/trusted/repository',
      stdin: '',
      timeoutMs: 600_000,
    });
    await expect(testRollbackTargetFromPolicy(
      'example/repo',
      'acceptance_failure',
      parsed,
    )).resolves.toMatchObject({
      repository: 'example/repo',
      environment: 'test',
      workflowPath: '.github/workflows/delivery-test-rollback.yml',
      oidcAudience: 'delivery-loop-test-rollback',
      roleRef: 'test:delivery-loop-rollback',
      sourceKind: 'acceptance_failure',
      policyDigest: parsed.digest,
      contractDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    await expect(parseDeliveryPolicy(source.replace(
      'roleRef: test:delivery-loop-rollback',
      'roleRef: test:delivery-loop-deployer',
    ))).rejects.toBeInstanceOf(DeliveryPolicyError);
    await expect(parseDeliveryPolicy(source.replace(
      'automaticOn: [deployment_failure, acceptance_failure]',
      'automaticOn: [deployment_failure, deployment_failure]',
    ))).rejects.toBeInstanceOf(DeliveryPolicyError);
    await expect(parseDeliveryPolicy(`${source}  production:
    workflowPath: .github/workflows/delivery-production-deploy.yml
    environment: production
    oidcAudience: delivery-loop-production-deploy
    roleRef: production:delivery-loop-deployer
    command: { argv: [pnpm, run, deploy:production], timeoutSeconds: 900 }
    verifyCommandRef: verify:all
    rollback:
      workflowPath: .github/workflows/delivery-test-rollback.yml
      environment: test
      oidcAudience: delivery-loop-test-rollback
      roleRef: test:delivery-loop-rollback
      automaticOn: [deployment_failure]
      command: { argv: [pnpm, run, rollback:test], timeoutSeconds: 600 }
`)).rejects.toBeInstanceOf(DeliveryPolicyError);
    const noRollback = await parseDeliveryPolicy(VALID_POLICY);
    expect(() => resolveTestRollbackCommand(
      noRollback.policy,
      '/trusted/repository',
    )).toThrow('delivery command reference is not trusted');
  });
});
