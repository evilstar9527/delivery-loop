import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  PlanRevisionEvidenceManifestV1Schema,
  type PlanRevisionEvidenceManifestV1,
} from '../src/domain/plan-revision-evidence.js';
import { verifyPlanRevisionEvidence } from '../src/pilot/plan-revision-evidence-verifier.js';

const BEFORE_SHA = 'a'.repeat(40);
const AFTER_SHA = 'b'.repeat(40);
const OLD_PLAN_DIGEST = `sha256:${'1'.repeat(64)}`;
const NEW_PLAN_DIGEST = `sha256:${'2'.repeat(64)}`;
const SOURCE_DIGEST = `sha256:${'3'.repeat(64)}`;
const REFERENCE_DIGEST = `sha256:${'4'.repeat(64)}`;
const COMPARISON_DIGEST = `sha256:${'5'.repeat(64)}`;
const EVENT_DIGEST = `sha256:${'6'.repeat(64)}`;

const MANIFEST: PlanRevisionEvidenceManifestV1 = {
  schemaVersion: '1',
  evidenceId: 'plan-revision-evidence-1',
  recordedAt: '2026-07-26T17:00:00.000Z',
  runId: 'run-plan-revision-evidence-1',
  repository: 'example/delivery-pilot',
  revision: {
    revisionId: 'plan-revision-evidence-1',
    expectedRunVersion: 10,
    status: 'activated',
    analysisAttemptId: 'attempt-plan-revision-analysis-1',
    priorPlan: {
      id: 'plan-revision-prior-1', version: 1,
      digest: OLD_PLAN_DIGEST, baseSha: BEFORE_SHA, status: 'superseded',
    },
    newPlan: {
      id: 'plan-revision-new-1', version: 2,
      digest: NEW_PLAN_DIGEST, baseSha: AFTER_SHA, status: 'active',
    },
    changes: { body: true, base: true, effects: true },
    activatedAt: '2026-07-26T16:40:00.000Z',
  },
  source: {
    kind: 'base_update',
    recordId: 'github-base-observation-evidence-1',
    digest: SOURCE_DIGEST,
    observedAt: '2026-07-26T16:30:00.000Z',
    repository: 'example/delivery-pilot',
    baseBranch: 'main',
    beforeSha: BEFORE_SHA,
    afterSha: AFTER_SHA,
    aheadBy: 2,
    referenceDigest: REFERENCE_DIGEST,
    comparisonDigest: COMPARISON_DIGEST,
  },
  approvals: {
    invalidated: [{
      approvalId: 'approval-plan-revision-old-1',
      effect: 'repo_write',
      invalidated: true,
    }],
    fresh: [{
      approvalId: 'approval-plan-revision-new-1',
      effect: 'repo_write',
      decision: 'approve',
      approver: 'user:plan-reviewer',
      provider: 'github',
      externalEventId: 'approval-event-plan-revision-1',
      eventDigest: EVENT_DIGEST,
      expiresAt: '2026-07-27T16:45:00.000Z',
      invalidated: false,
    }],
  },
  analysisAction: {
    githubRunId: '81001',
    workflowPath: '.github/workflows/delivery-agent.yml',
    displayTitle: 'delivery-loop/attempt-plan-revision-analysis-1',
    status: 'completed',
    conclusion: 'success',
    headSha: AFTER_SHA,
    headBranch: 'main',
    runAttempt: 1,
  },
};

async function fixture(): Promise<PlanRevisionEvidenceManifestV1> {
  const referenceDigest = await canonicalSha256({
    ref: 'refs/heads/main', objectType: 'commit', sha: AFTER_SHA,
  });
  const comparisonDigest = await canonicalSha256({
    status: 'ahead', aheadBy: 2, behindBy: 0,
    baseCommitSha: BEFORE_SHA, mergeBaseCommitSha: BEFORE_SHA,
    comparedHeadSha: AFTER_SHA,
  });
  const source = {
    ...MANIFEST.source,
    referenceDigest,
    comparisonDigest,
  };
  if (source.kind !== 'base_update') throw new Error('invalid base source fixture');
  return {
    ...MANIFEST,
    source: {
      ...source,
      digest: await canonicalSha256({
        schemaVersion: '1', repository: source.repository,
        baseBranch: source.baseBranch, beforeSha: source.beforeSha,
        afterSha: source.afterSha, relationship: 'ahead', aheadBy: source.aheadBy,
        referenceDigest, comparisonDigest,
      }),
    },
  };
}

