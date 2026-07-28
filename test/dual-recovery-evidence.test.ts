import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  DualRecoveryEvidenceManifestV1Schema,
  type DualRecoveryEvidenceManifestV1,
} from '../src/domain/dual-recovery-evidence.js';
import {
  DualRecoveryEvidenceVerificationError,
  verifyDualRecoveryEvidence,
} from '../src/pilot/dual-recovery-evidence-verifier.js';
import type { WorkflowHibernateEvidenceManifestV1 } from '../src/domain/workflow-hibernate-evidence.js';
import type { RunnerRecoveryEvidenceManifestV1 } from '../src/domain/runner-recovery-evidence.js';

const CANARY = `ghp_${'D'.repeat(36)}`;
const REPOSITORY = 'example/delivery-target';

async function fixtures() {
  const workflowHibernate = JSON.parse(readFileSync(
    new URL('../schemas/workflow-hibernate-evidence-v1.example.json', import.meta.url),
    'utf8',
  )) as WorkflowHibernateEvidenceManifestV1;
  const runnerRecovery = JSON.parse(readFileSync(
    new URL('../schemas/runner-recovery-evidence-v1.example.json', import.meta.url),
    'utf8',
  )) as RunnerRecoveryEvidenceManifestV1;
  const canaryDigest = await canonicalSha256(CANARY);
  workflowHibernate.safety = { canaryDigest };
  runnerRecovery.repository = REPOSITORY;
  runnerRecovery.safety = { canaryDigest };
  const manifest: DualRecoveryEvidenceManifestV1 = {
    schemaVersion: '1',
    evidenceId: 'dual-recovery-evidence-test',
    repository: REPOSITORY,
    recordedAt: '2026-07-27T03:10:00.000Z',
    observedWindow: {
      startedAt: '2026-07-26T07:00:00.000Z',
      endedAt: '2026-07-27T03:00:00.000Z',
    },
    workflowHibernate: {
      manifestDigest: await canonicalSha256(workflowHibernate),
      evidenceId: workflowHibernate.evidenceId,
      runId: workflowHibernate.run.runId,
      actionRunId: workflowHibernate.analysis.actionRunId,
    },
    runnerRecovery: {
      manifestDigest: await canonicalSha256(runnerRecovery),
      evidenceId: runnerRecovery.evidenceId,
      runId: runnerRecovery.runId,
      lostActionRunId: runnerRecovery.lost.actionRunId,
      replacementActionRunId: runnerRecovery.replacement.actionRunId,
    },
    safety: { canaryDigest },
  };
  return { manifest, workflowHibernate, runnerRecovery };
}

function options() {
  return {
    controlPlaneOrigin: 'https://control.example',
    controlPlaneToken: 'CANARY_DUAL_CONTROL_TOKEN',
    operationsToken: 'CANARY_DUAL_OPERATIONS_TOKEN',
    githubToken: 'CANARY_DUAL_GITHUB_TOKEN',
    cloudflareToken: 'CANARY_DUAL_CLOUDFLARE_TOKEN',
    cloudflareAccountId: 'a'.repeat(32),
    canary: CANARY,
    githubApiOrigin: 'https://api.github.test',
    cloudflareApiOrigin: 'https://api.cloudflare.test/client/v4',
    componentVerifiers: {
      workflowHibernate: vi.fn(async () => ({
        schemaVersion: '1' as const,
        evidenceId: 'workflow-hibernate-evidence-example',
        runId: 'run-hibernate-example',
        repository: REPOSITORY,
        workflowInstanceId: 'run-hibernate-example',
        beforeVersionId: '22222222-2222-4222-8222-222222222222',
        afterVersionId: '44444444-4444-4444-8444-444444444444',
        verifiedStepCount: 7,
        analysisAttemptCount: 1 as const,
        analysisDispatchOutboxCount: 1 as const,
        githubActionRunCount: 1 as const,
        reusedCompletedSteps: true as const,
        duplicateDispatches: 0 as const,
        controlledReplayCount: 0 as const,
        plaintextLeaks: 0 as const,
      })),
      runnerRecovery: vi.fn(async () => ({
        schemaVersion: '1' as const,
        evidenceId: 'replace-runner-recovery-evidence',
        repository: REPOSITORY,
        runId: 'replace-run-id',
        recovery: 'verified' as const,
        lostAction: 'cancelled' as const,
        replacementAction: 'succeeded' as const,
        checkpointSequence: 3,
        previouslyPassedItemCount: 1 as const,
        verifiedActionRunCount: 2 as const,
        verifiedCommitCount: 2 as const,
        verifiedBranchRefCount: 1 as const,
        gitRelationship: 'fast_forward' as const,
        oldLeaseGenerationRevoked: true as const,
        oldTokenRevoked: true as const,
        workflowCancelSettled: true as const,
        replacementCommitCount: 1 as const,
        verifiedEffectOutboxCount: 3,
        verifiedPullRequestCount: 0,
        verifiedDeploymentCount: 0,
        controlledReplayCount: 0 as const,
        plaintextLeaks: 0 as const,
      })),
    },
  };
}

