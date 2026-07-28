import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  RunnerRecoveryEvidenceManifestV1Schema,
  type RunnerRecoveryEvidenceManifestV1,
} from '../src/domain/runner-recovery-evidence.js';
import {
  RunnerRecoveryEvidenceVerificationError,
  verifyRunnerRecoveryEvidence,
} from '../src/pilot/runner-recovery-evidence-verifier.js';

const CHECKPOINT_SHA = 'a'.repeat(40);
const RESULT_SHA = 'b'.repeat(40);
const LOST_WORKFLOW_SHA = 'd'.repeat(40);
const REPLACEMENT_WORKFLOW_SHA = 'e'.repeat(40);
const REPOSITORY = 'example/delivery-pilot';
const OPERATIONS_TOKEN = 'CANARY_RECOVERY_OPERATIONS_TOKEN';
const SECURITY_CANARY = `ghp_${'R'.repeat(36)}`;
const LOST_TOKEN_ID = 'token-attempt-lost-generation-1';
const LOST_TOKEN_REVOKED_AT = '2026-07-26T07:35:00.000Z';
const LOST_DISPATCH_OUTBOX_ID = 'outbox-attempt-lost-dispatch';
const REPLACEMENT_DISPATCH_OUTBOX_ID = 'outbox-attempt-replacement-dispatch';
const WORKFLOW_CANCEL_OUTBOX_ID = 'outbox-run-recovery-workflow-cancel';

function case8Body(options: {
  oldTokenActive?: boolean;
  workflowCancelState?: 'pending' | 'settled';
  extraEffect?: boolean;
} = {}) {
  const effectOutboxes = [
    { id: LOST_DISPATCH_OUTBOX_ID, kind: 'execution_dispatch', state: 'settled' },
    { id: REPLACEMENT_DISPATCH_OUTBOX_ID, kind: 'execution_dispatch', state: 'settled' },
    {
      id: WORKFLOW_CANCEL_OUTBOX_ID,
      kind: 'workflow_cancel',
      state: options.workflowCancelState ?? 'settled',
    },
  ];
  if (options.extraEffect === true) {
    effectOutboxes.push({
      id: 'outbox-duplicate-replacement-dispatch',
      kind: 'execution_dispatch',
      state: 'settled',
    });
  }
  return {
    schemaVersion: '1',
    runId: 'run-recovery-1',
    run: { state: 'succeeded', version: 8, baseSha: CHECKPOINT_SHA },
    task: { repository: REPOSITORY, revision: 'revision-recovery-1' },
    answers: {
      who: { attempts: [] },
      sourceEvents: [],
      permissions: {
        grants: [{
          tokenId: LOST_TOKEN_ID,
          attemptId: 'attempt-lost',
          leaseGeneration: 1,
          scopes: ['attempt:report'],
          expiresAt: '2026-07-26T08:10:00.000Z',
          revokedAt: options.oldTokenActive === true ? null : LOST_TOKEN_REVOKED_AT,
        }],
        repositoryWriteCredentials: [],
      },
      contextReads: [],
      changes: [],
      checks: { effectOutboxes, replays: [] },
      approvals: [],
      deployments: [],
    },
    digests: {},
    links: [],
  };
}

const CASE8_REPORT_DIGEST = await canonicalSha256(case8Body());

