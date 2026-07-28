import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ControlledReplayEvidenceManifestV1Schema,
  type ControlledReplayEvidenceManifestV1,
} from '../src/domain/controlled-replay-evidence.js';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  ControlledReplayEvidenceVerificationError,
  verifyControlledReplayEvidence,
} from '../src/pilot/controlled-replay-evidence-verifier.js';

const ACTION_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

const BASE_SHA = 'c'.repeat(40);

const BASE_MANIFEST: ControlledReplayEvidenceManifestV1 = {
  schemaVersion: '1',
  evidenceId: 'controlled-replay-evidence-1',
  repository: 'example/delivery-pilot',
  recordedAt: '2026-07-26T12:00:00.000Z',
  window: {
    startedAt: '2026-07-26T10:00:00.000Z',
    endedAt: '2026-07-26T11:30:00.000Z',
  },
  runId: 'run-controlled-replay-1',
  expectedRunState: 'succeeded',
  postReplayRunVersion: 9,
  planId: 'plan-controlled-replay-1',
  planVersion: 1,
  replay: {
    replayId: 'replay-controlled-1',
    expectedRunVersion: 8,
    planItemId: 'verify-release',
    effectSnapshotDigest: `sha256:${'1'.repeat(64)}`,
    outboxId: 'outbox-controlled-replay-1',
    createdAt: '2026-07-26T11:00:00.000Z',
    restartObservedAt: '2026-07-26T11:05:00.000Z',
    effects: [
      { effect: 'repo_write', approvalId: 'approval-repo-write-1' },
      { effect: 'test_deploy', approvalId: 'approval-test-deploy-1' },
    ],
    dispatchOutboxIds: ['outbox-execution-dispatch-1'],
  },
  agentActions: [{
    attemptId: 'attempt-implementation-1',
    actionRunId: '1001',
    workflowHeadSha: ACTION_SHA,
  }],
  pullRequest: {
    publicationId: 'publication-1',
    evidenceId: 'evidence-pr-1',
    number: 11,
    headBranch: 'delivery/task-1/attempt-1',
    headSha: HEAD_SHA,
  },
  deployments: [{
    kind: 'test',
    deploymentId: 'deployment-test-1',
    evidenceId: 'evidence-deployment-test-1',
    githubDeploymentId: '2001',
    environment: 'test',
    sha: HEAD_SHA,
  }],
};

function replayReconciliations() {
  return [
    {
      sourceKind: 'evidence',
      sourceRef: `d1://evidence/${BASE_MANIFEST.deployments[0]!.evidenceId}`,
      sourceDigest: `sha256:${'4'.repeat(64)}`,
      evidenceId: BASE_MANIFEST.deployments[0]!.evidenceId,
      evidenceKind: 'deployment',
      status: 'passed',
      verificationStatus: 'verified',
      sha: BASE_MANIFEST.deployments[0]!.sha,
    },
    {
      sourceKind: 'evidence',
      sourceRef: `d1://evidence/${BASE_MANIFEST.pullRequest.evidenceId}`,
      sourceDigest: `sha256:${'3'.repeat(64)}`,
      evidenceId: BASE_MANIFEST.pullRequest.evidenceId,
      evidenceKind: 'pull_request',
      status: 'passed',
      verificationStatus: 'verified',
      sha: BASE_MANIFEST.pullRequest.headSha,
    },
    {
      sourceKind: 'outbox',
      sourceRef: `d1://outbox/${BASE_MANIFEST.replay.dispatchOutboxIds[0]}`,
      sourceDigest: `sha256:${'2'.repeat(64)}`,
      outboxId: BASE_MANIFEST.replay.dispatchOutboxIds[0],
      outboxKind: 'execution_dispatch',
      deliveryState: 'settled',
    },
  ];
}

