import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  RepositoryBootstrapEvidenceManifestV1Schema,
  type RepositoryBootstrapEvidenceManifestV1,
} from '../src/domain/repository-bootstrap-evidence.js';
import { verifyRepositoryBootstrapEvidence } from '../src/pilot/repository-bootstrap-evidence-verifier.js';

const REPOSITORY = 'example/delivery-loop';
const GITHUB_TOKEN = 'CANARY_REPOSITORY_BOOTSTRAP_TOKEN';
const API_ORIGIN = 'https://api.github.test';
const HEAD_SHA = 'a'.repeat(40);
const ORIGIN_URL = `https://github.com/${REPOSITORY}.git`;

type Manifest = RepositoryBootstrapEvidenceManifestV1;
type Rule = Manifest['protection']['rules'][number];
type Drift =
  | 'none'
  | 'visibility'
  | 'default_branch'
  | 'archived'
  | 'fork'
  | 'branch_sha'
  | 'unprotected'
  | 'rules'
  | 'pagination'
  | 'oversize';

const RAW_RULES = [
  {
    type: 'required_status_checks',
    ruleset_id: 101,
    ruleset_source_type: 'Repository',
    ruleset_source: REPOSITORY,
    enforcement: 'active',
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: [{ context: 'verify', integration_id: 15_368 }],
    },
  },
  {
    type: 'pull_request',
    ruleset_id: 101,
    ruleset_source_type: 'Repository',
    ruleset_source: REPOSITORY,
    enforcement: 'active',
    parameters: {
      required_approving_review_count: 1,
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
    },
  },
  {
    type: 'non_fast_forward',
    ruleset_id: 101,
    ruleset_source_type: 'Repository',
    ruleset_source: REPOSITORY,
    enforcement: 'active',
    parameters: null,
  },
] as const;

async function normalizedRules(raw = RAW_RULES): Promise<Rule[]> {
  const rules = await Promise.all(raw.map(async (item) => ({
    rulesetId: String(item.ruleset_id),
    type: item.type,
    rulesetSourceType: item.ruleset_source_type,
    rulesetSource: item.ruleset_source,
    enforcement: item.enforcement,
    parametersDigest: await canonicalSha256(item.parameters),
  })));
  return rules.sort((left, right) =>
    `${left.rulesetId}\0${left.type}\0${left.parametersDigest}`.localeCompare(
      `${right.rulesetId}\0${right.type}\0${right.parametersDigest}`,
    ));
}

async function manifest(): Promise<Manifest> {
  const rules = await normalizedRules();
  const rulesDigest = await canonicalSha256(rules);
  const selection = {
    repository: REPOSITORY,
    visibility: 'private' as const,
    defaultBranch: 'main',
    protectionRulesDigest: rulesDigest,
  };
  return {
    schemaVersion: '1',
    evidenceId: 'repository-bootstrap-evidence-test',
    recordedAt: '2026-07-27T11:00:00.000+08:00',
    decision: {
      decisionId: 'repository-bootstrap-decision-test',
      confirmedAt: '2026-07-27T10:30:00.000+08:00',
      confirmedByPrincipalDigest: await canonicalSha256('principal:test-user'),
      selectionDigest: await canonicalSha256(selection),
      ...selection,
    },
    repository: {
      githubRepositoryId: '900001',
      ownerLogin: 'example',
      ownerType: 'Organization',
      name: 'delivery-loop',
      fullName: REPOSITORY,
      htmlUrl: `https://github.com/${REPOSITORY}`,
      visibility: 'private',
      defaultBranch: 'main',
      createdAt: '2026-07-27T02:00:00.000Z',
      archived: false,
      disabled: false,
      fork: false,
    },
    branch: {
      name: 'main',
      headSha: HEAD_SHA,
      protected: true,
    },
    protection: { rules, rulesDigest },
  };
}

