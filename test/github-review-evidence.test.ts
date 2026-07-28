import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  GitHubReviewFeedbackEvidenceManifestV1Schema,
  type GitHubReviewFeedbackEvidenceManifestV1,
} from '../src/domain/github-review-feedback-evidence.js';
import { verifyGitHubReviewFeedbackEvidence } from '../src/pilot/github-review-feedback-evidence-verifier.js';

const REPOSITORY = 'example/delivery-pilot';
const RUN_ID = 'run-github-review-evidence-1';
const PUBLICATION_ID = 'pr-publication-review-evidence-1';
const REVIEW_HEAD_SHA = 'a'.repeat(40);
const RESULT_HEAD_SHA = 'b'.repeat(40);
const STALE_HEAD_SHA = 'c'.repeat(40);
const PLAN_BASE_SHA = 'd'.repeat(40);
const PLAN_DIGEST = `sha256:${'4'.repeat(64)}`;
const CANARY = 'github_pat_REVIEW_LOOP_CANARY_1234567890';
const BRANCH = 'delivery/task-evidence/attempt-1';
const REVIEW_BODY = 'Please fix the retry race and keep the existing permission boundary.';
const REVIEW_URL = 'https://github.com/example/delivery-pilot/pull/42';
const CLEAN_REVIEW_URL = 'https://github.com/example/delivery-pilot/pull/42';

const MANIFEST: GitHubReviewFeedbackEvidenceManifestV1 = {
  schemaVersion: '1',
  evidenceId: 'github-review-evidence-1',
  recordedAt: '2026-07-26T16:00:00.000Z',
  runId: RUN_ID,
  repository: REPOSITORY,
  case8ReportDigest: `sha256:${'5'.repeat(64)}`,
  plan: {
    planId: 'plan-review-evidence-1',
    version: 1,
    digest: PLAN_DIGEST,
    baseSha: PLAN_BASE_SHA,
    itemId: 'review-item',
  },
  publication: {
    publicationId: PUBLICATION_ID,
    number: 42,
    url: CLEAN_REVIEW_URL,
    baseBranch: 'main',
    headBranch: BRANCH,
    reviewedHeadSha: REVIEW_HEAD_SHA,
  },
  appliedReview: {
    deliveryId: 'delivery-review-evidence-1',
    payloadDigest: `sha256:${'1'.repeat(64)}`,
    reviewId: '9001',
    reviewUrl: REVIEW_URL,
    reviewerLogin: 'human-reviewer',
    reviewerType: 'User',
    bodyDigest: `sha256:${'2'.repeat(64)}`,
    reviewedHeadSha: REVIEW_HEAD_SHA,
    processingState: 'applied',
    receivedAt: '2026-07-26T15:40:00.000Z',
    processedAt: '2026-07-26T15:40:01.000Z',
    submittedAt: '2026-07-26T15:39:59.000Z',
    feedbackId: 'review-feedback-evidence-1',
    priorAttemptId: 'attempt-review-prior-1',
    reviewAttemptId: 'attempt-review-fix-1',
    branch: BRANCH,
  },
  staleReview: {
    deliveryId: 'delivery-review-evidence-stale',
    payloadDigest: `sha256:${'3'.repeat(64)}`,
    reviewId: '9002',
    reviewedHeadSha: STALE_HEAD_SHA,
    processingState: 'ignored',
    ignoreReason: 'stale_head',
    receivedAt: '2026-07-26T15:45:00.000Z',
    processedAt: '2026-07-26T15:45:01.000Z',
  },
  replacement: {
    attemptId: 'attempt-review-fix-1',
    priorAttemptId: 'attempt-review-prior-1',
    actionRunId: '70042',
    actionWorkflowPath: '.github/workflows/delivery-agent.yml',
    actionTitle: 'delivery-loop/attempt-review-fix-1',
    actionWorkflowHeadSha: PLAN_BASE_SHA,
    actionHeadBranch: 'main',
    actionStatus: 'completed',
    actionConclusion: 'success',
    checkoutSha: REVIEW_HEAD_SHA,
    claimedProgressVersion: 3,
    updateId: 'head-update-review-fix-1',
    commitEvidenceId: 'commit-evidence-review-fix-1',
    resultHeadSha: RESULT_HEAD_SHA,
    branch: BRANCH,
    testSuite: {
      suiteId: 'suite-review-fix-1',
      deliveryPolicyDigest: `sha256:${'6'.repeat(64)}`,
      commands: [
        {
          position: 0, phase: 'targeted', commandRef: 'test:targeted',
          evidenceId: 'test-evidence-review-targeted-1',
        },
        {
          position: 1, phase: 'required', commandRef: 'verify:required',
          evidenceId: 'test-evidence-review-required-1',
        },
      ],
    },
    itemVerification: {
      verificationId: 'verification-review-fix-1',
      evidenceSetDigest: `sha256:${'7'.repeat(64)}`,
      evidenceIds: [
        'commit-evidence-review-fix-1',
        'test-evidence-review-targeted-1',
        'test-evidence-review-required-1',
      ],
    },
    checks: [{ name: 'required', conclusion: 'success' }],
  },
  safety: { canaryDigest: `sha256:${'8'.repeat(64)}` },
};