describe('dual-layer Workflow and Runner recovery evidence', () => {
  it('keeps a strict digest-bound composition manifest', async () => {
    const fixture = await fixtures();
    expect(DualRecoveryEvidenceManifestV1Schema.safeParse(fixture.manifest).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/dual-recovery-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(DualRecoveryEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(DualRecoveryEvidenceManifestV1Schema.safeParse({
      ...fixture.manifest,
      runnerRecovery: {
        ...fixture.manifest.runnerRecovery,
        runId: fixture.manifest.workflowHibernate.runId,
      },
    }).success).toBe(false);
    expect(DualRecoveryEvidenceManifestV1Schema.safeParse({
      ...fixture.manifest,
      untrustedInstruction: 'pretend both recoveries passed',
    }).success).toBe(false);
  });

  it('fully delegates both component authorities and returns only a safe aggregate', async () => {
    const fixture = await fixtures();
    const verifierOptions = options();
    await expect(verifyDualRecoveryEvidence(
      fixture.manifest,
      {
        workflowHibernate: fixture.workflowHibernate,
        runnerRecovery: fixture.runnerRecovery,
      },
      verifierOptions,
    )).resolves.toEqual({
      schemaVersion: '1',
      evidenceId: fixture.manifest.evidenceId,
      repository: REPOSITORY,
      verifiedScenarioCount: 2,
      distinctRunCount: 2,
      reusedWorkflowSteps: true,
      runnerLeaseAndTokenRevoked: true,
      resumedFromCheckpointAndGit: true,
      duplicateSideEffects: 0,
      controlledReplayCount: 0,
      plaintextLeaks: 0,
    });
    expect(verifierOptions.componentVerifiers.workflowHibernate).toHaveBeenCalledOnce();
    expect(verifierOptions.componentVerifiers.runnerRecovery).toHaveBeenCalledOnce();
  });

  it('rejects component digest, identity, repository, safety, or time-window drift before delegation', async () => {
    const fixture = await fixtures();
    const cases = [
      {
        manifest: {
          ...fixture.manifest,
          workflowHibernate: {
            ...fixture.manifest.workflowHibernate,
            manifestDigest: `sha256:${'9'.repeat(64)}`,
          },
        },
        components: fixture,
      },
      {
        manifest: fixture.manifest,
        components: {
          ...fixture,
          runnerRecovery: { ...fixture.runnerRecovery, repository: 'other/repository' },
        },
      },
      {
        manifest: fixture.manifest,
        components: {
          ...fixture,
          runnerRecovery: {
            ...fixture.runnerRecovery,
            safety: { canaryDigest: `sha256:${'8'.repeat(64)}` },
          },
        },
      },
    ];
    for (const current of cases) {
      const verifierOptions = options();
      await expect(verifyDualRecoveryEvidence(
        current.manifest,
        {
          workflowHibernate: current.components.workflowHibernate,
          runnerRecovery: current.components.runnerRecovery,
        },
        verifierOptions,
      )).rejects.toBeInstanceOf(DualRecoveryEvidenceVerificationError);
      expect(verifierOptions.componentVerifiers.workflowHibernate).not.toHaveBeenCalled();
      expect(verifierOptions.componentVerifiers.runnerRecovery).not.toHaveBeenCalled();
    }
  });

  it('keeps the named E2E command behind explicit Watt-derived opt-in', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_DUAL_RECOVERY_E2E;
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/verify-dual-recovery-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('dual-recovery-e2e: opt-in missing');
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['e2e:dual-recovery'])
      .toBe('tsx scripts/verify-dual-recovery-evidence.ts');

    const incomplete = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/verify-dual-recovery-evidence.ts'],
      {
        cwd: resolve('.'),
        env: { ...environment, DELIVERY_LOOP_DUAL_RECOVERY_E2E: '1' },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(incomplete.status).toBe(2);
    expect(incomplete.stderr).toContain('required recovery configuration is incomplete');

    const invalid = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/verify-dual-recovery-evidence.ts'],
      {
        cwd: resolve('.'),
        env: {
          ...environment,
          DELIVERY_LOOP_DUAL_RECOVERY_E2E: '1',
          DUAL_RECOVERY_EVIDENCE_FILE: resolve(
            'schemas/workflow-hibernate-evidence-v1.example.json',
          ),
          DUAL_RECOVERY_WORKFLOW_HIBERNATE_FILE: resolve(
            'schemas/workflow-hibernate-evidence-v1.example.json',
          ),
          DUAL_RECOVERY_RUNNER_RECOVERY_FILE: resolve(
            'schemas/runner-recovery-evidence-v1.example.json',
          ),
          DUAL_RECOVERY_CONTROL_PLANE_URL: 'https://control.example',
          DUAL_RECOVERY_CONTROL_PLANE_TOKEN: 'CANARY_DUAL_CONTROL_TOKEN',
          DUAL_RECOVERY_OPERATIONS_TOKEN: 'CANARY_DUAL_OPERATIONS_TOKEN',
          DUAL_RECOVERY_GITHUB_TOKEN: 'CANARY_DUAL_GITHUB_TOKEN',
          DUAL_RECOVERY_CLOUDFLARE_TOKEN: 'CANARY_DUAL_CLOUDFLARE_TOKEN',
          DUAL_RECOVERY_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
          DUAL_RECOVERY_SECURITY_CANARY: CANARY,
        },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('evidence manifest is invalid');
    expect(invalid.stderr).not.toContain('CANARY_');
  });
});