const MANIFEST: RunnerRecoveryEvidenceManifestV1 = {
  schemaVersion: '1',
  evidenceId: 'recovery-evidence-20260726',
  repository: REPOSITORY,
  recordedAt: '2026-07-26T08:00:00.000Z',
  runId: 'run-recovery-1',
  expectedRunState: 'succeeded',
  planId: 'plan-recovery-1',
  planVersion: 1,
  recoveredPlanItemId: 'item-implementation',
  case8ReportDigest: CASE8_REPORT_DIGEST,
  safety: { canaryDigest: await canonicalSha256(SECURITY_CANARY) },
  lost: {
    attemptId: 'attempt-lost',
    ordinal: 2,
    activeLeaseGenerationBeforeKill: 1,
    fencedLeaseGeneration: 2,
    tokenId: LOST_TOKEN_ID,
    tokenRevokedAt: LOST_TOKEN_REVOKED_AT,
    dispatchOutboxId: LOST_DISPATCH_OUTBOX_ID,
    workflowCancelOutboxId: WORKFLOW_CANCEL_OUTBOX_ID,
    actionRunId: '1001',
    workflowHeadSha: LOST_WORKFLOW_SHA,
  },
  checkpoint: {
    checkpointId: 'checkpoint-lost-3',
    sequence: 3,
    digest: `sha256:${'1'.repeat(64)}`,
    headBranch: 'delivery/run-recovery-1',
    headSha: CHECKPOINT_SHA,
  },
  replacement: {
    attemptId: 'attempt-replacement',
    ordinal: 3,
    leaseGeneration: 2,
    dispatchOutboxId: REPLACEMENT_DISPATCH_OUTBOX_ID,
    actionRunId: '1002',
    workflowHeadSha: REPLACEMENT_WORKFLOW_SHA,
    resultHeadSha: RESULT_SHA,
    verificationId: 'verification-implementation',
    evidenceId: 'evidence-implementation',
  },
  previouslyPassed: {
    planItemId: 'item-analysis',
    verificationId: 'verification-analysis',
    evidenceIds: ['evidence-analysis'],
  },
  sideEffects: {
    effectOutboxIds: [
      LOST_DISPATCH_OUTBOX_ID,
      REPLACEMENT_DISPATCH_OUTBOX_ID,
      WORKFLOW_CANCEL_OUTBOX_ID,
    ],
    pullRequestPublicationIds: [],
    deploymentIds: [],
    replacementCommitCount: 1,
  },
};

function planProjection(options: {
  rerunPassedItem?: boolean;
  staleLeaseGeneration?: boolean;
} = {}) {
  const attempts: Array<Record<string, unknown>> = [
    {
      id: 'attempt-analysis',
      ordinal: 1,
      status: 'completed',
      planId: MANIFEST.planId,
      planVersion: MANIFEST.planVersion,
      planItemId: MANIFEST.previouslyPassed.planItemId,
    },
    {
      id: MANIFEST.lost.attemptId,
      ordinal: MANIFEST.lost.ordinal,
      status: 'lost',
      leaseGeneration: options.staleLeaseGeneration === true
        ? MANIFEST.lost.activeLeaseGenerationBeforeKill
        : MANIFEST.lost.fencedLeaseGeneration,
      planId: MANIFEST.planId,
      planVersion: MANIFEST.planVersion,
      planItemId: MANIFEST.recoveredPlanItemId,
      headBranch: MANIFEST.checkpoint.headBranch,
      headSha: MANIFEST.checkpoint.headSha,
    },
    {
      id: MANIFEST.replacement.attemptId,
      ordinal: MANIFEST.replacement.ordinal,
      status: 'completed',
      leaseGeneration: MANIFEST.replacement.leaseGeneration,
      planId: MANIFEST.planId,
      planVersion: MANIFEST.planVersion,
      planItemId: MANIFEST.recoveredPlanItemId,
      headBranch: MANIFEST.checkpoint.headBranch,
      headSha: MANIFEST.replacement.resultHeadSha,
      recovery: {
        recoveredFromAttemptId: MANIFEST.lost.attemptId,
        checkpointId: MANIFEST.checkpoint.checkpointId,
      },
    },
  ];
  if (options.rerunPassedItem === true) {
    attempts.push({
      id: 'attempt-analysis-repeated',
      ordinal: 4,
      status: 'completed',
      planId: MANIFEST.planId,
      planVersion: MANIFEST.planVersion,
      planItemId: MANIFEST.previouslyPassed.planItemId,
    });
  }
  return {
    run: { id: MANIFEST.runId, state: MANIFEST.expectedRunState },
    plan: { id: MANIFEST.planId, version: MANIFEST.planVersion, status: 'completed' },
    attempts,
    checkpoints: [{
      id: MANIFEST.checkpoint.checkpointId,
      attemptId: MANIFEST.lost.attemptId,
      sequence: MANIFEST.checkpoint.sequence,
      payloadDigest: MANIFEST.checkpoint.digest,
      planId: MANIFEST.planId,
      planVersion: MANIFEST.planVersion,
      planItemId: MANIFEST.recoveredPlanItemId,
      headSha: MANIFEST.checkpoint.headSha,
    }],
    items: [
      {
        id: MANIFEST.previouslyPassed.planItemId,
        status: 'passed',
        verificationDecision: {
          id: MANIFEST.previouslyPassed.verificationId,
          evidenceIds: MANIFEST.previouslyPassed.evidenceIds,
        },
      },
      {
        id: MANIFEST.recoveredPlanItemId,
        status: 'passed',
        verificationDecision: {
          id: MANIFEST.replacement.verificationId,
          evidenceIds: [MANIFEST.replacement.evidenceId],
        },
      },
    ],
    evidence: [
      {
        id: MANIFEST.previouslyPassed.evidenceIds[0],
        attemptId: 'attempt-analysis',
        planId: MANIFEST.planId,
        planVersion: MANIFEST.planVersion,
        planItemId: MANIFEST.previouslyPassed.planItemId,
        status: 'passed',
        verificationStatus: 'verified',
        sha: CHECKPOINT_SHA,
      },
      {
        id: MANIFEST.replacement.evidenceId,
        attemptId: MANIFEST.replacement.attemptId,
        planId: MANIFEST.planId,
        planVersion: MANIFEST.planVersion,
        planItemId: MANIFEST.recoveredPlanItemId,
        status: 'passed',
        verificationStatus: 'verified',
        sha: MANIFEST.replacement.resultHeadSha,
      },
    ],
  };
}