async function fixture(): Promise<GitHubReviewFeedbackEvidenceManifestV1> {
  const manifest = {
    ...MANIFEST,
    appliedReview: {
      ...MANIFEST.appliedReview,
      bodyDigest: await canonicalSha256(REVIEW_BODY),
    },
    safety: { canaryDigest: await canonicalSha256(CANARY) },
  };
  return {
    ...manifest,
    case8ReportDigest: await canonicalSha256(auditBody(manifest)),
  };
}

function auditBody(manifest: GitHubReviewFeedbackEvidenceManifestV1): Record<string, unknown> {
  const p = manifest.publication;
  const review = manifest.appliedReview;
  const stale = manifest.staleReview;
  const replacement = manifest.replacement;
  const plan = manifest.plan;
  const commandRows = replacement.testSuite.commands.map((command) => ({
    suiteId: replacement.testSuite.suiteId,
    attemptId: replacement.attemptId,
    planId: plan.planId,
    planVersion: plan.version,
    itemId: plan.itemId,
    headSha: replacement.resultHeadSha,
    deliveryPolicyDigest: replacement.testSuite.deliveryPolicyDigest,
    suiteStatus: 'completed',
    ...command,
    status: 'passed',
    observedAt: '2026-07-26T15:55:00.000Z',
  }));
  const evidence = [{
    evidenceId: replacement.commitEvidenceId,
    attemptId: replacement.attemptId,
    planId: plan.planId,
    planVersion: plan.version,
    itemId: plan.itemId,
    kind: 'commit',
    status: 'passed',
    verificationStatus: 'verified',
    sha: replacement.resultHeadSha,
    observedAt: '2026-07-26T15:52:00.000Z',
  }, ...replacement.testSuite.commands.map((command) => ({
    evidenceId: command.evidenceId,
    attemptId: replacement.attemptId,
    planId: plan.planId,
    planVersion: plan.version,
    itemId: plan.itemId,
    kind: 'test',
    status: 'passed',
    verificationStatus: 'verified',
    commandRef: command.commandRef,
    exitCode: 0,
    durationMs: 100,
    sha: replacement.resultHeadSha,
    observedAt: '2026-07-26T15:55:00.000Z',
  }))];
  return {
    schemaVersion: '1',
    runId: manifest.runId,
    run: {
      state: 'executing', version: 13, baseSha: plan.baseSha,
      activePlanId: plan.planId, activePlanVersion: plan.version,
      activePlanDigest: plan.digest,
    },
    task: { repository: manifest.repository },
    answers: {
      who: {
        attempts: [
          {
            attemptId: replacement.priorAttemptId,
            ordinal: 2,
            mode: 'implement',
            status: 'completed',
            repository: manifest.repository,
            planId: plan.planId,
            planVersion: plan.version,
            itemId: plan.itemId,
            claimedProgressVersion: 1,
            baseSha: plan.baseSha,
            headSha: p.reviewedHeadSha,
            createdAt: '2026-07-26T14:00:00.000Z',
            updatedAt: '2026-07-26T15:30:00.000Z',
          },
          {
            attemptId: replacement.attemptId,
            ordinal: 3,
            mode: 'review_fix',
            status: 'completed',
            repository: manifest.repository,
            planId: plan.planId,
            planVersion: plan.version,
            itemId: plan.itemId,
            claimedProgressVersion: replacement.claimedProgressVersion,
            baseSha: plan.baseSha,
            headSha: replacement.resultHeadSha,
            githubRunId: replacement.actionRunId,
            githubStatus: replacement.actionStatus,
            githubConclusion: replacement.actionConclusion,
            createdAt: '2026-07-26T15:40:01.000Z',
            updatedAt: '2026-07-26T15:56:00.000Z',
          },
        ],
      },
      changes: [{
        kind: 'pull_request',
        publicationId: p.publicationId,
        repository: manifest.repository,
        baseBranch: p.baseBranch,
        headBranch: p.headBranch,
        headSha: p.reviewedHeadSha,
        status: 'verified',
        number: p.number,
        url: p.url,
      }, {
        kind: 'commit',
        updateId: replacement.updateId,
        attemptId: replacement.attemptId,
        planId: plan.planId,
        planVersion: plan.version,
        itemId: plan.itemId,
        parentSha: replacement.checkoutSha,
        headSha: replacement.resultHeadSha,
        branch: replacement.branch,
        evidenceId: replacement.commitEvidenceId,
        createdAt: '2026-07-26T15:52:00.000Z',
      }],
      checks: {
        commands: commandRows,
        itemVerifications: [{
          verificationId: replacement.itemVerification.verificationId,
          planId: plan.planId,
          planVersion: plan.version,
          itemId: plan.itemId,
          attemptId: replacement.attemptId,
          headSha: replacement.resultHeadSha,
          evidenceSetDigest: replacement.itemVerification.evidenceSetDigest,
          status: 'passed',
          verifiedAt: '2026-07-26T15:56:00.000Z',
        }],
        evidence,
        reviewObservations: [
          {
            sourceKind: 'webhook', sourceId: review.deliveryId,
            publicationId: p.publicationId, repository: manifest.repository,
            githubPrNumber: p.number, githubReviewId: review.reviewId,
            reviewedHeadSha: review.reviewedHeadSha,
            factDigest: review.payloadDigest,
            processingState: review.processingState,
            ignoreReason: null,
            observedAt: review.receivedAt, processedAt: review.processedAt,
            feedbackId: review.feedbackId,
            priorAttemptId: review.priorAttemptId,
            reviewAttemptId: review.reviewAttemptId,
            sourceHeadSha: review.reviewedHeadSha,
            branch: review.branch,
            reviewUrl: review.reviewUrl,
            submittedAt: review.submittedAt,
            bodyDigest: review.bodyDigest,
          },
          {
            sourceKind: 'webhook', sourceId: stale.deliveryId,
            publicationId: p.publicationId, repository: manifest.repository,
            githubPrNumber: p.number, githubReviewId: stale.reviewId,
            reviewedHeadSha: stale.reviewedHeadSha,
            factDigest: stale.payloadDigest,
            processingState: stale.processingState,
            ignoreReason: stale.ignoreReason,
            observedAt: stale.receivedAt, processedAt: stale.processedAt,
            feedbackId: null, priorAttemptId: null, reviewAttemptId: null,
            sourceHeadSha: null, branch: null, reviewUrl: null,
            submittedAt: null, bodyDigest: null,
          },
        ],
      },
    },
    digests: {
      task: `sha256:${'9'.repeat(64)}`,
      plans: [{
        planId: plan.planId, version: plan.version, digest: plan.digest,
        status: 'active', baseSha: plan.baseSha,
      }],
      evidenceArtifacts: [],
    },
    links: [{ kind: 'pull_request', url: p.url }],
  };
}