function responseJson(value: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeFetch(input: Manifest, drift: Drift = 'none'): typeof fetch {
  return (async (request) => {
    const url = new URL(String(request));
    if (url.pathname === `/repos/${REPOSITORY}`) {
      if (drift === 'oversize') {
        return responseJson({}, { 'content-length': String(2 * 1_024 * 1_024) });
      }
      return responseJson({
        id: Number(input.repository.githubRepositoryId),
        name: input.repository.name,
        full_name: input.repository.fullName,
        html_url: input.repository.htmlUrl,
        visibility: drift === 'visibility' ? 'public' : input.repository.visibility,
        private: drift === 'visibility' ? false : true,
        default_branch: drift === 'default_branch' ? 'trunk' : input.repository.defaultBranch,
        archived: drift === 'archived',
        disabled: false,
        fork: drift === 'fork',
        created_at: input.repository.createdAt,
        owner: { login: input.repository.ownerLogin, type: input.repository.ownerType },
      });
    }
    if (url.pathname === `/repos/${REPOSITORY}/branches/main`) {
      return responseJson({
        name: 'main',
        protected: drift !== 'unprotected',
        commit: { sha: drift === 'branch_sha' ? 'b'.repeat(40) : HEAD_SHA },
      });
    }
    if (url.pathname === `/repos/${REPOSITORY}/rules/branches/main`) {
      const rules = RAW_RULES.map((rule, index) => drift === 'rules' && index === 0
        ? { ...rule, enforcement: null, parameters: { ...rule.parameters, strict_required_status_checks_policy: false } }
        : { ...rule, enforcement: null });
      return responseJson(
        rules,
        drift === 'pagination' ? { link: '<https://api.github.test/next>; rel="next"' } : undefined,
      );
    }
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
}

describe('repository bootstrap external evidence', () => {
  it('binds the user decision, local origin, repository, default branch and active rules', async () => {
    const input = await manifest();
    expect(RepositoryBootstrapEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/repository-bootstrap-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(RepositoryBootstrapEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    await expect(verifyRepositoryBootstrapEvidence(input, {
      githubToken: GITHUB_TOKEN,
      githubApiOrigin: API_ORIGIN,
      localOriginUrl: ORIGIN_URL,
      fetch: fakeFetch(input),
    })).resolves.toEqual({
      schemaVersion: '1',
      evidenceId: input.evidenceId,
      decisionId: input.decision.decisionId,
      repository: REPOSITORY,
      visibility: 'private',
      defaultBranch: 'main',
      githubRepositoryId: input.repository.githubRepositoryId,
      branchHeadSha: HEAD_SHA,
      activeRuleCount: 3,
      rulesDigest: input.protection.rulesDigest,
      localOriginMatched: true,
    });
  });

  it('rejects a changed decision or a local origin outside the selected repository', async () => {
    const changedDecision = await manifest();
    changedDecision.decision.visibility = 'public';
    changedDecision.repository.visibility = 'public';
    await expect(verifyRepositoryBootstrapEvidence(changedDecision, {
      githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN,
      localOriginUrl: ORIGIN_URL, fetch: fakeFetch(changedDecision),
    })).rejects.toMatchObject({ code: 'decision_digest_mismatch' });
    const input = await manifest();
    await expect(verifyRepositoryBootstrapEvidence(input, {
      githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN,
      localOriginUrl: `git@github.com:${REPOSITORY}.git`, fetch: fakeFetch(input),
    })).resolves.toMatchObject({ localOriginMatched: true });
    for (const localOriginUrl of [
      'https://github.com/example/another.git',
      'https://token@github.com/example/delivery-loop.git',
      'https://gitlab.example/example/delivery-loop.git',
    ]) {
      await expect(verifyRepositoryBootstrapEvidence(input, {
        githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN,
        localOriginUrl, fetch: fakeFetch(input),
      })).rejects.toMatchObject({ code: 'local_remote_mismatch' });
    }
  });

  it('rejects repository identity, visibility, lifecycle and default branch drift', async () => {
    for (const drift of ['visibility', 'default_branch', 'archived', 'fork'] as const) {
      const input = await manifest();
      await expect(verifyRepositoryBootstrapEvidence(input, {
        githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN,
        localOriginUrl: ORIGIN_URL, fetch: fakeFetch(input, drift),
      })).rejects.toMatchObject({ code: 'github_repository_mismatch' });
    }
  });

  it('rejects default branch SHA/protection and active rule drift', async () => {
    for (const drift of ['branch_sha', 'unprotected'] as const) {
      const input = await manifest();
      await expect(verifyRepositoryBootstrapEvidence(input, {
        githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN,
        localOriginUrl: ORIGIN_URL, fetch: fakeFetch(input, drift),
      })).rejects.toMatchObject({ code: 'github_branch_mismatch' });
    }
    const input = await manifest();
    await expect(verifyRepositoryBootstrapEvidence(input, {
      githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN,
      localOriginUrl: ORIGIN_URL, fetch: fakeFetch(input, 'rules'),
    })).rejects.toMatchObject({ code: 'github_protection_mismatch' });
  });

  it('fails closed on pagination/oversize without propagating raw responses or tokens', async () => {
    for (const drift of ['pagination', 'oversize'] as const) {
      const input = await manifest();
      await expect(verifyRepositoryBootstrapEvidence(input, {
        githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN,
        localOriginUrl: ORIGIN_URL, fetch: fakeFetch(input, drift),
      })).rejects.toBeInstanceOf(Error);
    }
    const input = await manifest();
    const raw = `RAW_${GITHUB_TOKEN}`;
    const error = await verifyRepositoryBootstrapEvidence(input, {
      githubToken: GITHUB_TOKEN,
      githubApiOrigin: API_ORIGIN,
      localOriginUrl: ORIGIN_URL,
      fetch: async () => new Response(raw, { status: 503 }),
    }).catch((value: unknown) => value);
    expect(String(error)).not.toContain(raw);
    expect(String(error)).not.toContain(GITHUB_TOKEN);
  });

  it('keeps the named E2E command behind Watt-derived opt-in', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_REPOSITORY_BOOTSTRAP_E2E;
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/verify-repository-bootstrap-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('repository-bootstrap-e2e: opt-in missing');
  });
});