function correlationProjection() {
  return {
    correlationId: MANIFEST.runId,
    attempts: [
      {
        id: MANIFEST.lost.attemptId,
        status: 'lost',
        githubRunId: MANIFEST.lost.actionRunId,
        githubStatus: 'completed',
        githubConclusion: 'cancelled',
      },
      {
        id: MANIFEST.replacement.attemptId,
        status: 'completed',
        githubRunId: MANIFEST.replacement.actionRunId,
        githubStatus: 'completed',
        githubConclusion: 'success',
      },
    ],
    githubRuns: [
      {
        kind: 'agent',
        id: MANIFEST.lost.actionRunId,
        attemptId: MANIFEST.lost.attemptId,
        status: 'completed',
        conclusion: 'cancelled',
      },
      {
        kind: 'agent',
        id: MANIFEST.replacement.actionRunId,
        attemptId: MANIFEST.replacement.attemptId,
        status: 'completed',
        conclusion: 'success',
      },
    ],
    pullRequests: [],
    deployments: [],
    truncated: {
      attempts: false,
      githubRuns: false,
      pullRequests: false,
      deployments: false,
      traces: false,
    },
  };
}

type Conclusion = 'cancelled' | 'success' | 'failure';

function action(runId: string, conclusion: Conclusion) {
  const lost = runId === MANIFEST.lost.actionRunId;
  return {
    id: Number(runId),
    status: 'completed',
    conclusion,
    head_sha: lost ? MANIFEST.lost.workflowHeadSha : MANIFEST.replacement.workflowHeadSha,
    repository: { full_name: MANIFEST.repository },
    event: 'workflow_dispatch',
    path: '.github/workflows/delivery-agent.yml',
    display_title: `delivery-loop/${lost
      ? MANIFEST.lost.attemptId
      : MANIFEST.replacement.attemptId}`,
  };
}

