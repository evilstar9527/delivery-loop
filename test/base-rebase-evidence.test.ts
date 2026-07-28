import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  BaseRebaseEvidenceManifestV1Schema,
  type BaseRebaseEvidenceManifestV1,
} from '../src/domain/base-rebase-evidence.js';
import { verifyBaseRebaseEvidence } from '../src/pilot/base-rebase-evidence-verifier.js';

const REPOSITORY = 'example/rebase-evidence';
const OLD_BASE = 'a'.repeat(40);
const NEW_BASE = 'b'.repeat(40);
const SOURCE_HEAD = 'c'.repeat(40);
const RESULT_HEAD = 'd'.repeat(40);
const SOURCE_BRANCH = 'agent/task-rebase/attempt-source';
const TARGET_BRANCH = 'agent/task-rebase/attempt-rebase';
const REBASE_ID = 'base-rebase-evidence-1';
const ATTEMPT_ID = 'attempt-base-rebase-evidence-1';
const ACTION_ID = '81001';
const NOW = '2026-07-26T18:00:00.000Z';

async function baseDigests(
  relationship: 'ahead' | 'diverged',
  aheadBy: number,
  behindBy: number,
  mergeBaseSha: string,
): Promise<{ referenceDigest: string; comparisonDigest: string; sourceDigest: string }> {
  const referenceDigest = await canonicalSha256({
    ref: 'refs/heads/main', objectType: 'commit', sha: NEW_BASE,
  });
  const comparisonDigest = await canonicalSha256({
    status: relationship, aheadBy, behindBy,
    baseCommitSha: OLD_BASE, mergeBaseCommitSha: mergeBaseSha,
    comparedHeadSha: NEW_BASE,
  });
  const sourceDigest = await canonicalSha256({
    schemaVersion: '1', repository: REPOSITORY, baseBranch: 'main',
    beforeSha: OLD_BASE, afterSha: NEW_BASE, relationship,
    aheadBy, ...(relationship === 'diverged' ? { behindBy, mergeBaseSha } : {}),
    ...(relationship === 'ahead' ? {} : {}),
    referenceDigest, comparisonDigest,
  });
  return { referenceDigest, comparisonDigest, sourceDigest };
}

async function successManifest(): Promise<BaseRebaseEvidenceManifestV1> {
  const digests = await baseDigests('ahead', 2, 0, OLD_BASE);
  return {
    schemaVersion: '1', evidenceId: 'base-rebase-evidence-1', recordedAt: NOW,
    runId: 'run-base-rebase-evidence-1', repository: REPOSITORY, outcome: 'passed',
    rebase: {
      rebaseId: REBASE_ID, revisionId: 'revision-base-rebase-evidence-1',
      sourcePlanId: 'plan-base-rebase-old', sourcePlanVersion: 1,
      targetPlanId: 'plan-base-rebase-new', targetPlanVersion: 2,
      planItemId: 'item-base-rebase', sourceAttemptId: 'attempt-source',
      rebaseAttemptId: ATTEMPT_ID, oldBaseSha: OLD_BASE, newBaseSha: NEW_BASE,
      sourceBranch: SOURCE_BRANCH, sourceHeadSha: SOURCE_HEAD,
      targetBranch: TARGET_BRANCH, resultHeadSha: RESULT_HEAD,
      status: 'passed', verificationSuiteId: 'suite-base-rebase-evidence',
      dispatchOutboxId: 'dispatch-base-rebase-evidence',
    },
    baseComparison: {
      observationId: 'github-base-observation-1', ...digests,
      repository: REPOSITORY, baseBranch: 'main', beforeSha: OLD_BASE,
      afterSha: NEW_BASE, relationship: 'ahead', aheadBy: 2, behindBy: 0,
      mergeBaseSha: OLD_BASE,
    },
    branchUpdate: {
      ref: `refs/heads/${TARGET_BRANCH}`, beforeSha: SOURCE_HEAD,
      afterSha: RESULT_HEAD, fastForward: true, force: false,
    },
    action: {
      githubRunId: ACTION_ID, workflowPath: '.github/workflows/delivery-agent.yml',
      displayTitle: `delivery-loop/${ATTEMPT_ID}`, status: 'completed', conclusion: 'success',
      headSha: NEW_BASE, headBranch: 'main', runAttempt: 1,
    },
    verification: {
      suiteId: 'suite-base-rebase-evidence', headSha: RESULT_HEAD,
      targetedPassed: true, requiredPassed: true, evidenceCount: 2,
    },
  };
}

