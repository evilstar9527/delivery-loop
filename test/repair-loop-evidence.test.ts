import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RepairLoopEvidenceManifestV1Schema,
  type RepairLoopEvidenceManifestV1,
} from '../src/domain/repair-loop-evidence.js';
import { verifyRepairLoopEvidence } from '../src/pilot/repair-loop-evidence-verifier.js';

const REPOSITORY = 'example/repair-loop';
const CONTROL_TOKEN = 'CANARY_REPAIR_LOOP_CONTROL_TOKEN';
const GITHUB_TOKEN = 'CANARY_REPAIR_LOOP_GITHUB_TOKEN';
const API_ORIGIN = 'https://api.github.test';
const WORKFLOW_PATH = '.github/workflows/delivery-agent.yml';
const BASE_SHA = 'a'.repeat(40);

function digest(seed: string): string {
  const hex = Array.from(seed)
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${(hex + '0'.repeat(64)).slice(0, 64)}`;
}

type RepairCase = RepairLoopEvidenceManifestV1['cases'][number];

function attempt(
  prefix: string,
  ordinal: number,
  actionConclusion: 'failure' | 'success',
  fingerprint: string | null,
): RepairCase['attempts'][number] {
  const success = actionConclusion === 'success';
  const head = success ? 'b'.repeat(40) : BASE_SHA;
  return {
    attemptId: `${prefix}-attempt-${ordinal}`,
    ordinal,
    mode: ordinal === 1 ? 'implement' : 'review_fix',
    actionRunId: String(7_000 + Number(prefix.slice(-1)) * 10 + ordinal),
    actionConclusion,
    workflowHeadSha: head,
    branch: `agent/task/${prefix}-attempt-${ordinal}`,
    checkoutSha: BASE_SHA,
    resultHeadSha: success ? head : null,
    failureFingerprint: fingerprint === null ? null : digest(fingerprint),
  };
}

function makeCase(kind: 'success' | 'repeated' | 'limit', index: number): RepairCase {
  const prefix = `repair-${kind}-${index}`;
  const attempts = kind === 'success'
    ? [attempt(prefix, 1, 'failure', 'first'), attempt(prefix, 2, 'success', null)]
    : kind === 'repeated'
      ? [attempt(prefix, 1, 'failure', 'same'), attempt(prefix, 2, 'failure', 'same')]
      : [attempt(prefix, 1, 'failure', 'one'), attempt(prefix, 2, 'failure', 'two'), attempt(prefix, 3, 'failure', 'three')];
  const evidence: RepairCase['evidence'][number][] = attempts.flatMap((current) => {
    if (current.actionConclusion === 'success') {
      return [
        { evidenceId: `${prefix}-commit`, attemptId: current.attemptId, kind: 'commit' as const, status: 'passed' as const, verificationStatus: 'verified' as const, sha: current.workflowHeadSha },
        { evidenceId: `${prefix}-test`, attemptId: current.attemptId, kind: 'test' as const, status: 'passed' as const, verificationStatus: 'verified' as const, sha: current.workflowHeadSha },
      ] as RepairCase['evidence'][number][];
    }
    return [{ evidenceId: `${current.attemptId}-test`, attemptId: current.attemptId, kind: 'test' as const, status: 'failed' as const, verificationStatus: 'verified' as const, sha: current.workflowHeadSha }] as RepairCase['evidence'][number][];
  });
  const blocked = kind !== 'success';
  const lastFingerprint = attempts.at(-1)!.failureFingerprint!;
  return {
    outcome: kind === 'success' ? 'repair_succeeded' : kind === 'repeated' ? 'repeated_fingerprint_blocked' : 'attempt_limit_blocked',
    caseId: `${prefix}-case`,
    runId: `${prefix}-run`,
    runState: blocked ? 'blocked' : 'verifying',
    repository: REPOSITORY,
    taskRevision: `${prefix}-revision`,
    planId: `${prefix}-plan`,
    planVersion: 1,
    planDigest: digest(prefix),
    planItemId: `${prefix}-item`,
    baseSha: BASE_SHA,
    workflowPath: WORKFLOW_PATH,
    attempts,
    evidence,
    blocker: blocked ? {
      id: `${prefix}-blocker`,
      reason: kind === 'repeated' ? 'repeated_fingerprint' as const : 'attempt_limit' as const,
      fingerprintDigest: lastFingerprint,
      attemptCount: attempts.length,
      consecutiveFingerprintCount: kind === 'repeated' ? 2 : 1,
      neededHumanInputCode: 'manual_investigation' as const,
      attemptedPaths: ['targeted_test'],
    } : null,
    noDuplicate: {
      repairAttempts: attempts.length,
      executionDispatches: attempts.length,
      commitEvidence: evidence.filter((entry) => entry.kind === 'commit').length,
    },
  } as RepairCase;
}

function manifest(): RepairLoopEvidenceManifestV1 {
  return {
    schemaVersion: '1',
    evidenceId: 'repair-loop-evidence-test',
    repository: REPOSITORY,
    recordedAt: '2026-07-26T17:10:00.000Z',
    cases: [makeCase('success', 1), makeCase('repeated', 2), makeCase('limit', 3)],
  };
}

function planView(item: RepairCase, drift: boolean): Record<string, unknown> {
  const blocker = item.blocker === null ? undefined : {
    id: item.blocker.id,
    reason: item.blocker.reason,
    fingerprintDigest: item.blocker.fingerprintDigest,
    attemptCount: item.blocker.attemptCount,
    consecutiveFingerprintCount: item.blocker.consecutiveFingerprintCount,
    neededHumanInput: { code: item.blocker.neededHumanInputCode, prompt: 'Review safe failure summary.' },
    attemptedPaths: item.blocker.attemptedPaths.map((code) => ({ code, label: 'Run trusted targeted verification' })),
  };
  return {
    run: {
      id: item.runId,
      state: drift ? 'executing' : item.runState,
      ...(blocker === undefined ? {} : { blocker }),
    },
    plan: { id: item.planId, version: item.planVersion, digest: item.planDigest, baseSha: item.baseSha },
    items: [{ id: item.planItemId, status: item.outcome === 'repair_succeeded' ? 'passed' : 'blocked' }],
    attempts: item.attempts.map((current) => ({
      id: current.attemptId,
      ordinal: current.ordinal,
      mode: current.mode,
      status: current.actionConclusion === 'success' ? 'completed' : 'failed',
      baseSha: current.checkoutSha,
      headBranch: current.branch,
      headSha: current.workflowHeadSha,
    })),
  };
}

function auditView(item: RepairCase): Record<string, unknown> {
  return {
    schemaVersion: '1',
    runId: item.runId,
    run: { state: item.runState },
    answers: {
      who: { attempts: item.attempts.map((current) => ({
        attemptId: current.attemptId,
        ordinal: current.ordinal,
        mode: current.mode,
        githubRunId: current.actionRunId,
        githubStatus: 'completed',
        githubConclusion: current.actionConclusion,
        headSha: current.workflowHeadSha,
      })) },
      checks: {
        evidence: item.evidence.map((entry) => ({
          evidenceId: entry.evidenceId,
          attemptId: entry.attemptId,
          kind: entry.kind,
          status: entry.status,
          verificationStatus: entry.verificationStatus,
          sha: entry.sha,
        })),
        effectOutboxes: item.attempts.map((current) => ({
          id: `${current.attemptId}-dispatch`, kind: 'execution_dispatch', state: 'settled',
        })),
      },
    },
  };
}

function fakeFetch(input: RepairLoopEvidenceManifestV1, drift: 'none' | 'control' | 'action' | 'raw' = 'none'): typeof fetch {
  return (async (request) => {
    const url = new URL(String(request));
    const item = input.cases.find((candidate) => url.pathname.includes(`/runs/${candidate.runId}`)) ??
      input.cases.find((candidate) => candidate.attempts.some((attempt) =>
        url.pathname.includes(`/runs/${attempt.actionRunId}`) || url.pathname.includes(`/jobs/${attempt.actionRunId}`) ||
        (attempt.resultHeadSha !== null && url.pathname.includes(attempt.resultHeadSha)) ||
        url.pathname.includes(encodeURIComponent(`heads/${attempt.branch}`))));
    if (item === undefined) return new Response('missing', { status: 404 });
    if (url.origin === 'https://control.example') {
      return Response.json(url.pathname.endsWith('/plan')
        ? planView(item, drift === 'control') : auditView(item));
    }
    const attempt = item.attempts.find((candidate) =>
      url.pathname.endsWith(`/runs/${candidate.actionRunId}`) ||
      url.pathname.includes(`/actions/runs/${candidate.actionRunId}`) ||
      url.pathname.includes(`/jobs/`) ||
      (candidate.resultHeadSha !== null && url.pathname.includes(candidate.resultHeadSha)) ||
      url.pathname.includes(encodeURIComponent(`heads/${candidate.branch}`)),
    );
    if (attempt === undefined) return new Response('missing', { status: 404 });
    if (url.pathname.includes('/actions/runs/') && url.pathname.endsWith('/jobs')) {
      const current = item.attempts.find((candidate) => url.pathname.includes(`/runs/${candidate.actionRunId}`))!;
      return Response.json({
        total_count: 1,
        jobs: [{
          name: 'attempt', status: 'completed', conclusion: current.actionConclusion,
          steps: [
            { name: 'Checkout trusted execution snapshot', status: 'completed', conclusion: 'success' },
            { name: 'Run approved execution attempt', status: 'completed', conclusion: current.actionConclusion },
          ],
        }],
      });
    }
    if (url.pathname.includes('/actions/runs/')) {
      const current = item.attempts.find((candidate) => url.pathname.endsWith(`/runs/${candidate.actionRunId}`))!;
      return Response.json({
        id: Number(current.actionRunId), event: 'workflow_dispatch', status: 'completed',
        conclusion: drift === 'action' ? 'success' : current.actionConclusion,
        head_sha: current.workflowHeadSha, head_branch: current.branch, path: WORKFLOW_PATH,
        display_title: `delivery-loop/${current.attemptId}`, run_attempt: 1,
        updated_at: '2026-07-26T17:00:00.000Z', repository: { full_name: REPOSITORY },
      });
    }
    if (attempt?.resultHeadSha !== null && url.pathname.includes('/commits/')) {
      return Response.json(drift === 'raw' ? { sha: 'CANARY_REPAIR_LOOP_RAW' } : { sha: attempt.resultHeadSha });
    }
    if (attempt?.resultHeadSha !== null && url.pathname.includes('/git/ref/')) {
      return Response.json({ object: { sha: attempt.resultHeadSha } });
    }
    if (attempt?.resultHeadSha !== null && url.pathname.includes('/compare/')) {
      return Response.json({ status: 'ahead', ahead_by: 1, behind_by: 0, base_commit: { sha: attempt.checkoutSha } });
    }
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
}

describe('repair loop external evidence', () => {
  it('requires success, repeated-fingerprint and attempt-limit cases', async () => {
    const input = manifest();
    expect(RepairLoopEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/repair-loop-evidence-v1.example.json', import.meta.url), 'utf8',
    )) as unknown;
    expect(RepairLoopEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    await expect(verifyRepairLoopEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN, fetch: fakeFetch(input),
    })).resolves.toEqual({
      schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
      caseCount: 3, repairedCases: 1, repeatedFingerprintBlockedCases: 1,
      attemptLimitBlockedCases: 1, verifiedActionRunCount: 7, verifiedJobCount: 7,
      verifiedCommitCount: 1, verifiedGitRelationshipCount: 1, duplicateRepairEffects: 0,
    });
  });

  it('rejects control/action/raw drift without leaking token or response text', async () => {
    const input = manifest();
    await expect(verifyRepairLoopEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN, fetch: fakeFetch(input, 'control'),
    })).rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
    await expect(verifyRepairLoopEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN, fetch: fakeFetch(input, 'action'),
    })).rejects.toMatchObject({ code: 'github_action_mismatch' });
    const raw = 'CANARY_REPAIR_LOOP_RAW_RESPONSE';
    const error = await verifyRepairLoopEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN,
      fetch: async () => new Response(raw, { status: 503 }),
    }).catch((value: unknown) => value);
    expect(String(error)).not.toContain(raw);
    expect(String(error)).not.toContain(CONTROL_TOKEN);
    expect(String(error)).not.toContain(GITHUB_TOKEN);
  });

  it('keeps the E2E command behind Watt-derived opt-in', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_REPAIR_LOOP_E2E;
    const result = spawnSync(
      'pnpm', ['exec', 'tsx', 'scripts/verify-repair-loop-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('repair-loop-e2e: opt-in missing');
  });
});