function jobs(conclusion: Conclusion) {
  return {
    total_count: 1,
    jobs: [{
      name: 'attempt',
      status: 'completed',
      conclusion,
      steps: [
        {
          name: 'Checkout trusted execution snapshot',
          status: 'completed',
          conclusion: 'success',
        },
        {
          name: 'Run approved execution attempt',
          status: 'completed',
          conclusion,
        },
      ],
    }],
  };
}

interface FakeOptions {
  lostActionConclusion?: Conclusion;
  replacementActionConclusion?: Conclusion;
  replacementJobConclusion?: Conclusion;
  rerunPassedItem?: boolean;
  staleLeaseGeneration?: boolean;
  oldTokenActive?: boolean;
  workflowCancelState?: 'pending' | 'settled';
  extraEffect?: boolean;
  case8DigestDrift?: boolean;
  credentialCanary?: boolean;
  paginatedGitHub?: boolean;
  rawFailureCanary?: string;
  branchHeadSha?: string;
  compareStatus?: 'ahead' | 'diverged';
}

function fakeFetch(options: FakeOptions = {}): typeof fetch {
  const implementation = async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.origin === 'https://control.example') {
      if (url.pathname.endsWith('/plan')) {
        const projection = planProjection({
          ...(options.rerunPassedItem === true ? { rerunPassedItem: true } : {}),
          ...(options.staleLeaseGeneration === true ? { staleLeaseGeneration: true } : {}),
        });
        return Response.json(options.credentialCanary === true
          ? { ...projection, credentialLeak: SECURITY_CANARY }
          : projection);
      }
      if (url.pathname.endsWith('/audit')) {
        const body = case8Body({
          ...(options.oldTokenActive === true ? { oldTokenActive: true } : {}),
          ...(options.workflowCancelState === undefined
            ? {} : { workflowCancelState: options.workflowCancelState }),
          ...(options.extraEffect === true ? { extraEffect: true } : {}),
        });
        return Response.json({
          ...body,
          generatedAt: '2026-07-26T07:59:00.000Z',
          queryDurationMs: 10,
          reportDigest: options.case8DigestDrift === true
            ? `sha256:${'9'.repeat(64)}`
            : await canonicalSha256(body),
        });
      }
      return Response.json(correlationProjection());
    }
    if (
      options.rawFailureCanary !== undefined &&
      url.pathname.endsWith(`/actions/runs/${MANIFEST.replacement.actionRunId}`)
    ) {
      return Response.json({ message: options.rawFailureCanary }, { status: 503 });
    }
    const actionMatch = url.pathname.match(/\/actions\/runs\/(\d+)$/);
    if (actionMatch !== null) {
      const runId = actionMatch[1]!;
      const conclusion = runId === MANIFEST.lost.actionRunId
        ? options.lostActionConclusion ?? 'cancelled'
        : options.replacementActionConclusion ?? 'success';
      return Response.json(action(runId, conclusion));
    }
    const jobsMatch = url.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
    if (jobsMatch !== null) {
      const runId = jobsMatch[1]!;
      const conclusion = runId === MANIFEST.lost.actionRunId
        ? 'cancelled'
        : options.replacementJobConclusion ?? 'success';
      return Response.json(jobs(conclusion), options.paginatedGitHub === true
        ? { headers: { link: '<https://api.github.test/next>; rel="next"' } }
        : undefined);
    }
    const commitMatch = url.pathname.match(/\/commits\/([a-f0-9]{40})$/);
    if (commitMatch !== null) return Response.json({ sha: commitMatch[1] });
    if (url.pathname.includes('/git/ref/heads/')) {
      return Response.json({
        ref: `refs/heads/${MANIFEST.checkpoint.headBranch}`,
        object: {
          type: 'commit',
          sha: options.branchHeadSha ?? MANIFEST.replacement.resultHeadSha,
        },
      });
    }
    if (url.pathname.includes('/compare/')) {
      const ahead = options.compareStatus !== 'diverged';
      return Response.json({
        status: ahead ? 'ahead' : 'diverged',
        ahead_by: 1,
        behind_by: ahead ? 0 : 1,
        total_commits: 1,
        base_commit: { sha: MANIFEST.checkpoint.headSha },
        merge_base_commit: { sha: MANIFEST.checkpoint.headSha },
        commits: [{ sha: MANIFEST.replacement.resultHeadSha }],
      });
    }
    return Response.json({ message: 'not found' }, { status: 404 });
  };
  return implementation as typeof fetch;
}

