import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  MergeEvidenceManifestV1Schema,
  type MergeEvidenceCase,
  type MergeEvidenceManifestV1,
} from '../src/domain/merge-evidence.js';
import { verifyMergeEvidence } from '../src/pilot/merge-evidence-verifier.js';

const REPOSITORY = 'example/merge-evidence';
const CONTROL_TOKEN = 'CANARY_MERGE_CONTROL_TOKEN';
const GITHUB_TOKEN = 'CANARY_MERGE_GITHUB_TOKEN';
const SHA = (letter: string) => letter.repeat(40);
const DIGEST = (letter: string) => `sha256:${letter.repeat(64)}`;

type MergedCase = Exclude<MergeEvidenceCase, { outcome: 'not_merged' }>;

async function makeMergedCase(
  outcome: MergedCase['outcome'],
  position: number,
): Promise<MergedCase> {
  const headSha = SHA(String.fromCharCode(97 + position));
  const mergeSha = SHA(['d', 'e', 'f'][position - 1]!);
  const number = 100 + position;
  const time = `2026-07-26T1${position}:00:00.000Z`;
  const fact = {
    schemaVersion: '1' as const,
    repository: REPOSITORY,
    number,
    url: `https://github.com/${REPOSITORY}/pull/${number}`,
    state: 'closed' as const,
    merged: true as const,
    headBranch: `delivery/task/${outcome}`,
    headSha,
    baseBranch: 'main',
    mergeSha,
    mergedByLogin: `reviewer-${outcome}`,
    mergedAt: time,
    externalUpdatedAt: `2026-07-26T1${position}:01:00.000Z`,
  };
  return {
    caseId: `case-${outcome}`,
    runId: `run-${outcome}`,
    runVersion: 8,
    currentRunVersion: 10,
    repository: REPOSITORY,
    planId: `plan-${outcome}`,
    planVersion: 1,
    planDigest: DIGEST(String(position)),
    decisionId: `decision-${outcome}`,
    publicationId: `publication-${outcome}`,
    baseSha: SHA(String(position)),
    pullRequest: {
      repository: REPOSITORY,
      number,
      url: fact.url,
      headBranch: fact.headBranch,
      headSha,
      baseBranch: fact.baseBranch,
    },
    outcome,
    runState: outcome === 'merged_production' ? 'deploying' : 'succeeded',
    mergeId: `github-merge-${outcome}`,
    mergeEvidenceId: `evidence-merge-${outcome}`,
    deploymentDisposition: outcome === 'merged_none' ? 'none' : outcome === 'merged_test' ? 'test' : 'production',
    merge: fact,
    webhook: {
      sourceKind: 'webhook',
      id: `webhook-${outcome}`,
      digest: DIGEST(String.fromCharCode(97 + position)),
      processingState: 'applied',
      ignoreReason: null,
      externalUpdatedAt: fact.externalUpdatedAt,
      observedAt: '2026-07-26T15:00:00.000Z',
      processedAt: '2026-07-26T15:00:01.000Z',
    },
    apiObservation: {
      sourceKind: 'api',
      id: `api-${outcome}`,
      digest: await canonicalSha256(fact),
      processingState: 'applied',
      ignoreReason: null,
      externalUpdatedAt: fact.externalUpdatedAt,
      observedAt: '2026-07-26T15:01:00.000Z',
      processedAt: '2026-07-26T15:01:01.000Z',
    },
    noDuplicate: { merges: 1, observations: 2, mergeEvidence: 1, mergeOutboxes: 0 },
  };
}

async function makeManifest(): Promise<MergeEvidenceManifestV1> {
  const merged = await Promise.all([
    makeMergedCase('merged_none', 1),
    makeMergedCase('merged_test', 2),
    makeMergedCase('merged_production', 3),
  ]);
  return {
    schemaVersion: '1',
    evidenceId: 'merge-evidence-test',
    repository: REPOSITORY,
    recordedAt: '2026-07-26T15:10:00.000Z',
    cases: [
      ...merged,
      {
        caseId: 'case-not-merged',
        runId: 'run-not-merged',
        runVersion: 8,
        currentRunVersion: 8,
        repository: REPOSITORY,
        planId: 'plan-not-merged',
        planVersion: 1,
        planDigest: DIGEST('e'),
        decisionId: 'decision-not-merged',
        publicationId: 'publication-not-merged',
        baseSha: SHA('2'),
        pullRequest: {
          repository: REPOSITORY,
          number: 104,
          url: `https://github.com/${REPOSITORY}/pull/104`,
          headBranch: 'delivery/task/not-merged',
          headSha: SHA('1'),
          baseBranch: 'main',
        },
        outcome: 'not_merged',
        runState: 'ready_to_merge',
        mergeId: null,
        mergeEvidenceId: null,
        deploymentDisposition: 'none',
        merge: null,
        webhook: null,
        apiObservation: null,
        noDuplicate: { merges: 0, observations: 0, mergeEvidence: 0, mergeOutboxes: 0 },
      },
    ],
  };
}