async function fixture(): Promise<ControlledReplayEvidenceManifestV1> {
  const target = {
    name: 'plan-v1-item-verify-release-verify',
    type: 'do' as const,
    count: 1,
  };
  const reconciliations = replayReconciliations();
  const effectSnapshotDigest = await canonicalSha256({
    target,
    effects: BASE_MANIFEST.replay.effects,
    reconciliations: reconciliations.map((source) => ({
      sourceKind: source.sourceKind,
      sourceRef: source.sourceRef,
      sourceDigest: source.sourceDigest,
    })),
  });
  return {
    ...BASE_MANIFEST,
    replay: { ...BASE_MANIFEST.replay, effectSnapshotDigest },
  };
}

function audit(
  manifest: ControlledReplayEvidenceManifestV1,
  options: {
    expiredApproval?: boolean;
    invalidApprovalDate?: boolean;
    extraDispatch?: boolean;
    extraCurrentOutbox?: boolean;
  } = {},
) {
  const deployment = manifest.deployments[0]!;
  const reconciliations = replayReconciliations();
  if (options.extraDispatch === true) {
    reconciliations.push({
      sourceKind: 'outbox',
      sourceRef: 'd1://outbox/outbox-duplicate-dispatch',
      sourceDigest: `sha256:${'9'.repeat(64)}`,
      outboxId: 'outbox-duplicate-dispatch',
      outboxKind: 'execution_dispatch',
      deliveryState: 'settled',
    });
  }
  const effectOutboxes = reconciliations.filter((source) => source.sourceKind === 'outbox')
    .map((source) => ({
      id: source.outboxId,
      kind: source.outboxKind,
      state: source.deliveryState,
      createdAt: '2026-07-26T10:20:00.000Z',
    }));
  if (options.extraCurrentOutbox === true) {
    effectOutboxes.push({
      id: 'outbox-post-replay-dispatch',
      kind: 'execution_dispatch',
      state: 'pending',
      createdAt: '2026-07-26T11:10:00.000Z',
    });
  }
  return {
    schemaVersion: '1',
    runId: manifest.runId,
    run: {
      state: manifest.expectedRunState,
      version: manifest.postReplayRunVersion,
      baseSha: BASE_SHA,
    },
    task: { repository: manifest.repository },
    answers: {
      who: { attempts: [] },
      checks: {
        replays: [{
          replayId: manifest.replay.replayId,
          expectedRunVersion: manifest.replay.expectedRunVersion,
          planId: manifest.planId,
          planVersion: manifest.planVersion,
          itemId: manifest.replay.planItemId,
          target: {
            kind: 'plan_item',
            name: `plan-v${manifest.planVersion}-item-${manifest.replay.planItemId}-verify`,
            type: 'do',
            count: 1,
          },
          reasonDigest: `sha256:${'5'.repeat(64)}`,
          effectSnapshotDigest: manifest.replay.effectSnapshotDigest,
          createdAt: manifest.replay.createdAt,
          updatedAt: manifest.replay.restartObservedAt,
          restartObservedAt: manifest.replay.restartObservedAt,
          outbox: { id: manifest.replay.outboxId, state: 'settled', attemptCount: 1 },
          effects: manifest.replay.effects,
          reconciliations,
        }],
        effectOutboxes,
      },
      approvals: manifest.replay.effects.map((effect) => ({
        approvalId: effect.approvalId,
        effect: effect.effect,
        decision: 'approve',
        planId: manifest.planId,
        planVersion: manifest.planVersion,
        baseSha: BASE_SHA,
        expiresAt: options.invalidApprovalDate === true
          ? 'invalid-date'
          : options.expiredApproval === true
            ? '2026-07-26T11:01:00.000Z'
            : '2026-07-27T11:00:00.000Z',
        invalidated: false,
        separationVerified: true,
      })),
      changes: [{
        kind: 'pull_request',
        publicationId: manifest.pullRequest.publicationId,
        repository: manifest.repository,
        headBranch: manifest.pullRequest.headBranch,
        headSha: manifest.pullRequest.headSha,
        status: 'verified',
        number: manifest.pullRequest.number,
        evidenceId: manifest.pullRequest.evidenceId,
      }],
      deployments: [{
        kind: deployment.kind,
        deploymentId: deployment.deploymentId,
        repository: manifest.repository,
        environment: deployment.environment,
        status: 'succeeded',
        sha: deployment.sha,
        githubDeploymentId: deployment.githubDeploymentId,
        evidenceId: deployment.evidenceId,
      }],
    },
  };
}

