import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  MergeGateEvidenceManifestV1Schema,
  type MergeGateEvidenceManifestV1,
} from '../src/domain/merge-gate-evidence.js';
import { verifyMergeGateEvidence } from '../src/pilot/merge-gate-evidence-verifier.js';

const REPOSITORY = 'example/merge-gate';
const BASE_SHA = 'a'.repeat(40);
const NEW_BASE_SHA = 'c'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const CONTROL_TOKEN = 'CANARY_MERGE_GATE_CONTROL_TOKEN';
const GITHUB_TOKEN = 'CANARY_MERGE_GATE_GITHUB_TOKEN';
const PR_BODY = 'CANARY_MERGE_GATE_RAW_RESPONSE';

type RejectionReason = NonNullable<MergeGateEvidenceManifestV1['cases'][number]['rejectionReason']>;
type CaseItem = MergeGateEvidenceManifestV1['cases'][number];

const CASES: Array<{
  caseId: string;
  runId: string;
  number: number;
  key: string;
  reason: RejectionReason | null;
}> = [
  { caseId: 'ready-case', runId: 'run-ready', number: 101, key: 'ready', reason: null },
  { caseId: 'incomplete-case', runId: 'run-incomplete', number: 102, key: 'incomplete', reason: 'required_checks_incomplete' },
  { caseId: 'failed-case', runId: 'run-failed', number: 103, key: 'failed', reason: 'required_checks_failed' },
  { caseId: 'review-case', runId: 'run-review', number: 104, key: 'review', reason: 'review_insufficient' },
  { caseId: 'base-case', runId: 'run-base', number: 105, key: 'base', reason: 'base_not_latest' },
  { caseId: 'approval-case', runId: 'run-approval', number: 106, key: 'approval', reason: 'approval_required' },
];

function rawCheck(caseItem: CaseItem): { status: string; conclusion: string | null } {
  if (caseItem.rejectionReason === 'required_checks_incomplete') {
    return { status: 'in_progress', conclusion: null };
  }
  if (caseItem.rejectionReason === 'required_checks_failed') {
    return { status: 'completed', conclusion: 'failure' };
  }
  return { status: 'completed', conclusion: 'success' };
}

async function makeFact(
  spec: (typeof CASES)[number],
): Promise<CaseItem['fact']> {
  const state = spec.reason === 'required_checks_incomplete'
    ? 'pending'
    : spec.reason === 'required_checks_failed' ? 'failed' : 'passed';
  const checks = [{ context: 'ci', integrationId: 42, state } as const];
  const requiredApprovals = 1;
  const reviews = spec.reason === 'review_insufficient' ? [] : [{
    id: String(9000 + spec.number), login: 'human-reviewer', state: 'APPROVED' as const,
    commitId: HEAD_SHA, submittedAt: '2026-07-26T11:49:00.000Z',
  }];
  const baseSha = spec.reason === 'base_not_latest' ? NEW_BASE_SHA : BASE_SHA;
  return {
    schemaVersion: '1', repository: REPOSITORY, number: spec.number,
    pullRequestAuthorLogin: 'agent-bot', headBranch: `agent/task/${spec.key}`,
    headSha: HEAD_SHA, baseBranch: 'main', baseSha, pullRequestBaseSha: BASE_SHA,
    state: 'open', draft: false, mergeability: 'mergeable', mergeState: 'clean',
    reviewDecision: reviews.length > 0 ? 'approved' : 'review_required',
    requiredApprovals, approvedReviewCount: reviews.length,
    requiredChecks: checks,
    policyDigest: await canonicalSha256({
      requiredChecks: [{ context: 'ci', integrationId: 42 }], requiredApprovals,
    }),
    checksDigest: await canonicalSha256(checks),
    reviewsDigest: await canonicalSha256(reviews),
    externalUpdatedAt: '2026-07-26T11:50:00.000Z',
  };
}