async function blockedManifest(): Promise<BaseRebaseEvidenceManifestV1> {
  const digests = await baseDigests('diverged', 2, 1, 'e'.repeat(40));
  return {
    schemaVersion: '1', evidenceId: 'base-rebase-conflict-evidence-1', recordedAt: NOW,
    runId: 'run-base-conflict-evidence-1', repository: REPOSITORY, outcome: 'blocked',
    conflict: {
      conflictId: 'github-base-conflict-1', expectedRunVersion: 7,
      priorPlanId: 'plan-base-conflict', priorPlanVersion: 1,
      priorPlanDigest: `sha256:${'1'.repeat(64)}`, repository: REPOSITORY,
      baseBranch: 'main', targetBranch: 'agent/task-conflict/attempt-rebase',
      beforeSha: OLD_BASE, afterSha: NEW_BASE, relationship: 'diverged', aheadBy: 2,
      behindBy: 1, mergeBaseSha: 'e'.repeat(40), referenceDigest: digests.referenceDigest,
      comparisonDigest: digests.comparisonDigest, sourceDigest: digests.sourceDigest,
      blockerReason: 'base_history_diverged', neededHumanInput: 'manual_rebase',
      runVersion: 8, runState: 'blocked', planStatus: 'blocked',
      cancelOutboxId: 'cancel_github-base-conflict-1', observedAt: '2026-07-26T17:30:00.000Z',
    },
    baseComparison: {
      observationId: 'github-base-conflict-1', ...digests,
      repository: REPOSITORY, baseBranch: 'main', beforeSha: OLD_BASE,
      afterSha: NEW_BASE, relationship: 'diverged', aheadBy: 2, behindBy: 1,
      mergeBaseSha: 'e'.repeat(40),
    },
    forbiddenAction: {
      displayTitle: 'delivery-loop/attempt-base-conflict-rebase',
      workflowPath: '.github/workflows/delivery-agent.yml',
    },
    noSideEffects: {
      actionRuns: 0, pushEvents: 0, evidence: 0, executionDispatches: 0,
      targetBranchAbsent: true,
    },
  };
}

function ref(sha: string, branch: string): Record<string, unknown> {
  return { ref: `refs/heads/${branch}`, object: { type: 'commit', sha } };
}