function correlation(
  manifest: ControlledReplayEvidenceManifestV1,
  options: { extraAction?: boolean } = {},
) {
  const action = manifest.agentActions[0]!;
  const deployment = manifest.deployments[0]!;
  const extra = options.extraAction === true
    ? [{
        kind: 'agent', id: '1002', attemptId: 'attempt-duplicate',
        status: 'completed', conclusion: 'success',
      }]
    : [];
  return {
    correlationId: manifest.runId,
    run: {
      id: manifest.runId,
      state: manifest.expectedRunState,
      version: manifest.postReplayRunVersion,
    },
    attempts: [{
      id: action.attemptId,
      status: 'completed',
      githubRunId: action.actionRunId,
      githubStatus: 'completed',
      githubConclusion: 'success',
    }],
    githubRuns: [{
      kind: 'agent',
      id: action.actionRunId,
      attemptId: action.attemptId,
      status: 'completed',
      conclusion: 'success',
    }, ...extra],
    pullRequests: [{
      publicationId: manifest.pullRequest.publicationId,
      status: 'verified',
      number: manifest.pullRequest.number,
      evidenceId: manifest.pullRequest.evidenceId,
    }],
    deployments: [{
      kind: deployment.kind,
      id: deployment.deploymentId,
      status: 'succeeded',
      sha: deployment.sha,
      githubDeploymentId: deployment.githubDeploymentId,
      evidenceId: deployment.evidenceId,
    }],
    truncated: {
      attempts: false,
      githubRuns: false,
      pullRequests: false,
      deployments: false,
    },
  };
}

function action(manifest: ControlledReplayEvidenceManifestV1, id = '1001') {
  const expected = manifest.agentActions[0]!;
  return {
    id: Number(id),
    status: 'completed',
    conclusion: 'success',
    head_sha: expected.workflowHeadSha,
    repository: { full_name: manifest.repository },
    event: 'workflow_dispatch',
    path: '.github/workflows/delivery-agent.yml',
    display_title: `delivery-loop/${expected.attemptId}`,
    created_at: '2026-07-26T10:15:00.000Z',
  };
}

function pull(manifest: ControlledReplayEvidenceManifestV1, number = 11) {
  return {
    number,
    created_at: '2026-07-26T10:30:00.000Z',
    head: {
      ref: manifest.pullRequest.headBranch,
      sha: manifest.pullRequest.headSha,
      repo: { full_name: manifest.repository },
    },
    base: { ref: 'main', repo: { full_name: manifest.repository } },
  };
}

function deployment(manifest: ControlledReplayEvidenceManifestV1, id = '2001') {
  const expected = manifest.deployments[0]!;
  return {
    id: Number(id),
    sha: expected.sha,
    task: `delivery-loop:${expected.kind}`,
    environment: expected.environment,
    created_at: '2026-07-26T10:45:00.000Z',
    payload: { delivery_deployment_id: expected.deploymentId },
  };
}

interface FakeOptions {
  expiredApproval?: boolean;
  invalidApprovalDate?: boolean;
  extraDispatch?: boolean;
  extraCurrentOutbox?: boolean;
  correlationExtraAction?: boolean;
  duplicateAction?: boolean;
  duplicatePullRequest?: boolean;
  duplicateDeployment?: boolean;
  pagination?: boolean;
  rawFailureCanary?: string;
}

