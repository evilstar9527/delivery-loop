import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  SecretSafetyEvidenceManifestV1Schema,
  type SecretSafetyEvidenceManifestV1,
} from '../src/domain/secret-safety-evidence.js';
import {
  SecretSafetyEvidenceVerificationError,
  verifySecretSafetyEvidence,
} from '../src/pilot/secret-safety-evidence-verifier.js';

const REPOSITORY = 'example/secret-safety';
const CONTROL_TOKEN = 'CANARY_SECRET_SAFETY_CONTROL_TOKEN';
const GITHUB_TOKEN = 'CANARY_SECRET_SAFETY_GITHUB_TOKEN';
const CANARY = 'CANARY_SECRET_SAFETY_VALUE_123456789';
const API_ORIGIN = 'https://api.github.test';
const WORKFLOW_PATH = '.github/workflows/delivery-agent.yml';

function digest(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

type SafetyCase = SecretSafetyEvidenceManifestV1['cases'][number];

async function makeCase(outcome: SafetyCase['outcome'], position: number): Promise<SafetyCase> {
  const safe = outcome === 'safe_draft_pr';
  const headSha = safe ? 'a'.repeat(40) : 'b'.repeat(40);
  const actionRunId = String(9_100 + position);
  const attemptId = `attempt-secret-${outcome}`;
  const body = safe ? 'Automated draft body with no registered credentials.' : '';
  const item = {
    outcome,
    caseId: `case-secret-${outcome}`,
    runId: `run-secret-${outcome}`,
    runState: safe ? 'pull_request_open' : 'verifying',
    repository: REPOSITORY,
    taskRevision: `revision-secret-${outcome}`,
    planId: `plan-secret-${outcome}`,
    planVersion: 1,
    planDigest: digest(safe ? 'a' : 'b'),
    case8ReportDigest: digest('9'),
    attemptId,
    attemptMode: 'implement',
    headSha,
    action: {
      runId: actionRunId,
      workflowPath: WORKFLOW_PATH,
      status: 'completed',
      conclusion: safe ? 'success' : 'failure',
      headSha,
      displayTitle: `delivery-loop/${attemptId}`,
      url: `https://github.com/${REPOSITORY}/actions/runs/${actionRunId}`,
    },
    logScan: {
      jobCount: 1,
      canaryDigest: await canonicalSha256(CANARY),
      observedAt: `2026-07-26T15:0${position}:00.000Z`,
      result: 'clean',
    },
    artifact: safe ? {
      objectId: '11111111-1111-4111-8111-111111111111',
      category: 'raw_transcript',
      ciphertextDigest: digest('c'),
      sizeBytes: 2048,
      policyVersion: 'security-v1-raw-30d',
      deletionState: 'active',
      createdAt: '2026-07-26T14:50:00.000Z',
      expiresAt: '2026-08-25T14:50:00.000Z',
      auditUrl: 'https://audit.example.test/secret-safety/raw-transcript',
    } : null,
    publication: {
      publicationId: `publication-secret-${outcome}`,
      status: safe ? 'verified' : 'pending',
      approvalId: `approval-secret-${outcome}`,
      repository: REPOSITORY,
      baseBranch: 'main',
      headBranch: `delivery/secret-${outcome}`,
      headSha,
      bodyDigest: await canonicalSha256(body),
      number: safe ? 41 : null,
      url: safe ? `https://github.com/${REPOSITORY}/pull/41` : null,
      evidenceId: safe ? `evidence-secret-${outcome}` : null,
    },
    outbox: {
      id: `outbox-secret-${outcome}`,
      state: 'settled',
      lastErrorCode: safe ? null : 'pull_request_secret_detected',
    },
  } as SafetyCase;
  item.case8ReportDigest = await canonicalSha256(auditBodyFor(item));
  return item;
}

async function makeManifest(): Promise<SecretSafetyEvidenceManifestV1> {
  return {
    schemaVersion: '1',
    evidenceId: 'secret-safety-evidence-test',
    repository: REPOSITORY,
    recordedAt: '2026-07-26T15:10:00.000Z',
    cases: [await makeCase('safe_draft_pr', 1), await makeCase('blocked_secret_publication', 2)],
  };
}

function auditBodyFor(
  item: SafetyCase,
  drift: 'none' | 'projection' | 'outbox' | 'artifact' = 'none',
) {
  const artifact = item.artifact === null ? [] : [{
    objectId: item.artifact.objectId,
    attemptId: item.attemptId,
    category: item.artifact.category,
    ciphertextDigest: item.artifact.ciphertextDigest,
    sizeBytes: item.artifact.sizeBytes,
    policyVersion: item.artifact.policyVersion,
    deletionState: item.artifact.deletionState,
    createdAt: item.artifact.createdAt,
    expiresAt: item.artifact.expiresAt,
  }];
  const changes = [{
    kind: 'pull_request', publicationId: item.publication.publicationId,
    status: item.publication.status, approvalId: item.publication.approvalId,
    repository: REPOSITORY, baseBranch: item.publication.baseBranch,
    headBranch: item.publication.headBranch, headSha: item.headSha,
    bodyDigest: item.publication.bodyDigest,
    number: item.publication.number, url: item.publication.url,
    evidenceId: item.publication.evidenceId,
  }];
  return {
    schemaVersion: '1',
    runId: item.runId,
    run: { state: drift === 'projection' ? 'verifying' : item.runState },
    task: { repository: REPOSITORY, revision: item.taskRevision },
    digests: { plans: [{ planId: item.planId, version: item.planVersion, digest: item.planDigest }] },
    answers: {
      who: { attempts: [{ attemptId: item.attemptId, mode: item.attemptMode }] },
      changes,
      checks: {
        secretArtifacts: drift === 'artifact' ? [] : artifact,
        effectOutboxes: [{
          id: item.outbox.id, kind: 'pull_request', state: 'settled',
          ...(drift === 'outbox'
            ? { lastErrorCode: item.outbox.lastErrorCode === null ? 'pull_request_secret_detected' : null }
            :
            item.outbox.lastErrorCode === null ? {} : { lastErrorCode: item.outbox.lastErrorCode }),
        }],
      },
    },
  };
}

async function auditFor(
  item: SafetyCase,
  drift: 'none' | 'projection' | 'outbox' | 'artifact' = 'none',
) {
  const body = auditBodyFor(item, drift);
  return {
    ...body,
    generatedAt: '2026-07-26T15:09:00.000Z',
    queryDurationMs: 12,
    reportDigest: await canonicalSha256(body),
  };
}

function fakeFetch(
  input: SecretSafetyEvidenceManifestV1,
  drift: 'none' | 'projection' | 'outbox' | 'artifact' | 'log-leak' | 'pr' | 'pagination' = 'none',
): typeof fetch {
  return (async (request) => {
    const url = new URL(String(request));
    if (url.origin === 'https://control.example') {
      const runId = url.pathname.split('/').at(-2);
      const item = input.cases.find((candidate) => candidate.runId === runId);
      if (item === undefined) return new Response('missing', { status: 404 });
      return Response.json(await auditFor(
        item,
        drift === 'projection' ? 'projection'
          : drift === 'outbox' ? 'outbox'
            : drift === 'artifact' ? 'artifact' : 'none',
      ));
    }
    const item = input.cases.find((candidate) => url.pathname.includes(`/runs/${candidate.action.runId}`)) ??
      input.cases.find((candidate) => url.pathname.includes(`/pulls/${candidate.publication.number}`)) ??
      input.cases[0];
    if (item === undefined) return new Response('missing', { status: 404 });
    if (url.pathname.endsWith('/pulls')) {
      return Response.json(drift === 'pr' ? [{}] : []);
    }
    if (url.pathname.includes('/actions/runs/') && url.pathname.endsWith('/jobs')) {
      return Response.json({ jobs: [{ id: 71_000 + Number(item.action.runId), status: 'completed' }] });
    }
    if (url.pathname.includes('/actions/runs/')) {
      const response = Response.json({
        id: Number(item.action.runId), event: 'workflow_dispatch', status: item.action.status,
        conclusion: item.action.conclusion, head_sha: item.headSha, head_branch: 'main',
        path: WORKFLOW_PATH, display_title: item.action.displayTitle, run_attempt: 1,
        updated_at: '2026-07-26T15:00:00.000Z', repository: { full_name: REPOSITORY },
      });
      if (drift === 'pagination') response.headers.set('link', '<https://api.github.test/next>; rel="next"');
      return response;
    }
    if (url.pathname.includes('/actions/jobs/')) {
      return new Response(drftLog(drift === 'log-leak' ? CANARY : 'safe action log'));
    }
    if (url.pathname.includes('/pulls/')) {
      if (!item.publication.number) return new Response('missing', { status: 404 });
      return Response.json({
        number: item.publication.number, state: 'open', draft: true,
        html_url: drift === 'pr' ? 'https://github.com/example/secret-safety/pull/99' : item.publication.url,
        body: drift === 'pr' ? 'drifted body' : 'Automated draft body with no registered credentials.',
        head: { ref: item.publication.headBranch, sha: item.headSha, repo: { full_name: REPOSITORY } },
        base: { ref: item.publication.baseBranch, repo: { full_name: REPOSITORY } },
      });
    }
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
}

function drftLog(text: string): string {
  return text;
}

describe('secret safety external evidence', () => {
  it('verifies safe Draft PR and blocked Secret publication cases', async () => {
    const input = await makeManifest();
    expect(SecretSafetyEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/secret-safety-evidence-v1.example.json', import.meta.url), 'utf8',
    )) as unknown;
    expect(SecretSafetyEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(SecretSafetyEvidenceManifestV1Schema.safeParse({ ...input, raw: 'SECRET' }).success).toBe(false);
    await expect(verifySecretSafetyEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, canarySecret: CANARY, githubApiOrigin: API_ORIGIN,
      fetch: fakeFetch(input),
    })).resolves.toEqual({
      schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
      caseCount: 2, safeDraftCases: 1, blockedPublicationCases: 1,
      verifiedActions: 2, scannedJobs: 2, verifiedPullRequests: 1,
      verifiedCiphertextRegistries: 1, plaintextLeaks: 0,
    });
  });

  it('rejects log, projection, outbox, artifact, PR and pagination drift', async () => {
    const input = await makeManifest();
    await expect(verifySecretSafetyEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, canarySecret: CANARY, githubApiOrigin: API_ORIGIN,
      fetch: fakeFetch(input, 'log-leak'),
    })).rejects.toMatchObject({ code: 'github_log_leak_detected' });
    for (const [drift, code] of [
      ['projection', 'control_plane_projection_mismatch'],
      ['outbox', 'publication_effect_mismatch'],
      ['artifact', 'artifact_projection_mismatch'],
      ['pr', 'github_pull_request_mismatch'],
      ['pagination', 'github_api_unavailable'],
    ] as const) {
      const error = await verifySecretSafetyEvidence(input, {
        controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
        githubToken: GITHUB_TOKEN, canarySecret: CANARY, githubApiOrigin: API_ORIGIN,
        fetch: fakeFetch(input, drift),
      }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(SecretSafetyEvidenceVerificationError);
      expect(error).toMatchObject({ code });
    }
  });

  it('rejects a response leak before JSON parsing and requires the canonical Case 8 digest', async () => {
    const input = await makeManifest();
    const leaked = fakeFetch(input);
    await expect(verifySecretSafetyEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, canarySecret: CANARY, githubApiOrigin: API_ORIGIN,
      fetch: (async (request, init) => {
        const url = new URL(String(request));
        if (url.pathname.includes('/pulls/41')) {
          return new Response(`{"body":${JSON.stringify(CANARY)}}`, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return await leaked(request, init);
      }) as typeof fetch,
    })).rejects.toMatchObject({ code: 'secret_leak_detected' });

    input.cases[0]!.case8ReportDigest = digest('8');
    await expect(verifySecretSafetyEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, canarySecret: CANARY, githubApiOrigin: API_ORIGIN,
      fetch: fakeFetch(input),
    })).rejects.toMatchObject({ code: 'case8_digest_mismatch' });
  });

  it('does not expose canary/token/raw response and preserves Watt opt-in exit 2', async () => {
    const input = await makeManifest();
    const raw = 'CANARY_SECRET_SAFETY_RAW_RESPONSE';
    const error = await verifySecretSafetyEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, canarySecret: CANARY, githubApiOrigin: API_ORIGIN,
      fetch: async () => new Response(raw, { status: 503 }),
    }).catch((value: unknown) => value);
    expect(String(error)).not.toContain(raw);
    expect(String(error)).not.toContain(CONTROL_TOKEN);
    expect(String(error)).not.toContain(GITHUB_TOKEN);
    expect(String(error)).not.toContain(CANARY);
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_SECRET_SAFETY_E2E;
    const result = spawnSync(
      'pnpm', ['exec', 'tsx', 'scripts/verify-secret-safety-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('secret-safety-e2e: opt-in missing');
  });
});