function planView(manifest: GitHubReviewFeedbackEvidenceManifestV1): Record<string, unknown> {
  const plan = manifest.plan;
  const replacement = manifest.replacement;
  const evidence = [{
    id: replacement.commitEvidenceId,
    attemptId: replacement.attemptId,
    planId: plan.planId,
    planVersion: plan.version,
    planItemId: plan.itemId,
    kind: 'commit',
    status: 'passed',
    verificationStatus: 'verified',
    sha: replacement.resultHeadSha,
  }, ...replacement.testSuite.commands.map((command) => ({
    id: command.evidenceId,
    attemptId: replacement.attemptId,
    planId: plan.planId,
    planVersion: plan.version,
    planItemId: plan.itemId,
    kind: 'test',
    status: 'passed',
    verificationStatus: 'verified',
    commandRef: command.commandRef,
    exitCode: 0,
    sha: replacement.resultHeadSha,
  }))];
  return {
    run: { id: manifest.runId, state: 'executing', version: 13 },
    plan: {
      id: plan.planId, version: plan.version, digest: plan.digest,
      baseSha: plan.baseSha, status: 'active',
    },
    items: [{
      id: plan.itemId, kind: 'change', required: true, status: 'passed',
      progressVersion: replacement.claimedProgressVersion + 2,
      commandRefs: replacement.testSuite.commands.map((command) => command.commandRef),
      evidenceKinds: ['commit', 'test'], effects: ['repo_write'],
      verificationDecision: {
        id: replacement.itemVerification.verificationId,
        headSha: replacement.resultHeadSha,
        evidenceSetDigest: replacement.itemVerification.evidenceSetDigest,
        evidenceIds: replacement.itemVerification.evidenceIds,
        doneWhenEvidence: [{
          position: 0, evidenceIds: replacement.itemVerification.evidenceIds,
        }],
        verifiedAt: '2026-07-26T15:56:00.000Z',
      },
    }],
    attempts: [{
      id: replacement.priorAttemptId, mode: 'implement', status: 'completed',
      planId: plan.planId, planVersion: plan.version, planItemId: plan.itemId,
      headBranch: replacement.branch, headSha: replacement.checkoutSha,
    }, {
      id: replacement.attemptId, mode: 'review_fix', status: 'completed',
      planId: plan.planId, planVersion: plan.version, planItemId: plan.itemId,
      headBranch: replacement.branch, headSha: replacement.resultHeadSha,
      githubRunId: replacement.actionRunId,
      githubStatus: replacement.actionStatus,
      githubConclusion: replacement.actionConclusion,
    }],
    evidence,
  };
}