async function makeManifest(): Promise<MergeGateEvidenceManifestV1> {
  const cases: CaseItem[] = [];
  for (const spec of CASES) {
    const fact = await makeFact(spec);
    const runVersion = spec.reason === null ? 1 : spec.number - 98;
    const approval = spec.reason === null
      ? { approvalId: 'approval-ready', effect: 'merge' as const, decision: 'approve' as const,
        expiresAt: '2026-07-27T00:00:00.000Z', invalidated: false as const }
      : spec.reason === 'approval_required'
        ? { approvalId: 'approval-expired', effect: 'merge' as const, decision: 'approve' as const,
          expiresAt: '2026-07-25T00:00:00.000Z', invalidated: false as const }
        : null;
    cases.push({
      caseId: spec.caseId, runId: spec.runId, repository: REPOSITORY,
      pullRequestNumber: spec.number, runVersion,
      currentRunVersion: spec.reason === null ? runVersion + 1 : runVersion,
      runState: spec.reason === null ? 'ready_to_merge' : spec.reason === 'base_not_latest'
        ? 'pull_request_open' : 'awaiting_review',
      outcome: spec.reason === null ? 'ready_to_merge' : 'rejected',
      rejectionReason: spec.reason, fact,
      observation: {
        observationId: `obs-${spec.key}`,
        factDigest: await canonicalSha256(fact),
        observedAt: '2026-07-26T11:51:00.000Z',
      },
      evaluation: {
        evaluationId: `eval-${spec.key}`,
        status: spec.reason === null ? 'passed' : 'rejected',
        rejectionReason: spec.reason,
        createdAt: '2026-07-26T11:52:00.000Z',
      },
      decisionId: spec.reason === null ? 'decision-ready' : null,
      approval,
      noMergeEffect: { mergeOutboxes: 0, merges: 0 },
    });
  }
  return {
    schemaVersion: '1', evidenceId: 'merge-gate-evidence-test',
    recordedAt: '2026-07-26T12:00:00.000Z', repository: REPOSITORY, cases,
  };
}

function auditFor(item: CaseItem, options: { mergeEffect?: boolean; projectionDrift?: boolean } = {}) {
  const fact = options.projectionDrift
    ? { ...item.fact, headBranch: 'agent/task/drift' }
    : item.fact;
  return {
    schemaVersion: '1',
    run: { id: item.runId, state: item.runState, version: item.currentRunVersion },
    answers: {
      changes: options.mergeEffect ? [{ kind: 'merge', mergeId: 'merge-drift' }] : [],
      approvals: item.approval === null ? [] : [{
        approvalId: item.approval.approvalId, effect: item.approval.effect,
        decision: item.approval.decision, expiresAt: item.approval.expiresAt,
        invalidated: item.approval.invalidated,
      }],
      checks: {
        mergeGates: [{
          observationId: item.observation.observationId,
          runVersion: item.runVersion,
          factDigest: item.observation.factDigest,
          fact,
          evaluation: {
            evaluationId: item.evaluation.evaluationId,
            status: item.evaluation.status,
            rejectionReason: item.evaluation.rejectionReason,
            approvalId: item.approval?.approvalId ?? null,
            createdAt: item.evaluation.createdAt,
          },
          decisionId: item.decisionId,
        }],
        effectOutboxes: options.mergeEffect ? [{ kind: 'merge' }] : [],
      },
    },
  };
}

function githubResponse(item: CaseItem, url: URL, options: { factDrift?: boolean } = {}): Response {
  const fact = item.fact;
  const headSha = options.factDrift ? 'd'.repeat(40) : fact.headSha;
  if (url.pathname.endsWith(`/pulls/${fact.number}`) && !url.pathname.endsWith('/reviews')) {
    return Response.json({
      state: fact.state, draft: fact.draft, mergeable: fact.mergeability === 'mergeable',
      mergeable_state: fact.mergeState, updated_at: fact.externalUpdatedAt,
      user: { login: fact.pullRequestAuthorLogin },
      head: { ref: fact.headBranch, sha: headSha, repo: { full_name: REPOSITORY } },
      base: { ref: fact.baseBranch, sha: fact.pullRequestBaseSha,
        repo: { full_name: REPOSITORY } },
    });
  }
  if (url.pathname.endsWith('/git/ref/heads/main')) {
    return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: fact.baseSha } });
  }
  if (url.pathname.endsWith('/rules/branches/main')) {
    return Response.json([
      { type: 'required_status_checks', parameters: {
        required_status_checks: [{ context: 'ci', integration_id: 42 }],
      } },
      { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
    ]);
  }
  if (url.pathname.includes('/check-runs')) {
    const check = rawCheck(item);
    return Response.json({ total_count: 1, check_runs: [{
      name: 'ci', status: check.status, conclusion: check.conclusion, app: { id: 42 },
    }] });
  }
  if (url.pathname.includes('/status')) return Response.json({ statuses: [] });
  if (url.pathname.endsWith(`/pulls/${fact.number}/reviews`)) {
    return Response.json(item.rejectionReason === 'review_insufficient' ? [] : [{
      id: 9000 + fact.number, user: { login: 'human-reviewer' }, state: 'APPROVED',
      commit_id: fact.headSha, submitted_at: '2026-07-26T11:49:00.000Z',
    }]);
  }
  return new Response('not found', { status: 404 });
}