function auditFor(item: MergeEvidenceCase, options: { drift?: 'projection' | 'effect' | 'observation' } = {}) {
  const merged = item.outcome !== 'not_merged';
  const changes = merged ? [{
    kind: 'merge', mergeId: item.mergeId, publicationId: item.publicationId,
    planId: item.planId, planVersion: item.planVersion, planDigest: item.planDigest,
    repository: REPOSITORY, pullRequestNumber: item.pullRequest.number,
    headSha: item.merge.headSha, baseSha: item.baseSha, mergeSha: item.merge.mergeSha,
    mergedBy: item.merge.mergedByLogin, mergedAt: item.merge.mergedAt,
    deploymentDisposition: item.deploymentDisposition, evidenceId: item.mergeEvidenceId,
  }] : [];
  const observations = merged ? [item.webhook, item.apiObservation].map((observation) => ({
    observationId: observation.id, sourceKind: observation.sourceKind,
    factDigest: observation.digest, repository: REPOSITORY,
    githubPrNumber: item.pullRequest.number, processingState: observation.processingState,
    ignoreReason: observation.ignoreReason, externalUpdatedAt: observation.externalUpdatedAt,
    observedAt: observation.observedAt, processedAt: observation.processedAt,
  })) : [];
  return {
    schemaVersion: '1',
    run: {
      id: item.runId,
      version: options.drift === 'projection' ? item.currentRunVersion + 1 : item.currentRunVersion,
      state: item.runState,
    },
    task: { repository: REPOSITORY },
    answers: {
      changes,
      checks: {
        mergeObservations: options.drift === 'observation' ? [] : observations,
        evidence: merged ? [{
          evidenceId: item.mergeEvidenceId, kind: 'pull_request', status: 'passed',
          verificationStatus: 'verified', sha: item.merge.mergeSha, url: item.merge.url,
        }] : [],
        effectOutboxes: options.drift === 'effect' ? [{ kind: 'merge' }] : [],
      },
    },
  };
}

function fakeFetch(
  manifest: MergeEvidenceManifestV1,
  drift: 'none' | 'projection' | 'github' | 'effect' | 'observation' = 'none',
): typeof fetch {
  return (async (request) => {
    const url = new URL(String(request));
    if (url.origin === 'https://control.example') {
      const runId = url.pathname.split('/').at(-2);
      const item = manifest.cases.find((candidate) => candidate.runId === runId);
      return item === undefined ? new Response('missing', { status: 404 }) : Response.json(
        auditFor(item, {
          ...(drift === 'projection' ? { drift: 'projection' as const } : {}),
          ...(drift === 'effect' ? { drift: 'effect' as const } : {}),
          ...(drift === 'observation' ? { drift: 'observation' as const } : {}),
        }),
      );
    }
    const number = Number(url.pathname.split('/').at(-1));
    const item = manifest.cases.find((candidate) => candidate.pullRequest.number === number);
    if (item === undefined) return new Response('missing', { status: 404 });
    if (item.outcome === 'not_merged') {
      return Response.json({
        number, html_url: item.pullRequest.url, state: 'closed', merged: false,
        merge_commit_sha: null, merged_at: null, merged_by: null,
        head: { ref: item.pullRequest.headBranch, sha: item.pullRequest.headSha,
          repo: { full_name: REPOSITORY } },
        base: { ref: item.pullRequest.baseBranch, sha: item.baseSha,
          repo: { full_name: REPOSITORY } },
        updated_at: '2026-07-26T15:02:00.000Z',
      });
    }
    const fact = item.merge;
    return Response.json({
      number, html_url: fact.url, state: 'closed', merged: true,
      merge_commit_sha: drift === 'github' && item.outcome === 'merged_test' ? SHA('0') : fact.mergeSha,
      merged_at: fact.mergedAt, merged_by: { login: fact.mergedByLogin },
      head: { ref: fact.headBranch, sha: fact.headSha, repo: { full_name: REPOSITORY } },
      base: { ref: fact.baseBranch, sha: item.baseSha, repo: { full_name: REPOSITORY } },
      updated_at: fact.externalUpdatedAt,
    });
  }) as typeof fetch;
}

describe('GitHub merge external evidence', () => {
  it('verifies no-deploy success, deployment-pending merges and closed-unmerged case', async () => {
    const input = await makeManifest();
    expect(MergeEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/merge-evidence-v1.example.json', import.meta.url), 'utf8',
    )) as unknown;
    expect(MergeEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(MergeEvidenceManifestV1Schema.safeParse({ ...input, raw: 'SECRET' }).success).toBe(false);
    await expect(verifyMergeEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(input),
    })).resolves.toEqual({
      schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
      caseCount: 4, mergedCases: 3, noDeploySucceededCases: 1,
      completedAtMergeCases: 2, deploymentPendingCases: 1,
      notMergedCases: 1, verifiedMergeCount: 3,
      duplicateMergeEffects: 0,
    });
  });

  it('rejects projection, observation, GitHub and merge-effect drift without raw/token leakage', async () => {
    const input = await makeManifest();
    await expect(verifyMergeEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(input, 'projection'),
    })).rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
    await expect(verifyMergeEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(input, 'observation'),
    })).rejects.toMatchObject({ code: 'merge_observation_mismatch' });
    await expect(verifyMergeEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(input, 'github'),
    })).rejects.toMatchObject({ code: 'github_fact_mismatch' });
    await expect(verifyMergeEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(input, 'effect'),
    })).rejects.toMatchObject({ code: 'merge_effect_mismatch' });
    const raw = 'CANARY_MERGE_RAW_RESPONSE';
    const error = await verifyMergeEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: async () => new Response(raw, { status: 503 }),
    }).catch((value: unknown) => value);
    expect(String(error)).not.toContain(raw);
    expect(String(error)).not.toContain(CONTROL_TOKEN);
    expect(String(error)).not.toContain(GITHUB_TOKEN);
  });

  it('keeps the Watt-derived CLI opt-in before manifest or network access', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_MERGE_E2E;
    const result = spawnSync(
      'pnpm', ['exec', 'tsx', 'scripts/verify-merge-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('merge-e2e: opt-in missing');
  });
});