async function audit(manifest: GitHubReviewFeedbackEvidenceManifestV1): Promise<Record<string, unknown>> {
  const body = auditBody(manifest);
  return {
    ...body,
    generatedAt: '2026-07-26T16:00:00.000Z',
    queryDurationMs: 12,
    reportDigest: await canonicalSha256(body),
  };
}

function pullRequest(manifest: GitHubReviewFeedbackEvidenceManifestV1) {
  const p = manifest.publication;
  const r = manifest.replacement;
  return {
    number: p.number,
    html_url: p.url,
    state: 'open',
    draft: true,
    head: { ref: r.branch, sha: r.resultHeadSha, repo: { full_name: manifest.repository } },
    base: { ref: p.baseBranch, repo: { full_name: manifest.repository } },
    updated_at: '2026-07-26T15:55:00.000Z',
  };
}

function fakeFetch(
  manifest: GitHubReviewFeedbackEvidenceManifestV1,
  options: {
    auditBody?: unknown;
    planBody?: unknown;
    reviewBody?: string;
    actionHeadSha?: string;
    checkConclusion?: string;
    extraCheckConclusion?: string;
    jobConclusion?: string;
    commitParentSha?: string;
  } = {},
): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.origin === 'https://control.example') {
      if (url.pathname.endsWith('/plan')) {
        return Response.json(options.planBody ?? planView(manifest));
      }
      return Response.json(options.auditBody ?? await audit(manifest));
    }
    if (url.pathname.endsWith('/pulls/42/reviews')) {
      return Response.json([{
        id: Number(manifest.appliedReview.reviewId),
        html_url: manifest.appliedReview.reviewUrl,
        body: options.reviewBody ?? REVIEW_BODY,
        state: 'CHANGES_REQUESTED',
        commit_id: manifest.appliedReview.reviewedHeadSha,
        submitted_at: manifest.appliedReview.submittedAt,
        user: {
          login: manifest.appliedReview.reviewerLogin,
          type: manifest.appliedReview.reviewerType,
        },
      }]);
    }
    if (url.pathname.endsWith('/pulls/42')) {
      return Response.json(pullRequest(manifest));
    }
    if (url.pathname.endsWith(`/actions/runs/${manifest.replacement.actionRunId}/jobs`)) {
      return Response.json({
        total_count: 1,
        jobs: [{
          id: 80042,
          run_id: Number(manifest.replacement.actionRunId),
          name: 'attempt',
          head_sha: manifest.replacement.actionWorkflowHeadSha,
          status: 'completed',
          conclusion: options.jobConclusion ?? 'success',
          steps: [
            { name: 'Checkout trusted execution snapshot', status: 'completed', conclusion: 'success' },
            { name: 'Validate attempt mode bindings', status: 'completed', conclusion: 'success' },
            { name: 'Run approved execution attempt', status: 'completed', conclusion: 'success' },
          ],
        }],
      });
    }
    if (url.pathname.endsWith(`/actions/runs/${manifest.replacement.actionRunId}`)) {
      return Response.json({
        id: Number(manifest.replacement.actionRunId),
        name: 'Delivery Agent',
        event: 'workflow_dispatch',
        status: manifest.replacement.actionStatus,
        conclusion: manifest.replacement.actionConclusion,
        head_sha: options.actionHeadSha ?? manifest.replacement.actionWorkflowHeadSha,
        head_branch: manifest.replacement.actionHeadBranch,
        path: manifest.replacement.actionWorkflowPath,
        display_title: manifest.replacement.actionTitle,
        run_attempt: 1,
        repository: { full_name: manifest.repository },
      });
    }
    if (url.pathname.includes('/git/ref/heads/')) {
      return Response.json({ object: { sha: manifest.replacement.resultHeadSha } });
    }
    if (url.pathname.includes('/compare/')) {
      return Response.json({
        status: 'ahead', ahead_by: 1, behind_by: 0,
        base_commit: { sha: manifest.replacement.checkoutSha },
        merge_base_commit: { sha: manifest.appliedReview.reviewedHeadSha },
        commits: [{ sha: manifest.replacement.resultHeadSha }],
      });
    }
    if (
      url.pathname.endsWith(`/commits/${manifest.replacement.resultHeadSha}`) &&
      !url.pathname.endsWith('/check-runs')
    ) {
      return Response.json({
        sha: manifest.replacement.resultHeadSha,
        parents: [{ sha: options.commitParentSha ?? manifest.replacement.checkoutSha }],
      });
    }
    if (url.pathname.endsWith(`/commits/${manifest.replacement.resultHeadSha}/check-runs`)) {
      const checkRuns = [{
        name: manifest.replacement.checks[0]!.name,
        status: 'completed',
        conclusion: options.checkConclusion ?? 'success',
        head_sha: manifest.replacement.resultHeadSha,
      }];
      if (options.extraCheckConclusion !== undefined) {
        checkRuns.push({
          name: 'unexpected-security-gate',
          status: 'completed',
          conclusion: options.extraCheckConclusion,
          head_sha: manifest.replacement.resultHeadSha,
        });
      }
      return Response.json({
        total_count: checkRuns.length,
        check_runs: checkRuns,
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('GitHub review feedback external evidence', () => {
  it('keeps the strict applied/stale review and replacement lineage manifest', () => {
    expect(GitHubReviewFeedbackEvidenceManifestV1Schema.safeParse(MANIFEST).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/github-review-feedback-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(GitHubReviewFeedbackEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(GitHubReviewFeedbackEvidenceManifestV1Schema.safeParse({
      ...MANIFEST, rawReviewBody: 'CANARY_REVIEW_BODY',
    }).success).toBe(false);
    expect(GitHubReviewFeedbackEvidenceManifestV1Schema.safeParse({
      ...MANIFEST,
      staleReview: { ...MANIFEST.staleReview, processingState: 'applied' },
    }).success).toBe(false);
  });

  it('cross-checks applied/stale Case 8 facts, GitHub review, PR head and replacement Action', async () => {
    const manifest = await fixture();
    const summary = await verifyGitHubReviewFeedbackEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example',
      controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN',
      canary: CANARY,
      githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest),
    });
    expect(summary).toEqual({
      schemaVersion: '1', evidenceId: manifest.evidenceId,
      runId: manifest.runId, repository: manifest.repository,
      appliedReview: 'verified', staleReview: 'ignored',
      replacementAttempt: 'verified', planItem: 'verified', commit: 'verified',
      verificationSuite: 'verified', githubAction: 'verified', githubJob: 'verified',
      githubChecks: 'all_success', githubCheckCount: 1,
      resultHeadSha: RESULT_HEAD_SHA,
    });
  });

  it('rejects cross-Plan replacement, incomplete DoD evidence, job drift and commit drift', async () => {
    const manifest = await fixture();
    const crossPlan = planView(manifest);
    const attempts = crossPlan.attempts as Array<Record<string, unknown>>;
    attempts[1] = { ...attempts[1], planVersion: 2 };
    await expect(verifyGitHubReviewFeedbackEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN', canary: CANARY,
      githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { planBody: crossPlan }),
    })).rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });

    const incompleteBody = auditBody(manifest);
    const answers = incompleteBody.answers as Record<string, unknown>;
    const checks = answers.checks as Record<string, unknown>;
    checks.commands = (checks.commands as Array<Record<string, unknown>>).slice(0, 1);
    const incomplete = {
      ...incompleteBody,
      generatedAt: '2026-07-26T16:00:00.000Z',
      queryDurationMs: 12,
      reportDigest: await canonicalSha256(incompleteBody),
    };
    const incompleteManifest = {
      ...manifest,
      case8ReportDigest: incomplete.reportDigest,
    };
    await expect(verifyGitHubReviewFeedbackEvidence(incompleteManifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN', canary: CANARY,
      githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(incompleteManifest, { auditBody: incomplete }),
    })).rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });

    await expect(verifyGitHubReviewFeedbackEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN', canary: CANARY,
      githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { jobConclusion: 'failure' }),
    })).rejects.toMatchObject({ code: 'github_job_mismatch' });
    await expect(verifyGitHubReviewFeedbackEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN', canary: CANARY,
      githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { commitParentSha: STALE_HEAD_SHA }),
    })).rejects.toMatchObject({ code: 'github_commit_mismatch' });
  });

  it('rejects stale review application, review body drift, Action head drift and failed checks', async () => {
    const manifest = await fixture();
    const stale = await audit(manifest);
    const answers = stale.answers as Record<string, unknown>;
    const checks = answers.checks as Record<string, unknown>;
    const observations = checks.reviewObservations as Array<Record<string, unknown>>;
    observations[1] = { ...observations[1], processingState: 'applied', ignoreReason: null };
    await expect(verifyGitHubReviewFeedbackEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN', canary: CANARY,
      fetch: fakeFetch(manifest, { auditBody: stale }),
    })).rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
    await expect(verifyGitHubReviewFeedbackEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN', canary: CANARY, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { reviewBody: 'forged review body' }),
    })).rejects.toMatchObject({ code: 'github_review_mismatch' });
    await expect(verifyGitHubReviewFeedbackEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN', canary: CANARY, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { actionHeadSha: REVIEW_HEAD_SHA }),
    })).rejects.toMatchObject({ code: 'github_action_mismatch' });
    await expect(verifyGitHubReviewFeedbackEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN', canary: CANARY, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { checkConclusion: 'failure' }),
    })).rejects.toMatchObject({ code: 'github_checks_mismatch' });
    await expect(verifyGitHubReviewFeedbackEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN', canary: CANARY, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { extraCheckConclusion: 'failure' }),
    })).rejects.toMatchObject({ code: 'github_checks_mismatch' });
  });

  it('never propagates raw GitHub response text or tokens', async () => {
    const manifest = await fixture();
    const raw = 'CANARY_RAW_GITHUB_REVIEW_RESPONSE';
    const failure = await verifyGitHubReviewFeedbackEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example',
      controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN',
      canary: CANARY,
      githubApiOrigin: 'https://api.github.test',
      fetch: (async (input) => {
        const url = new URL(String(input));
        if (url.origin === 'https://api.github.test') {
          return new Response(JSON.stringify({ message: raw }), { status: 503 });
        }
        if (url.pathname.endsWith('/plan')) return Response.json(planView(manifest));
        return Response.json(await audit(manifest));
      }) as typeof fetch,
    }).catch((error: unknown) => error);
    expect(String(failure)).not.toContain(raw);
    expect(String(failure)).not.toContain('CANARY_CONTROL_TOKEN');
    expect(String(failure)).not.toContain('CANARY_GITHUB_TOKEN');

    const leak = await verifyGitHubReviewFeedbackEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example',
      controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN',
      canary: CANARY,
      githubApiOrigin: 'https://api.github.test',
      fetch: (async (input) => {
        const url = new URL(String(input));
        if (url.origin === 'https://api.github.test') {
          return Response.json({ leakedCredential: CANARY });
        }
        if (url.pathname.endsWith('/plan')) return Response.json(planView(manifest));
        return Response.json(await audit(manifest));
      }) as typeof fetch,
    }).catch((error: unknown) => error);
    expect(leak).toMatchObject({ code: 'secret_leak_detected' });
    expect(String(leak)).not.toContain(CANARY);
  });

  it('keeps CLI opt-in before manifest or network access', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_GITHUB_REVIEW_E2E;
    const result = spawnSync(
      'pnpm', ['exec', 'tsx', 'scripts/verify-github-review-feedback-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('github-review-e2e: opt-in missing');
  });
});
