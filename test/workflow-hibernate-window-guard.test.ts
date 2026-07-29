import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowHibernateWindowGuardError,
  executeConditionalHibernateAfter,
  type WorkflowHibernateAfterResult,
  type WorkflowHibernateWindowSnapshot,
} from '../src/pilot/workflow-hibernate-window-guard.js';

const RUN_ID = 'run-hibernate-live-1';
const ATTEMPT_ID = 'attempt-hibernate-live-1';
const BEFORE_DEPLOYMENT_ID = '8b646225-4d71-4867-aff3-f22d137a8fa5';
const BEFORE_VERSION_ID = '6911feca-acf7-476a-b10c-cc61e71aedad';
const AFTER_DEPLOYMENT_ID = 'd78d2179-cac7-42cb-97d0-41b46a91aabd';
const AFTER_VERSION_ID = '7272a1c7-4dcc-42da-b087-314e94305a9a';
const SOURCE_SHA = 'e14d11e5420e04d49c042a01c562ff5432ebb98c';
const BUNDLE_SHA256 = '14b3ea16dd1d62b41639abe5680882a1f5dced3f19aee50305d95ac01b3adef8';
const OBSERVED_AT = '2026-07-29T05:10:00.000Z';

function beforeSnapshot(
  override: Partial<WorkflowHibernateWindowSnapshot> = {},
): WorkflowHibernateWindowSnapshot {
  return {
    observedAt: OBSERVED_AT,
    source: {
      headSha: SOURCE_SHA,
      bundleSha256: BUNDLE_SHA256,
      clean: true,
      matchingBundleBuilds: 2,
    },
    deployment: {
      deploymentId: BEFORE_DEPLOYMENT_ID,
      versionId: BEFORE_VERSION_ID,
      createdAt: '2026-07-29T04:56:43.836Z',
      trafficPercentage: 100,
      deploymentsDuringWait: 0,
    },
    run: {
      runId: RUN_ID,
      state: 'planning',
      activePlanId: null,
      analysisAttemptCount: 1,
      analysisDispatchOutboxCount: 1,
      workflowInstanceCount: 1,
    },
    analysis: {
      attemptId: ATTEMPT_ID,
      attemptStatus: 'running',
      dispatchOutboxId: 'dispatch-attempt-hibernate-live-1',
      dispatchOutboxState: 'settled',
      resultSignalOutboxCount: 0,
      actionRunId: '30430000001',
      actionStatus: 'in_progress',
      actionConclusion: null,
      actionRunCount: 1,
    },
    workflow: {
      instanceId: RUN_ID,
      status: 'waiting',
      registerRun: { status: 'complete', endedAt: '2026-07-29T05:08:00.000Z' },
      dispatchAnalysisAttempt: {
        status: 'complete',
        endedAt: '2026-07-29T05:08:01.000Z',
      },
      analysisWait: {
        status: 'waiting',
        startedAt: '2026-07-29T05:08:01.100Z',
        endedAt: null,
      },
      resumedStepCount: 0,
    },
    ...override,
  };
}

function afterResult(
  override: Partial<WorkflowHibernateAfterResult> = {},
): WorkflowHibernateAfterResult {
  return {
    deployment: {
      deploymentId: AFTER_DEPLOYMENT_ID,
      versionId: AFTER_VERSION_ID,
      createdAt: '2026-07-29T05:10:04.000Z',
      trafficPercentage: 100,
    },
    observedAt: '2026-07-29T05:10:05.000Z',
    workflow: {
      instanceId: RUN_ID,
      analysisWaitStartedAt: '2026-07-29T05:08:01.100Z',
      analysisWaitEndedAt: null,
    },
    deploymentsDuringWait: 1,
    ...override,
  };
}

const EXPECTED = {
  runId: RUN_ID,
  attemptId: ATTEMPT_ID,
  sourceSha: SOURCE_SHA,
  bundleSha256: BUNDLE_SHA256,
  beforeDeploymentId: BEFORE_DEPLOYMENT_ID,
  beforeVersionId: BEFORE_VERSION_ID,
  maximumSnapshotAgeMs: 5_000,
} as const;