function fakeFetch(
  manifest: ControlledReplayEvidenceManifestV1,
  options: FakeOptions = {},
): typeof fetch {
  const implementation = async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.origin === 'https://control.example') {
      if (url.pathname.endsWith('/audit')) {
        return Response.json(audit(manifest, {
          ...(options.expiredApproval === true ? { expiredApproval: true } : {}),
          ...(options.invalidApprovalDate === true ? { invalidApprovalDate: true } : {}),
          ...(options.extraDispatch === true ? { extraDispatch: true } : {}),
          ...(options.extraCurrentOutbox === true ? { extraCurrentOutbox: true } : {}),
        }));
      }
      return Response.json(correlation(
        manifest,
        options.correlationExtraAction === true ? { extraAction: true } : {},
      ));
    }
    if (
      options.rawFailureCanary !== undefined &&
      url.pathname.endsWith(`/actions/runs/${manifest.agentActions[0]!.actionRunId}`)
    ) return Response.json({ message: options.rawFailureCanary }, { status: 503 });
    if (url.pathname.endsWith('/actions/workflows/delivery-agent.yml/runs')) {
      const workflowRuns = [action(manifest)];
      if (options.duplicateAction === true) workflowRuns.push(action(manifest, '1002'));
      return Response.json(
        { total_count: workflowRuns.length, workflow_runs: workflowRuns },
        { headers: options.pagination === true
          ? { link: '<https://api.github.test/next>; rel="next"' }
          : {} },
      );
    }
    const actionMatch = url.pathname.match(/\/actions\/runs\/(\d+)$/);
    if (actionMatch !== null) return Response.json(action(manifest, actionMatch[1]));
    if (url.pathname.endsWith(`/pulls/${manifest.pullRequest.number}`)) {
      return Response.json(pull(manifest));
    }
    if (url.pathname.endsWith('/pulls')) {
      const pulls = [pull(manifest)];
      if (options.duplicatePullRequest === true) pulls.push(pull(manifest, 12));
      return Response.json(pulls);
    }
    if (url.pathname.endsWith('/deployments')) {
      const deployments = [deployment(manifest)];
      if (options.duplicateDeployment === true) deployments.push(deployment(manifest, '2002'));
      return Response.json(deployments);
    }
    if (url.pathname.endsWith('/deployments/2001/statuses')) {
      return Response.json([{ state: 'success', created_at: '2026-07-26T10:50:00.000Z' }]);
    }
    return Response.json({ message: 'not found' }, { status: 404 });
  };
  return implementation as typeof fetch;
}

function verify(manifest: ControlledReplayEvidenceManifestV1, fetcher: typeof fetch) {
  return verifyControlledReplayEvidence(manifest, {
    controlPlaneOrigin: 'https://control.example',
    operationsToken: 'CANARY_OPERATIONS_TOKEN',
    queryToken: 'CANARY_QUERY_TOKEN',
    githubToken: 'CANARY_GITHUB_TOKEN',
    githubApiOrigin: 'https://api.github.test',
    fetch: fetcher,
  });
}