function audit(manifest: PlanRevisionEvidenceManifestV1): Record<string, unknown> {
  const revision = manifest.revision;
  const source = manifest.source;
  const invalidated = manifest.approvals.invalidated[0]!;
  const fresh = manifest.approvals.fresh[0]!;
  const action = manifest.analysisAction;
  return {
    schemaVersion: '1',
    run: {
      id: manifest.runId, state: 'executing', version: 13,
      baseSha: revision.newPlan.baseSha,
      activePlanId: revision.newPlan.id,
      activePlanVersion: revision.newPlan.version,
      activePlanDigest: revision.newPlan.digest,
    },
    task: { target: { repository: manifest.repository } },
    answers: {
      who: { attempts: [{
        attemptId: revision.analysisAttemptId,
        ordinal: 3,
        mode: 'analysis',
        status: 'completed',
        repository: manifest.repository,
        baseSha: revision.newPlan.baseSha,
        githubRunId: action.githubRunId,
        githubStatus: action.status,
        githubConclusion: action.conclusion,
      }] },
      sourceEvents: [{
        kind: 'plan_revision',
        sourceKind: source.kind,
        digest: source.digest,
        priorPlanId: revision.priorPlan.id,
        priorPlanVersion: revision.priorPlan.version,
        priorPlanDigest: revision.priorPlan.digest,
        requestedBaseSha: revision.newPlan.baseSha,
        observedAt: source.observedAt,
      }],
      checks: {
        planRevisions: [{
          revisionId: revision.revisionId,
          expectedRunVersion: revision.expectedRunVersion,
          status: revision.status,
          sourceKind: source.kind,
          sourceRecordId: source.recordId,
          sourceDigest: source.digest,
          requestedBaseSha: revision.newPlan.baseSha,
          analysisAttemptId: revision.analysisAttemptId,
          priorPlan: revision.priorPlan,
          newPlan: revision.newPlan,
          changes: revision.changes,
          activatedAt: revision.activatedAt,
          source,
        }],
      },
      approvals: [
        {
          approvalId: invalidated.approvalId,
          effect: invalidated.effect,
          decision: 'approve',
          planId: revision.priorPlan.id,
          planVersion: revision.priorPlan.version,
          planDigest: revision.priorPlan.digest,
          baseSha: revision.priorPlan.baseSha,
          invalidated: true,
        },
        {
          approvalId: fresh.approvalId,
          effect: fresh.effect,
          decision: fresh.decision,
          approver: fresh.approver,
          provider: fresh.provider,
          externalEventId: fresh.externalEventId,
          eventDigest: fresh.eventDigest,
          planId: revision.newPlan.id,
          planVersion: revision.newPlan.version,
          planDigest: revision.newPlan.digest,
          baseSha: revision.newPlan.baseSha,
          expiresAt: fresh.expiresAt,
          invalidated: false,
        },
      ],
    },
    digests: {
      plans: [revision.priorPlan, revision.newPlan].map((plan) => ({
        planId: plan.id, version: plan.version, digest: plan.digest,
        status: plan.status, baseSha: plan.baseSha,
      })),
    },
  };
}