describe('conditional Workflow hibernate after guard', () => {
  it('executes exactly one after deployment only after two fresh matching guards', async () => {
    const readSnapshot = vi.fn()
      .mockResolvedValueOnce(beforeSnapshot())
      .mockResolvedValueOnce(beforeSnapshot({ observedAt: '2026-07-29T05:10:01.000Z' }));
    const deployAfter = vi.fn().mockResolvedValue(afterResult());

    await expect(executeConditionalHibernateAfter(EXPECTED, {
      readSnapshot,
      deployAfter,
      now: () => new Date('2026-07-29T05:10:01.500Z'),
    })).resolves.toEqual({
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      beforeDeploymentId: BEFORE_DEPLOYMENT_ID,
      afterDeploymentId: AFTER_DEPLOYMENT_ID,
      afterVersionId: AFTER_VERSION_ID,
      deployed: true,
      rollbackAttempted: false,
    });
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(deployAfter).toHaveBeenCalledOnce();
    expect(deployAfter).toHaveBeenCalledWith({
      runId: RUN_ID,
      sourceSha: SOURCE_SHA,
      bundleSha256: BUNDLE_SHA256,
      expectedBeforeDeploymentId: BEFORE_DEPLOYMENT_ID,
      message: `phase1-hibernate-after run@${RUN_ID}`,
      strict: true,
    });
  });

  it.each([
    ['source SHA drift', { source: { headSha: 'f'.repeat(40), bundleSha256: BUNDLE_SHA256, clean: true, matchingBundleBuilds: 2 as const } }],
    ['bundle drift', { source: { headSha: SOURCE_SHA, bundleSha256: 'f'.repeat(64), clean: true, matchingBundleBuilds: 2 as const } }],
    ['dirty source', { source: { headSha: SOURCE_SHA, bundleSha256: BUNDLE_SHA256, clean: false, matchingBundleBuilds: 2 as const } }],
    ['single bundle build', { source: { headSha: SOURCE_SHA, bundleSha256: BUNDLE_SHA256, clean: true, matchingBundleBuilds: 1 as const } }],
    ['before deployment drift', { deployment: { ...beforeSnapshot().deployment, deploymentId: AFTER_DEPLOYMENT_ID } }],
    ['traffic drift', { deployment: { ...beforeSnapshot().deployment, trafficPercentage: 50 } }],
    ['prior wait deployment', { deployment: { ...beforeSnapshot().deployment, deploymentsDuringWait: 1 } }],
    ['duplicate attempt', { run: { ...beforeSnapshot().run, analysisAttemptCount: 2 } }],
    ['pending dispatch', { analysis: { ...beforeSnapshot().analysis, dispatchOutboxState: 'pending' as const } }],
    ['callback already stored', { analysis: { ...beforeSnapshot().analysis, attemptStatus: 'completed' as const, resultSignalOutboxCount: 1 } }],
    ['duplicate Action', { analysis: { ...beforeSnapshot().analysis, actionRunCount: 2 } }],
    ['Action completed', { analysis: { ...beforeSnapshot().analysis, actionStatus: 'completed' as const, actionConclusion: 'success' as const } }],
    ['wait ended', { workflow: { ...beforeSnapshot().workflow, analysisWait: { ...beforeSnapshot().workflow.analysisWait, status: 'complete' as const, endedAt: '2026-07-29T05:09:59.000Z' } } }],
    ['resumed step exists', { workflow: { ...beforeSnapshot().workflow, resumedStepCount: 1 } }],
  ])('fails closed before deploy on %s', async (_name, override) => {
    const deployAfter = vi.fn();
    await expect(executeConditionalHibernateAfter(EXPECTED, {
      readSnapshot: async () => beforeSnapshot(override as Partial<WorkflowHibernateWindowSnapshot>),
      deployAfter,
      now: () => new Date('2026-07-29T05:10:01.000Z'),
    })).rejects.toBeInstanceOf(WorkflowHibernateWindowGuardError);
    expect(deployAfter).not.toHaveBeenCalled();
  });

  it('revalidates immediately before deploy and refuses a callback race', async () => {
    const deployAfter = vi.fn();
    const readSnapshot = vi.fn()
      .mockResolvedValueOnce(beforeSnapshot())
      .mockResolvedValueOnce(beforeSnapshot({
        observedAt: '2026-07-29T05:10:01.000Z',
        analysis: {
          ...beforeSnapshot().analysis,
          attemptStatus: 'completed',
          resultSignalOutboxCount: 1,
          actionStatus: 'completed',
          actionConclusion: 'success',
        },
      }));
    await expect(executeConditionalHibernateAfter(EXPECTED, {
      readSnapshot,
      deployAfter,
      now: () => new Date('2026-07-29T05:10:01.500Z'),
    })).rejects.toMatchObject({ code: 'analysis_callback_already_recorded' });
    expect(deployAfter).not.toHaveBeenCalled();
  });

  it.each([
    ['same deployment', afterResult({ deployment: beforeSnapshot().deployment })],
    ['split traffic', afterResult({ deployment: { ...afterResult().deployment, trafficPercentage: 50 } })],
    ['extra deployment', afterResult({ deploymentsDuringWait: 2 })],
    ['wrong workflow', afterResult({ workflow: { ...afterResult().workflow, instanceId: 'run-other' } })],
    ['after outside wait', afterResult({ workflow: { ...afterResult().workflow, analysisWaitEndedAt: '2026-07-29T05:10:03.000Z' } })],
  ])('reports an invalid after result without attempting rollback: %s', async (_name, result) => {
    const deployAfter = vi.fn().mockResolvedValue(result);
    await expect(executeConditionalHibernateAfter(EXPECTED, {
      readSnapshot: async () => beforeSnapshot(),
      deployAfter,
      now: () => new Date('2026-07-29T05:10:01.000Z'),
    })).rejects.toBeInstanceOf(WorkflowHibernateWindowGuardError);
    expect(deployAfter).toHaveBeenCalledOnce();
  });

  it('rejects a stale guard snapshot before any production mutation', async () => {
    const deployAfter = vi.fn();
    await expect(executeConditionalHibernateAfter(EXPECTED, {
      readSnapshot: async () => beforeSnapshot({ observedAt: '2026-07-29T05:09:55.000Z' }),
      deployAfter,
      now: () => new Date('2026-07-29T05:10:01.000Z'),
    })).rejects.toMatchObject({ code: 'snapshot_stale' });
    expect(deployAfter).not.toHaveBeenCalled();
  });

  it('collapses deploy failures to a fixed code and never exposes provider output', async () => {
    const raw = 'Bearer production-secret-value';
    const error = await executeConditionalHibernateAfter(EXPECTED, {
      readSnapshot: async () => beforeSnapshot(),
      deployAfter: async () => { throw new Error(raw); },
      now: () => new Date('2026-07-29T05:10:01.000Z'),
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'after_deploy_failed' });
    expect(String(error)).not.toContain(raw);
  });

  it('rejects invalid immutable expectations before reading live state', async () => {
    const readSnapshot = vi.fn();
    const deployAfter = vi.fn();
    await expect(executeConditionalHibernateAfter(
      { ...EXPECTED, sourceSha: 'main' },
      { readSnapshot, deployAfter },
    )).rejects.toMatchObject({ code: 'configuration_invalid' });
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(deployAfter).not.toHaveBeenCalled();
  });

  it('does not let the operator widen the fixed five-second freshness bound', async () => {
    const readSnapshot = vi.fn();
    const deployAfter = vi.fn();
    await expect(executeConditionalHibernateAfter(
      { ...EXPECTED, maximumSnapshotAgeMs: 30_000 },
      { readSnapshot, deployAfter },
    )).rejects.toMatchObject({ code: 'configuration_invalid' });
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(deployAfter).not.toHaveBeenCalled();
  });
});
