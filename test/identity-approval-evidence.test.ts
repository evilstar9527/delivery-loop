import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  IdentityApprovalEvidenceManifestV1Schema,
  type IdentityApprovalEvidenceManifestV1,
} from '../src/domain/identity-approval-evidence.js';
import { verifyIdentityApprovalEvidence } from '../src/pilot/identity-approval-evidence-verifier.js';

const REPOSITORY = 'example/identity-target';
const CONTROL_TOKEN = 'CANARY_IDENTITY_CONTROL_TOKEN';
const GITHUB_TOKEN = 'CANARY_IDENTITY_GITHUB_TOKEN';

type CaseItem = IdentityApprovalEvidenceManifestV1['cases'][number];

const SPECS = [
  { caseId: 'accepted-merge', runId: 'run-accepted-merge', effect: 'merge' as const, outcome: 'accepted' as const, provider: 'github' as const, number: 21, key: 'merge-accepted', authorPrincipal: 'agent:delivery-bot', authorLogin: 'delivery-bot', approverPrincipal: 'user:merge-reviewer', subject: 'human-reviewer', reason: null },
  { caseId: 'rejected-merge', runId: 'run-rejected-merge', effect: 'merge' as const, outcome: 'rejected' as const, provider: 'github' as const, number: 22, key: 'merge-rejected', authorPrincipal: 'agent:delivery-bot', authorLogin: 'delivery-bot', approverPrincipal: 'agent:delivery-bot', subject: 'delivery-bot', reason: 'self_approval_denied' as const },
  { caseId: 'accepted-production', runId: 'run-accepted-production', effect: 'production_deploy' as const, outcome: 'accepted' as const, provider: 'feishu' as const, number: null, key: 'production-accepted', authorPrincipal: 'agent:delivery-bot', authorLogin: 'delivery-bot', approverPrincipal: 'user:release-reviewer', subject: 'ou_release_reviewer', reason: null },
  { caseId: 'rejected-production', runId: 'run-rejected-production', effect: 'production_deploy' as const, outcome: 'rejected' as const, provider: 'feishu' as const, number: null, key: 'production-rejected', authorPrincipal: 'user:requester', authorLogin: 'requester', approverPrincipal: 'user:requester', subject: 'ou_requester', reason: 'task_actor_self_approval' as const },
];

async function makeManifest(): Promise<IdentityApprovalEvidenceManifestV1> {
  const cases: CaseItem[] = [];
  for (const [index, spec] of SPECS.entries()) {
    const roles = [`approve:${spec.effect}`, 'human'].sort();
    const sourceProviderTenant = spec.provider === 'github' ? REPOSITORY : 'tenant-identity';
    const sourceChannel = `${spec.provider}:${sourceProviderTenant}`;
    const authorChannel = `github:${REPOSITORY}`;
    const baseSha = 'a'.repeat(40);
    const headSha = String.fromCharCode(98 + index).repeat(40);
    const approvalId = spec.outcome === 'accepted' ? `approval-${spec.key}` : null;
    const lineageId = spec.outcome === 'accepted' ? `lineage-${spec.key}` : null;
    const rejectionId = spec.outcome === 'rejected' ? `rejection-${spec.key}` : null;
    const source = {
      provider: spec.provider, tenantKey: sourceProviderTenant,
      externalEventId: `event-${spec.key}`, externalSubject: spec.subject,
      sourceId: `source-${spec.key}`,
      eventDigest: `sha256:${String(index + 2).repeat(64)}`,
      channel: sourceChannel, channelUserId: spec.subject,
      occurredAt: `2026-07-26T14:${30 + index} :00.000Z`.replace(' ', ''),
    };
    const identity = {
      approverPrincipal: spec.approverPrincipal,
      approverRoles: roles,
      approverRolesDigest: await canonicalSha256(roles),
      authorPrincipal: spec.authorPrincipal,
      authorChannel,
      authorLogin: spec.authorLogin,
      separationVerified: spec.outcome === 'accepted',
    };
    const common = {
      caseId: spec.caseId, runId: spec.runId, repository: REPOSITORY,
      runVersion: index + 4, currentRunVersion: index + 4,
      taskRevision: `revision-${spec.key}`, planId: `plan-${spec.key}`,
      planVersion: 1, planDigest: `sha256:${String(index + 1).repeat(64)}`,
      baseSha, effect: spec.effect, decision: 'approve' as const,
      source, identity,
      github: spec.number === null ? null : {
        pullRequestNumber: spec.number, headBranch: `agent/task/${spec.key}`,
        baseBranch: 'main', headSha,
      },
      noEffect: { mergeOutboxes: 0 as const, merges: 0 as const,
        productionOutboxes: 0 as const, productionDeployments: 0 as const },
    };
    cases.push(spec.outcome === 'accepted'
      ? { ...common, outcome: 'accepted', approvalId: approvalId!, lineageId: lineageId!, rejectionId: null, rejectionReason: null, expiresAt: '2026-07-27T00:00:00.000Z' }
      : { ...common, outcome: 'rejected', approvalId: null, lineageId: null, rejectionId: rejectionId!, rejectionReason: spec.reason!, expiresAt: null });
  }
  return {
    schemaVersion: '1', evidenceId: 'identity-approval-evidence-test',
    recordedAt: '2026-07-26T15:00:00.000Z', repository: REPOSITORY, cases,
  };
}

