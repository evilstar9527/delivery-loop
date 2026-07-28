import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  GitHubPullRequestEvidenceManifestV1Schema,
  type GitHubPullRequestEvidenceManifestV1,
} from '../src/domain/github-pull-request-evidence.js';
import { verifyGitHubPullRequestEvidence } from '../src/pilot/github-pull-request-evidence-verifier.js';

const MANIFEST: GitHubPullRequestEvidenceManifestV1 = {
  schemaVersion: '1',
  evidenceId: 'github-pr-evidence-1',
  recordedAt: '2026-07-26T15:00:00.000Z',
  runId: 'run-github-pr-evidence-1',
  repository: 'example/delivery-pilot',
  publication: {
    publicationId: 'pr-publication-evidence-1',
    approvalId: 'approval-pr-evidence-1',
    repository: 'example/delivery-pilot',
    baseBranch: 'main',
    headBranch: 'delivery/task-evidence/attempt-1',
    headSha: 'a'.repeat(40),
    bodyDigest: `sha256:${'1'.repeat(64)}`,
    status: 'verified',
    number: 42,
    url: 'https://github.com/example/delivery-pilot/pull/42',
    evidenceId: 'evidence-pr-evidence-1',
    webhook: {
      deliveryId: 'delivery-pr-evidence-1',
      payloadDigest: `sha256:${'2'.repeat(64)}`,
      processingState: 'applied',
      externalUpdatedAt: '2026-07-26T14:40:00.000Z',
      receivedAt: '2026-07-26T14:40:01.000Z',
    },
    apiObservation: {
      observationId: 'github-pr-api-evidence-1',
      factDigest: `sha256:${'3'.repeat(64)}`,
      processingState: 'applied',
      externalUpdatedAt: '2026-07-26T14:40:00.000Z',
      observedAt: '2026-07-26T14:41:00.000Z',
    },
  },
};

const PR_BODY = 'Generated from durable Task and verified Evidence.';

async function fixture(): Promise<GitHubPullRequestEvidenceManifestV1> {
  return {
    ...MANIFEST,
    publication: {
      ...MANIFEST.publication,
      bodyDigest: await canonicalSha256(PR_BODY),
    },
  };
}

function audit(manifest: GitHubPullRequestEvidenceManifestV1): Record<string, unknown> {
  const p = manifest.publication;
  return {
    schemaVersion: '1',
    runId: manifest.runId,
    run: { state: 'pull_request_open', version: 8 },
    task: { repository: manifest.repository },
    answers: {
      changes: [{
        kind: 'pull_request', publicationId: p.publicationId, approvalId: p.approvalId,
        repository: p.repository, baseBranch: p.baseBranch, headBranch: p.headBranch,
        headSha: p.headSha, bodyDigest: p.bodyDigest, status: p.status,
        number: p.number, url: p.url, evidenceId: p.evidenceId,
      }],
      checks: {
        pullRequestObservations: [
          {
            sourceKind: 'webhook', sourceId: p.webhook.deliveryId,
            publicationId: p.publicationId, repository: p.repository,
            githubPrNumber: p.number, factDigest: p.webhook.payloadDigest,
            processingState: p.webhook.processingState, ignoreReason: null,
            externalUpdatedAt: p.webhook.externalUpdatedAt,
            observedAt: p.webhook.receivedAt, processedAt: p.webhook.receivedAt,
          },
          {
            sourceKind: 'api', sourceId: p.apiObservation.observationId,
            publicationId: p.publicationId, repository: p.repository,
            githubPrNumber: p.number, factDigest: p.apiObservation.factDigest,
            processingState: p.apiObservation.processingState, ignoreReason: null,
            externalUpdatedAt: p.apiObservation.externalUpdatedAt,
            observedAt: p.apiObservation.observedAt, processedAt: p.apiObservation.observedAt,
          },
        ],
      },
    },
  };
}

function githubPr(manifest: GitHubPullRequestEvidenceManifestV1, body = PR_BODY) {
  const p = manifest.publication;
  return {
    number: p.number,
    html_url: p.url,
    state: 'open',
    draft: true,
    body,
    head: { ref: p.headBranch, sha: p.headSha, repo: { full_name: p.repository } },
    base: { ref: p.baseBranch, repo: { full_name: p.repository } },
    updated_at: p.apiObservation.externalUpdatedAt,
  };
}

function fakeFetch(
  manifest: GitHubPullRequestEvidenceManifestV1,
  options: { auditBody?: unknown; prBody?: string } = {},
): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.origin === 'https://control.example') {
      return Response.json(options.auditBody ?? audit(manifest));
    }
    return Response.json(githubPr(manifest, options.prBody ?? PR_BODY));
  }) as typeof fetch;
}

describe('GitHub pull request external evidence', () => {
  it('keeps the strict publication/webhook/API manifest', () => {
    expect(GitHubPullRequestEvidenceManifestV1Schema.safeParse(MANIFEST).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/github-pull-request-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(GitHubPullRequestEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(GitHubPullRequestEvidenceManifestV1Schema.safeParse({
      ...MANIFEST,
      publication: { ...MANIFEST.publication, status: 'created_unverified' },
    }).success).toBe(false);
    expect(GitHubPullRequestEvidenceManifestV1Schema.safeParse({
      ...MANIFEST,
      rawBody: 'CANARY_PR_BODY',
    }).success).toBe(false);
  });

  it('cross-checks Case 8 publication, both source facts, and live GitHub PR', async () => {
    const manifest = await fixture();
    const summary = await verifyGitHubPullRequestEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example',
      controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN',
      githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest),
    });
    expect(summary).toEqual({
      schemaVersion: '1',
      evidenceId: manifest.evidenceId,
      repository: manifest.repository,
      runId: manifest.runId,
      publication: 'verified',
      webhook: 'applied',
      apiObservation: 'applied',
      githubPullRequest: 'verified',
      pullRequestNumber: 42,
    });
  });

  it('rejects missing source facts, stale head, and body drift', async () => {
    const manifest = await fixture();
    const missingWebhook = audit(manifest);
    const answers = missingWebhook.answers as Record<string, unknown>;
    const checks = answers.checks as Record<string, unknown>;
    checks.pullRequestObservations = [
      (checks.pullRequestObservations as Array<Record<string, unknown>>)[1],
    ];
    await expect(verifyGitHubPullRequestEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example',
      controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN',
      fetch: fakeFetch(manifest, { auditBody: missingWebhook }),
    })).rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
    const stale = { ...manifest, publication: { ...manifest.publication, headSha: 'b'.repeat(40) } };
    await expect(verifyGitHubPullRequestEvidence(stale, {
      controlPlaneOrigin: 'https://control.example',
      controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN',
      githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest),
    })).rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
    await expect(verifyGitHubPullRequestEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example',
      controlPlaneToken: 'CANARY_CONTROL_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN',
      githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { prBody: 'forged body' }),
    })).rejects.toMatchObject({ code: 'github_pull_request_mismatch' });
  });

  it('never propagates raw GitHub response text or tokens', async () => {
    const manifest = await fixture();
    const raw = 'CANARY_RAW_GITHUB_PR_RESPONSE';
    const failure = await verifyGitHubPullRequestEvidence(manifest, {
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
    expect(typeof verifyGitHubPullRequestEvidence).toBe('function');
  });

  it('keeps the named CLI opt-in before manifest or network access', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_GITHUB_PR_E2E;
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/verify-github-pull-request-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('github-pr-e2e: opt-in missing');
  });
});