function fakeFetch(
  manifest: MergeGateEvidenceManifestV1,
  options: { factDrift?: boolean; projectionDrift?: boolean; mergeEffect?: boolean; rawFailure?: boolean } = {},
): typeof fetch {
  const byNumber = new Map(manifest.cases.map((item) => [item.pullRequestNumber, item]));
  let activeItem: CaseItem | null = null;
  return (async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://control.example') {
      const runId = url.pathname.split('/').at(-2);
      const item = manifest.cases.find((candidate) => candidate.runId === runId);
      if (item === undefined) return new Response('missing', { status: 404 });
      return Response.json(auditFor(item, options));
    }
    if (options.rawFailure) {
      return new Response(PR_BODY, { status: 503 });
    }
    const number = Number(url.pathname.match(/\/pulls\/(\d+)/)?.[1]);
    const item = Number.isSafeInteger(number) ? byNumber.get(number) ?? null : activeItem;
    if (item === null) return new Response('missing', { status: 404 });
    activeItem = item;
    void init;
    return githubResponse(item, url, options);
  }) as typeof fetch;
}

describe('merge gate external evidence', () => {
  it('keeps the strict six-case manifest and Watt-derived example boundary', async () => {
    const manifest = await makeManifest();
    expect(MergeGateEvidenceManifestV1Schema.safeParse(manifest).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/merge-gate-evidence-v1.example.json', import.meta.url), 'utf8',
    )) as unknown;
    expect(MergeGateEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(MergeGateEvidenceManifestV1Schema.safeParse({ ...manifest, raw: 'SECRET' }).success).toBe(false);
    expect(MergeGateEvidenceManifestV1Schema.safeParse({
      ...manifest, cases: manifest.cases.slice(0, 5),
    }).success).toBe(false);
  });

  it('verifies ready-to-merge and all five rejection reasons with zero merge effects', async () => {
    const manifest = await makeManifest();
    await expect(verifyMergeGateEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest),
    })).resolves.toEqual({
      schemaVersion: '1', evidenceId: manifest.evidenceId, repository: REPOSITORY,
      caseCount: 6, readyToMergeCases: 1, rejectedCases: 5,
      rejectionReasons: [
        'approval_required', 'base_not_latest', 'required_checks_failed',
        'required_checks_incomplete', 'review_insufficient',
      ],
      mergeEffects: 0,
    });
  });

  it('rejects projection, live fact, and merge-effect drift', async () => {
    const manifest = await makeManifest();
    await expect(verifyMergeGateEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { projectionDrift: true }),
    })).rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
    await expect(verifyMergeGateEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { factDrift: true }),
    })).rejects.toMatchObject({ code: 'github_fact_mismatch' });
    await expect(verifyMergeGateEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { mergeEffect: true }),
    })).rejects.toMatchObject({ code: 'merge_effect_mismatch' });
  });

  it('does not propagate raw response text or tokens', async () => {
    const manifest = await makeManifest();
    const failure = await verifyMergeGateEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { rawFailure: true }),
    }).catch((error: unknown) => error);
    expect(String(failure)).not.toContain(PR_BODY);
    expect(String(failure)).not.toContain(CONTROL_TOKEN);
    expect(String(failure)).not.toContain(GITHUB_TOKEN);
  });

  it('keeps the named CLI opt-in before manifest or network access', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_MERGE_GATE_E2E;
    const result = spawnSync(
      'pnpm', ['exec', 'tsx', 'scripts/verify-merge-gate-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('merge-gate-e2e: opt-in missing');
  });
});