function auditFor(item: CaseItem, options: { drift?: boolean; effect?: boolean } = {}) {
  const source = item.source;
  const identity = item.identity;
  const row = {
    sourceId: source.sourceId, provider: source.provider, tenantKey: source.tenantKey,
    externalEventId: source.externalEventId, eventDigest: source.eventDigest,
    channel: source.channel, channelUserId: source.channelUserId,
    sourceOccurredAt: source.occurredAt, outcome: item.outcome,
    runId: item.runId, taskRevision: item.taskRevision, planId: item.planId,
    planVersion: item.planVersion, planDigest: item.planDigest, baseSha: item.baseSha,
    effect: item.effect, decision: item.decision,
    approverPrincipal: options.drift ? 'user:drift' : identity.approverPrincipal,
    approverChannel: source.channel, approverChannelUserId: source.channelUserId,
    authorPrincipal: identity.authorPrincipal, authorChannel: identity.authorChannel,
    authorLogin: identity.authorLogin, rolesDigest: identity.approverRolesDigest,
    separationVerified: identity.separationVerified,
    decisionRecordedAt: '2026-07-26T14:40:00.000Z',
    approvalId: item.outcome === 'accepted' ? item.approvalId : undefined,
    lineageId: item.outcome === 'accepted' ? item.lineageId : undefined,
    rejectionId: item.outcome === 'rejected' ? item.rejectionId : undefined,
    reason: item.outcome === 'rejected' ? item.rejectionReason : undefined,
    expiresAt: item.outcome === 'accepted' ? item.expiresAt : undefined,
  };
  return {
    schemaVersion: '1', run: { id: item.runId, version: item.currentRunVersion },
    answers: {
      changes: options.effect ? [{ kind: 'merge', mergeId: 'merge-drift' }] : [],
      approvals: item.outcome === 'accepted' ? [{
        approvalId: item.approvalId, effect: item.effect, decision: 'approve',
        planId: item.planId, planVersion: item.planVersion, planDigest: item.planDigest,
        baseSha: item.baseSha, approver: identity.approverPrincipal,
        lineageId: item.lineageId, invalidated: false,
      }] : [],
      deployments: [],
      checks: {
        identityApprovals: [row],
        effectOutboxes: options.effect ? [{ kind: 'merge' }] : [],
      },
    },
  };
}

function fakeFetch(
  manifest: IdentityApprovalEvidenceManifestV1,
  options: { drift?: boolean; githubDrift?: boolean; effect?: boolean; rawFailure?: boolean } = {},
): typeof fetch {
  let active: CaseItem | null = null;
  return (async (input) => {
    const url = new URL(String(input));
    if (url.origin === 'https://control.example') {
      const runId = url.pathname.split('/').at(-2);
      const item = manifest.cases.find((candidate) => candidate.runId === runId);
      if (item === undefined) return new Response('missing', { status: 404 });
      active = item;
      return Response.json(auditFor(item, options));
    }
    if (options.rawFailure) return new Response('CANARY_IDENTITY_RAW_RESPONSE', { status: 503 });
    if (active === null || active.github === null) return new Response('missing', { status: 404 });
    const github = active.github;
    if (url.pathname.endsWith(`/pulls/${github.pullRequestNumber}`)) {
      return Response.json({
        state: 'open',
        user: { login: options.githubDrift ? 'other-author' : active.identity.authorLogin },
        head: { ref: github.headBranch, sha: github.headSha, repo: { full_name: REPOSITORY } },
        base: { ref: github.baseBranch, sha: 'a'.repeat(40), repo: { full_name: REPOSITORY } },
      });
    }
    if (url.pathname.endsWith(`/pulls/${github.pullRequestNumber}/reviews`)) {
      return Response.json([{
        id: 9000 + github.pullRequestNumber,
        user: { login: active.source.externalSubject }, state: 'APPROVED',
        commit_id: github.headSha, submitted_at: '2026-07-26T14:30:00.000Z',
      }]);
    }
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
}

describe('identity approval external evidence', () => {
  it('keeps the strict accepted/rejected GitHub and Feishu cases', async () => {
    const manifest = await makeManifest();
    expect(IdentityApprovalEvidenceManifestV1Schema.safeParse(manifest).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/identity-approval-evidence-v1.example.json', import.meta.url), 'utf8',
    )) as unknown;
    expect(IdentityApprovalEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(IdentityApprovalEvidenceManifestV1Schema.safeParse({ ...manifest, raw: 'SECRET' }).success).toBe(false);
  });

  it('cross-checks accepted separation, self-approval rejection and zero effects', async () => {
    const manifest = await makeManifest();
    await expect(verifyIdentityApprovalEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest),
    })).resolves.toEqual({
      schemaVersion: '1', evidenceId: manifest.evidenceId, repository: REPOSITORY,
      caseCount: 4, acceptedCases: 2, rejectedCases: 2,
      selfApprovalRejections: 2, mergeEffects: 0, productionEffects: 0,
    });
  });

  it('rejects identity, GitHub and effect drift without leaking raw data', async () => {
    const manifest = await makeManifest();
    await expect(verifyIdentityApprovalEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { drift: true }),
    })).rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
    await expect(verifyIdentityApprovalEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { githubDrift: true }),
    })).rejects.toMatchObject({ code: 'github_fact_mismatch' });
    await expect(verifyIdentityApprovalEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { effect: true }),
    })).rejects.toMatchObject({ code: 'effect_mismatch' });
    const failure = await verifyIdentityApprovalEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(manifest, { rawFailure: true }),
    }).catch((error: unknown) => error);
    expect(String(failure)).not.toContain(CONTROL_TOKEN);
    expect(String(failure)).not.toContain(GITHUB_TOKEN);
    expect(String(failure)).not.toContain('CANARY_IDENTITY_RAW_RESPONSE');
  });

  it('keeps the CLI opt-in before manifest or network access', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_IDENTITY_APPROVAL_E2E;
    const result = spawnSync(
      'pnpm', ['exec', 'tsx', 'scripts/verify-identity-approval-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('identity-approval-e2e: opt-in missing');
  });
});