describe('controlled replay live evidence', () => {
  it('keeps a strict, bounded, cross-field manifest and valid repository example', async () => {
    const manifest = await fixture();
    expect(ControlledReplayEvidenceManifestV1Schema.safeParse(manifest).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/controlled-replay-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(ControlledReplayEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(ControlledReplayEvidenceManifestV1Schema.safeParse({
      ...manifest,
      replay: {
        ...manifest.replay,
        effects: [manifest.replay.effects[0], manifest.replay.effects[0]],
      },
    }).success).toBe(false);
    expect(ControlledReplayEvidenceManifestV1Schema.safeParse({
      ...manifest,
      postReplayRunVersion: manifest.replay.expectedRunVersion,
    }).success).toBe(false);
    expect(ControlledReplayEvidenceManifestV1Schema.safeParse({
      ...manifest,
      rawNote: 'untrusted replay instruction',
    }).success).toBe(false);
  });

  it('cross-checks replay snapshot, approvals, correlation, and live GitHub inventories', async () => {
    const manifest = await fixture();
    const summary = await verify(manifest, fakeFetch(manifest));
    expect(summary).toEqual({
      schemaVersion: '1',
      evidenceId: manifest.evidenceId,
      repository: manifest.repository,
      runId: manifest.runId,
      replay: 'verified',
      duplicateDispatchCount: 0,
      duplicatePullRequestCount: 0,
      duplicateDeploymentCount: 0,
      verifiedAgentActionCount: 1,
      verifiedPullRequestCount: 1,
      verifiedDeploymentCount: 1,
    });
    expect(JSON.stringify(summary)).not.toContain('CANARY_');
  });

  it('rejects an expired approval or a second control-plane Agent Action', async () => {
    const manifest = await fixture();
    await expect(verify(manifest, fakeFetch(manifest, { expiredApproval: true })))
      .rejects.toMatchObject({ code: 'approval_snapshot_mismatch' });
    await expect(verify(manifest, fakeFetch(manifest, { correlationExtraAction: true })))
      .rejects.toMatchObject({ code: 'correlation_mismatch' });
    await expect(verify(manifest, fakeFetch(manifest, { invalidApprovalDate: true })))
      .rejects.toMatchObject({ code: 'approval_snapshot_mismatch' });
    await expect(verify(manifest, fakeFetch(manifest, { extraDispatch: true })))
      .rejects.toMatchObject({ code: 'replay_snapshot_mismatch' });
    await expect(verify(manifest, fakeFetch(manifest, { extraCurrentOutbox: true })))
      .rejects.toMatchObject({ code: 'replay_snapshot_mismatch' });
  });

  it('rejects duplicate Action, PR, or Deployment external inventory', async () => {
    const manifest = await fixture();
    await expect(verify(manifest, fakeFetch(manifest, { duplicateAction: true })))
      .rejects.toMatchObject({ code: 'github_action_mismatch' });
    await expect(verify(manifest, fakeFetch(manifest, { duplicatePullRequest: true })))
      .rejects.toMatchObject({ code: 'duplicate_pull_request' });
    await expect(verify(manifest, fakeFetch(manifest, { duplicateDeployment: true })))
      .rejects.toMatchObject({ code: 'duplicate_deployment' });
    await expect(verify(manifest, fakeFetch(manifest, { pagination: true })))
      .rejects.toMatchObject({ code: 'github_inventory_incomplete' });
  });

  it('never propagates upstream response text or credentials', async () => {
    const manifest = await fixture();
    const rawCanary = 'CANARY_RAW_REPLAY_RESPONSE';
    let failure: unknown;
    try {
      await verify(manifest, fakeFetch(manifest, { rawFailureCanary: rawCanary }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ControlledReplayEvidenceVerificationError);
    expect(String(failure)).not.toContain(rawCanary);
    expect(String(failure)).not.toContain('CANARY_OPERATIONS_TOKEN');
    expect(String(failure)).not.toContain('CANARY_QUERY_TOKEN');
    expect(String(failure)).not.toContain('CANARY_GITHUB_TOKEN');
    await expect(verify(manifest, (async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://control.example' && url.pathname.endsWith('/audit')) {
        return new Response(JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 1) }));
      }
      return await fakeFetch(manifest)(input, init);
    }) as typeof fetch)).rejects.toMatchObject({ code: 'control_plane_response_invalid' });
  });

  it('defaults the named E2E command to prerequisite exit 2 before live reads', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_CONTROLLED_REPLAY_E2E;
    environment.CONTROLLED_REPLAY_OPERATIONS_TOKEN = 'CANARY_OPERATIONS_TOKEN';
    environment.CONTROLLED_REPLAY_QUERY_TOKEN = 'CANARY_QUERY_TOKEN';
    environment.CONTROLLED_REPLAY_GITHUB_TOKEN = 'CANARY_GITHUB_TOKEN';
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/verify-controlled-replay-evidence.ts'],
      {
        cwd: resolve('.'),
        env: environment,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('controlled-replay-e2e: opt-in missing');
    expect(result.stderr).not.toContain('CANARY_');
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['e2e:controlled-replay'])
      .toBe('tsx scripts/verify-controlled-replay-evidence.ts');
  });
});