function fakeFetch(
  manifest: PlanRevisionEvidenceManifestV1,
  options: { auditBody?: unknown; refSha?: string; actionConclusion?: string } = {},
): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.origin === 'https://control.example') {
      return Response.json(options.auditBody ?? audit(manifest));
    }
    if (url.pathname.includes('/git/ref/heads/')) {
      return Response.json({
        ref: 'refs/heads/main',
        object: { type: 'commit', sha: options.refSha ?? AFTER_SHA },
      });
    }
    if (url.pathname.includes('/compare/')) {
      return Response.json({
        status: 'ahead', ahead_by: 2, behind_by: 0,
        base_commit: { sha: BEFORE_SHA },
        merge_base_commit: { sha: BEFORE_SHA },
      });
    }
    if (url.pathname.endsWith(`/actions/runs/${manifest.analysisAction.githubRunId}`)) {
      return Response.json({
        id: Number(manifest.analysisAction.githubRunId),
        status: manifest.analysisAction.status,
        conclusion: options.actionConclusion ?? manifest.analysisAction.conclusion,
        head_sha: manifest.analysisAction.headSha,
        head_branch: manifest.analysisAction.headBranch,
        path: manifest.analysisAction.workflowPath,
        display_title: manifest.analysisAction.displayTitle,
        run_attempt: manifest.analysisAction.runAttempt,
        repository: { full_name: manifest.repository },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('Plan revision external evidence', () => {
  it('keeps a strict three-source manifest and example', () => {
    expect(PlanRevisionEvidenceManifestV1Schema.safeParse(MANIFEST).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/plan-revision-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(PlanRevisionEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(PlanRevisionEvidenceManifestV1Schema.safeParse({
      ...MANIFEST, sourceBody: 'CANARY_SOURCE_BODY',
    }).success).toBe(false);
    expect(PlanRevisionEvidenceManifestV1Schema.safeParse({
      ...MANIFEST,
      revision: {
        ...MANIFEST.revision,
        newPlan: { ...MANIFEST.revision.newPlan, version: 3 },
      },
    }).success).toBe(false);
  });

  it('cross-checks Plan replacement, approval invalidation/fresh approval, Action and GitHub base', async () => {
    const manifest = await fixture();
    const summary = await verifyPlanRevisionEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example',
      controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN',
      githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest),
    });
    expect(summary).toEqual({
      schemaVersion: '1', evidenceId: manifest.evidenceId,
      runId: manifest.runId, repository: manifest.repository,
      sourceKind: 'base_update', priorPlan: 'superseded',
      newPlan: 'active', oldApproval: 'invalidated',
      freshApproval: 'verified', analysisAction: 'verified',
    });
  });

  it('rejects reused approval, plan projection drift, base ref drift and failed Action', async () => {
    const manifest = await fixture();
    const reused = audit(manifest);
    const answers = reused.answers as Record<string, unknown>;
    const approvals = answers.approvals as Array<Record<string, unknown>>;
    approvals[0] = { ...approvals[0], invalidated: false };
    await expect(verifyPlanRevisionEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN', fetch: fakeFetch(manifest, { auditBody: reused }),
    })).rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
    const drift = audit(manifest);
    const driftChecks = ((drift.answers as Record<string, unknown>).checks as Record<string, unknown>);
    const revisions = driftChecks.planRevisions as Array<Record<string, unknown>>;
    revisions[0] = { ...revisions[0], sourceDigest: `sha256:${'9'.repeat(64)}` };
    await expect(verifyPlanRevisionEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN', fetch: fakeFetch(manifest, { auditBody: drift }),
    })).rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
    await expect(verifyPlanRevisionEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN', githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { refSha: BEFORE_SHA }),
    })).rejects.toMatchObject({ code: 'github_source_mismatch' });
    await expect(verifyPlanRevisionEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN', githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { actionConclusion: 'failure' }),
    })).rejects.toMatchObject({ code: 'github_action_mismatch' });
  });

  it('never propagates raw API response text or tokens', async () => {
    const manifest = await fixture();
    const raw = 'CANARY_RAW_PLAN_REVISION_RESPONSE';
    const failure = await verifyPlanRevisionEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example',
      controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN',
      githubApiOrigin: 'https://api.github.test',
      fetch: (async (input) => {
        const url = new URL(String(input));
        if (url.origin === 'https://api.github.test') {
          return new Response(JSON.stringify({ message: raw }), { status: 503 });
        }
        return Response.json(audit(manifest));
      }) as typeof fetch,
    }).catch((error: unknown) => error);
    expect(String(failure)).not.toContain(raw);
    expect(String(failure)).not.toContain('CANARY_CONTROL_TOKEN');
    expect(String(failure)).not.toContain('CANARY_GITHUB_TOKEN');
  });

  it('keeps CLI opt-in before manifest or network access', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_PLAN_REVISION_E2E;
    const result = spawnSync(
      'pnpm', ['exec', 'tsx', 'scripts/verify-plan-revision-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('plan-revision-e2e: opt-in missing');
  });
});