function fakeFetch(
  manifest: BaseRebaseEvidenceManifestV1,
  options: { actionRuns?: unknown[]; targetStatus?: number; actionConclusion?: string } = {},
): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.origin === 'https://control.example') {
      if (manifest.outcome === 'passed') {
        return Response.json({
          schemaVersion: '1', run: {
            id: manifest.runId, state: 'executing', version: 21,
            activePlanId: manifest.rebase.targetPlanId,
            activePlanVersion: manifest.rebase.targetPlanVersion,
          }, task: { target: { repository: REPOSITORY } }, answers: {
            who: { attempts: [{ attemptId: ATTEMPT_ID, mode: 'review_fix', status: 'completed',
              headSha: RESULT_HEAD, githubRunId: ACTION_ID, githubStatus: 'completed',
              githubConclusion: 'success' }] },
            changes: [{ kind: 'commit', attemptId: ATTEMPT_ID, branch: TARGET_BRANCH,
              parentSha: SOURCE_HEAD, headSha: RESULT_HEAD }],
            checks: {
              baseRebases: [{ rebaseId: REBASE_ID, revisionId: manifest.rebase.revisionId,
                sourcePlan: { id: manifest.rebase.sourcePlanId, version: 1 },
                targetPlan: { id: manifest.rebase.targetPlanId, version: 2 }, itemId: manifest.rebase.planItemId,
                sourceAttemptId: 'attempt-source', attemptId: ATTEMPT_ID, oldBaseSha: OLD_BASE,
                newBaseSha: NEW_BASE, sourceBranch: SOURCE_BRANCH, sourceHeadSha: SOURCE_HEAD,
                targetBranch: TARGET_BRANCH, status: 'passed', attemptStatus: 'completed', progressStatus: 'passed',
                resultHeadSha: RESULT_HEAD, verificationSuiteId: manifest.rebase.verificationSuiteId,
                dispatchOutboxId: manifest.rebase.dispatchOutboxId,
                githubRunId: ACTION_ID, githubStatus: 'completed', githubConclusion: 'success',
                attemptHeadBranch: TARGET_BRANCH, attemptHeadSha: RESULT_HEAD }],
              planRevisions: [{ revisionId: manifest.rebase.revisionId, sourceKind: 'base_update',
                sourceRecordId: manifest.baseComparison.observationId, sourceDigest: manifest.baseComparison.sourceDigest,
                status: 'activated',
                priorPlan: { id: manifest.rebase.sourcePlanId, version: 1, status: 'superseded' },
                newPlan: { id: manifest.rebase.targetPlanId, version: 2, status: 'active', baseSha: NEW_BASE } }],
              commands: [
                { suiteId: manifest.rebase.verificationSuiteId, phase: 'targeted', status: 'passed' },
                { suiteId: manifest.rebase.verificationSuiteId, phase: 'required_verify', status: 'passed' },
              ],
              evidence: [
                { attemptId: ATTEMPT_ID, status: 'passed', verificationStatus: 'verified', sha: RESULT_HEAD },
                { attemptId: ATTEMPT_ID, status: 'passed', verificationStatus: 'verified', sha: RESULT_HEAD },
              ], effectOutboxes: [],
            }, approvals: [],
          },
        });
      }
      return Response.json({
        schemaVersion: '1', run: { id: manifest.runId, state: 'blocked', version: 8, baseSha: OLD_BASE },
        task: { target: { repository: REPOSITORY } }, answers: {
          checks: {
            baseRebases: [],
            baseConflicts: [{ conflictId: manifest.conflict.conflictId,
              expectedRunVersion: 7,
              priorPlan: { id: manifest.conflict.priorPlanId, version: 1, digest: manifest.conflict.priorPlanDigest },
              repository: REPOSITORY, baseBranch: 'main', beforeSha: OLD_BASE, afterSha: NEW_BASE,
              relationship: 'diverged', aheadBy: 2, behindBy: 1, mergeBaseSha: 'e'.repeat(40),
              referenceDigest: manifest.conflict.referenceDigest, comparisonDigest: manifest.conflict.comparisonDigest,
              sourceDigest: manifest.conflict.sourceDigest, blockerReason: 'base_history_diverged',
              neededHumanInput: 'manual_rebase', runState: 'blocked', runVersion: 8, planStatus: 'blocked',
              cancelOutboxId: manifest.conflict.cancelOutboxId }],
            effectOutboxes: [], evidence: [],
          },
        },
      });
    }
    if (url.pathname.endsWith(`/actions/runs/${ACTION_ID}`)) {
      return Response.json({ id: Number(ACTION_ID), status: 'completed', conclusion: options.actionConclusion ?? 'success',
        head_sha: NEW_BASE, head_branch: 'main', path: '.github/workflows/delivery-agent.yml',
        display_title: `delivery-loop/${ATTEMPT_ID}`, run_attempt: 1,
        repository: { full_name: REPOSITORY } });
    }
    if (url.pathname.endsWith('/actions/runs')) return Response.json({ workflow_runs: options.actionRuns ?? [] });
    if (url.pathname.includes('/compare/')) {
      const after = url.pathname.includes(`${OLD_BASE}...${NEW_BASE}`);
      return Response.json(after
        ? { status: manifest.baseComparison.relationship, ahead_by: manifest.baseComparison.aheadBy,
          behind_by: manifest.baseComparison.behindBy, base_commit: { sha: OLD_BASE },
          merge_base_commit: { sha: manifest.baseComparison.mergeBaseSha } }
        : { status: 'ahead', ahead_by: 1, behind_by: 0,
          base_commit: { sha: SOURCE_HEAD }, merge_base_commit: { sha: SOURCE_HEAD } });
    }
    if (url.pathname.includes('/git/ref/heads/')) {
      const branch = decodeURIComponent(url.pathname.split('/git/ref/heads/')[1] ?? '');
      if (manifest.outcome === 'blocked' && branch === manifest.conflict.targetBranch) {
        return new Response('', { status: options.targetStatus ?? 404 });
      }
      if (branch === 'main') return Response.json(ref(NEW_BASE, branch));
      if (manifest.outcome === 'passed' && branch === SOURCE_BRANCH) return Response.json(ref(SOURCE_HEAD, branch));
      if (manifest.outcome === 'passed' && branch === TARGET_BRANCH) return Response.json(ref(RESULT_HEAD, branch));
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('base rebase external evidence', () => {
  it('accepts the passed fast-forward/no-force path and rejects action drift', async () => {
    const manifest = await successManifest();
    expect(BaseRebaseEvidenceManifestV1Schema.safeParse(manifest).success).toBe(true);
    await expect(verifyBaseRebaseEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'control-token',
      githubToken: 'github-token', githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest),
    })).resolves.toMatchObject({ outcome: 'passed', branchUpdate: 'fast_forward_no_force' });
    const drift = verifyBaseRebaseEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'control-token',
      githubToken: 'github-token', githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { actionConclusion: 'failure' }),
    });
    await expect(drift).rejects.toMatchObject({ code: 'github_action_mismatch' });
    await expect(drift).rejects.not.toThrow(/control-token|github-token/);
  });

  it('accepts the blocked conflict path only when no rebase Action or target branch exists', async () => {
    const manifest = await blockedManifest();
    if (manifest.outcome !== 'blocked') throw new Error('expected blocked fixture');
    expect(BaseRebaseEvidenceManifestV1Schema.safeParse(manifest).success).toBe(true);
    await expect(verifyBaseRebaseEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'control-token',
      githubToken: 'github-token', githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest),
    })).resolves.toMatchObject({ outcome: 'blocked', sideEffects: 'none' });
    await expect(verifyBaseRebaseEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'control-token',
      githubToken: 'github-token', githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { actionRuns: [{ display_title: manifest.forbiddenAction.displayTitle,
        path: manifest.forbiddenAction.workflowPath }] }),
    })).rejects.toMatchObject({ code: 'github_side_effect_mismatch' });
  });

  it('keeps the manifest strict and uses safe configuration errors', async () => {
    const manifest = await successManifest();
    expect(BaseRebaseEvidenceManifestV1Schema.safeParse({ ...manifest, raw: 'SECRET' }).success).toBe(false);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/base-rebase-evidence-v1.example.json', import.meta.url), 'utf8',
    )) as unknown;
    expect(BaseRebaseEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    await expect(verifyBaseRebaseEvidence(manifest, {
      controlPlaneOrigin: 'http://control.example', controlPlaneToken: 'control-token', githubToken: 'github-token',
    })).rejects.toMatchObject({ code: 'configuration_invalid' });
    await expect(verifyBaseRebaseEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'control-token', githubToken: 'github-token',
      fetch: fakeFetch(manifest),
    })).resolves.toBeDefined();
    expect(RESULT_HEAD).toMatch(/^[a-f0-9]{40}$/);
  });
});