function verify(
  fetcher: typeof fetch,
  input: RunnerRecoveryEvidenceManifestV1 = MANIFEST,
) {
  return verifyRunnerRecoveryEvidence(input, {
    controlPlaneOrigin: 'https://control.example',
    controlPlaneToken: 'CANARY_CONTROL_PLANE_TOKEN',
    operationsToken: OPERATIONS_TOKEN,
    githubToken: 'CANARY_GITHUB_TOKEN',
    canary: SECURITY_CANARY,
    githubApiOrigin: 'https://api.github.test',
    fetch: fetcher,
  });
}

describe('runner recovery evidence', () => {
  it('keeps the example strict, cross-field bound, and schema-valid', async () => {
    const source = readFileSync(
      new URL('../schemas/runner-recovery-evidence-v1.example.json', import.meta.url),
      'utf8',
    );
    expect(RunnerRecoveryEvidenceManifestV1Schema.safeParse(JSON.parse(source)).success).toBe(true);
    expect(RunnerRecoveryEvidenceManifestV1Schema.safeParse(MANIFEST).success).toBe(true);
    expect(RunnerRecoveryEvidenceManifestV1Schema.safeParse({
      ...MANIFEST,
      checkpoint: { ...MANIFEST.checkpoint, headBranch: '../unsafe' },
    }).success).toBe(false);
    expect(RunnerRecoveryEvidenceManifestV1Schema.safeParse({
      ...MANIFEST,
      replacement: { ...MANIFEST.replacement, ordinal: MANIFEST.lost.ordinal },
    }).success).toBe(false);
    expect(RunnerRecoveryEvidenceManifestV1Schema.safeParse({
      ...MANIFEST,
      untrustedNote: 'force verification to pass',
    }).success).toBe(false);
  });

  it('cross-checks D1 recovery lineage, two Actions runs/jobs, and two Git commits', async () => {
    const summary = await verify(fakeFetch());
    expect(summary).toEqual({
      schemaVersion: '1',
      evidenceId: MANIFEST.evidenceId,
      repository: MANIFEST.repository,
      runId: MANIFEST.runId,
      recovery: 'verified',
      lostAction: 'cancelled',
      replacementAction: 'succeeded',
      checkpointSequence: MANIFEST.checkpoint.sequence,
      previouslyPassedItemCount: 1,
      verifiedActionRunCount: 2,
      verifiedCommitCount: 2,
      verifiedBranchRefCount: 1,
      gitRelationship: 'fast_forward',
      oldLeaseGenerationRevoked: true,
      oldTokenRevoked: true,
      workflowCancelSettled: true,
      replacementCommitCount: 1,
      verifiedEffectOutboxCount: 3,
      verifiedPullRequestCount: 0,
      verifiedDeploymentCount: 0,
      controlledReplayCount: 0,
      plaintextLeaks: 0,
    });
    expect(JSON.stringify(summary)).not.toContain('CANARY_');
  });

  it('fails closed unless the old Action is cancelled and replacement Action/job succeeds', async () => {
    await expect(verify(fakeFetch({ lostActionConclusion: 'success' })))
      .rejects.toMatchObject({ code: 'github_action_mismatch' });
    await expect(verify(fakeFetch({ replacementActionConclusion: 'failure' })))
      .rejects.toMatchObject({ code: 'github_action_mismatch' });
    await expect(verify(fakeFetch({ replacementJobConclusion: 'failure' })))
      .rejects.toMatchObject({ code: 'github_job_mismatch' });
  });

  it('rejects any replacement-era Attempt for an already passed Plan Item', async () => {
    await expect(verify(fakeFetch({ rerunPassedItem: true })))
      .rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
  });

  it('requires the lost lease generation, token, and Workflow cancellation to be fenced', async () => {
    await expect(verify(fakeFetch({ staleLeaseGeneration: true })))
      .rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
    await expect(verify(
      fakeFetch({ oldTokenActive: true }),
      { ...MANIFEST, case8ReportDigest: await canonicalSha256(case8Body({ oldTokenActive: true })) },
    ))
      .rejects.toMatchObject({ code: 'control_plane_recovery_mismatch' });
    await expect(verify(
      fakeFetch({ workflowCancelState: 'pending' }),
      {
        ...MANIFEST,
        case8ReportDigest: await canonicalSha256(case8Body({ workflowCancelState: 'pending' })),
      },
    )).rejects.toMatchObject({ code: 'control_plane_side_effect_mismatch' });
  });

  it('binds Case 8 digest and rejects any unaccounted recovery side effect', async () => {
    await expect(verify(fakeFetch({ case8DigestDrift: true })))
      .rejects.toMatchObject({ code: 'control_plane_report_mismatch' });
    await expect(verify(
      fakeFetch({ extraEffect: true }),
      { ...MANIFEST, case8ReportDigest: await canonicalSha256(case8Body({ extraEffect: true })) },
    )).rejects.toMatchObject({ code: 'control_plane_side_effect_mismatch' });
  });

  it('requires the trusted branch to point at a fast-forward descendant of the checkpoint', async () => {
    await expect(verify(fakeFetch({ branchHeadSha: CHECKPOINT_SHA })))
      .rejects.toMatchObject({ code: 'github_git_relationship_mismatch' });
    await expect(verify(fakeFetch({ compareStatus: 'diverged' })))
      .rejects.toMatchObject({ code: 'github_git_relationship_mismatch' });
  });

  it('never propagates upstream response text or credentials', async () => {
    const rawCanary = 'CANARY_RAW_RECOVERY_API_RESPONSE';
    let failure: unknown;
    try {
      await verify(fakeFetch({ rawFailureCanary: rawCanary }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RunnerRecoveryEvidenceVerificationError);
    expect(String(failure)).not.toContain(rawCanary);
    expect(String(failure)).not.toContain('CANARY_CONTROL_PLANE_TOKEN');
    expect(String(failure)).not.toContain('CANARY_GITHUB_TOKEN');
    await expect(verify((async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://control.example' && url.pathname.endsWith('/plan')) {
        return new Response(JSON.stringify({ padding: 'x'.repeat(513 * 1_024) }));
      }
      return await fakeFetch()(input, init);
    }) as typeof fetch)).rejects.toMatchObject({ code: 'control_plane_response_invalid' });
    await expect(verify(fakeFetch({ credentialCanary: true })))
      .rejects.toMatchObject({ code: 'secret_leak_detected' });
    await expect(verify(fakeFetch({ paginatedGitHub: true })))
      .rejects.toMatchObject({ code: 'github_response_invalid' });
  });

  it('puts every live request behind a ten-second abort signal', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetcher = (async (input, init) => {
      signals.push(init?.signal);
      return await fakeFetch()(input, init);
    }) as typeof fetch;
    await expect(verify(fetcher)).resolves.toMatchObject({ recovery: 'verified' });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it('defaults the named E2E command to prerequisite exit 2 with zero live calls', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_RUNNER_RECOVERY_E2E;
    environment.RECOVERY_CONTROL_PLANE_TOKEN = 'CANARY_CONTROL_PLANE_TOKEN';
    environment.RECOVERY_GITHUB_TOKEN = 'CANARY_GITHUB_TOKEN';
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/verify-runner-recovery-evidence.ts'],
      {
        cwd: resolve('.'),
        env: environment,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('runner-recovery-e2e: opt-in missing');
    expect(result.stderr).not.toContain('CANARY_');
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['e2e:runner-recovery'])
      .toBe('tsx scripts/verify-runner-recovery-evidence.ts');
  });
});
