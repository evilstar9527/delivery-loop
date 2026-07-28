import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  ProductionApprovalEvidenceManifestV1Schema,
  type ProductionApprovalEvidenceManifestV1,
} from '../src/domain/production-approval-evidence.js';
import { verifyProductionApprovalEvidence } from '../src/pilot/production-approval-evidence-verifier.js';

const REPOSITORY = 'example/production-approval';
const CONTROL_TOKEN = 'CANARY_PRODUCTION_APPROVAL_CONTROL_TOKEN';
const GITHUB_TOKEN = 'CANARY_PRODUCTION_APPROVAL_GITHUB_TOKEN';
const SHA = (letter: string) => letter.repeat(40);
const DIGEST = (letter: string) => `sha256:${letter.repeat(64)}`;
type CaseItem = ProductionApprovalEvidenceManifestV1['cases'][number];

async function makeCase(
  outcome: 'accepted' | 'rejected',
  rejectionReason: 'self_approval_denied' | 'merge_binding_mismatch' | null,
  position: number,
): Promise<CaseItem> {
  const mergeSha = SHA(['b', 'd', 'f'][position - 1]!);
  const headSha = SHA(['a', 'c', 'e'][position - 1]!);
  const number = 40 + position;
  const mergeFact = {
    schemaVersion: '1' as const,
    repository: REPOSITORY,
    number,
    url: `https://github.com/${REPOSITORY}/pull/${number}`,
    state: 'closed' as const,
    merged: true as const,
    headBranch: `delivery/production/${position}`,
    headSha,
    baseBranch: 'main',
    mergeSha,
    mergedByLogin: 'merge-reviewer',
    mergedAt: `2026-07-26T1${position}:00:00.000Z`,
    externalUpdatedAt: `2026-07-26T1${position}:01:00.000Z`,
  };
  const source = {
    provider: 'feishu' as const,
    tenantKey: 'tenant-production',
    externalEventId: `event-production-approval-${position}`,
    externalSubject: outcome === 'accepted' ? 'ou-release-reviewer' : `ou-rejected-${position}`,
    sourceId: `source-production-approval-${position}`,
    eventDigest: DIGEST(String(position + 1)),
    channel: 'feishu:tenant-production',
    channelUserId: outcome === 'accepted' ? 'ou-release-reviewer' : `ou-rejected-${position}`,
    occurredAt: `2026-07-26T1${position}:30:00.000Z`,
  };
  const roles = outcome === 'accepted'
    ? ['approve:production_deploy', 'human']
    : rejectionReason === 'self_approval_denied'
      ? ['approve:production_deploy', 'human']
      : ['human'];
  const authorPrincipal = 'agent:delivery-bot';
  const approverPrincipal = outcome === 'accepted'
    ? 'user:release-reviewer'
    : rejectionReason === 'self_approval_denied' ? authorPrincipal : 'user:unmapped-reviewer';
  const common = {
    caseId: `production-approval-${position}`,
    runId: `run-production-approval-${position}`,
    runVersion: 13,
    currentRunVersion: 13,
    runState: 'deploying' as const,
    repository: REPOSITORY,
    taskRevision: `revision-production-${position}`,
    planId: `plan-production-${position}`,
    planVersion: 1,
    planDigest: DIGEST(String(position + 5)),
    baseSha: SHA('1'),
    mergeId: `github-merge-production-${position}`,
    mergeSha,
    environment: 'production' as const,
    source,
    identity: {
      approverPrincipal,
      approverRoles: roles,
      approverRolesDigest: await canonicalSha256(roles),
      authorPrincipal,
      authorLogin: 'delivery-bot',
      separationVerified: outcome === 'accepted',
    },
    mergeFact,
    noEffect: { productionOutboxes: 0 as const, productionDeployments: 0 as const, productionAttempts: 0 as const },
  };
  return outcome === 'accepted'
    ? {
      ...common,
      outcome: 'accepted' as const,
      approvalId: `approval-production-${position}`,
      lineageId: `lineage-production-${position}`,
      rejectionId: null,
      rejectionReason: null,
      expiresAt: '2026-07-27T00:00:00.000Z',
      binding: {
        approvalId: `approval-production-${position}`,
        taskRevision: common.taskRevision,
        planId: common.planId,
        planVersion: 1,
        planDigest: common.planDigest,
        baseSha: common.baseSha,
        mergeId: common.mergeId,
        mergeSha,
        environment: 'production' as const,
        createdAt: '2026-07-26T11:31:00.000Z',
      },
    }
    : {
      ...common,
      outcome: 'rejected' as const,
      approvalId: null,
      lineageId: null,
      rejectionId: `rejection-production-${position}`,
      rejectionReason: rejectionReason!,
      expiresAt: null,
      binding: null,
    };
}

async function makeManifest(): Promise<ProductionApprovalEvidenceManifestV1> {
  return {
    schemaVersion: '1',
    evidenceId: 'production-approval-evidence-test',
    recordedAt: '2026-07-26T15:00:00.000Z',
    repository: REPOSITORY,
    cases: [
      await makeCase('accepted', null, 1),
      await makeCase('rejected', 'self_approval_denied', 2),
      await makeCase('rejected', 'merge_binding_mismatch', 3),
    ],
  };
}

function auditFor(item: CaseItem, drift: 'none' | 'binding' | 'effect' = 'none') {
  const accepted = item.outcome === 'accepted';
  const source = item.source;
  const identity = item.identity;
  const identityRow = {
    sourceId: source.sourceId, provider: source.provider, tenantKey: source.tenantKey,
    externalEventId: source.externalEventId, eventDigest: source.eventDigest,
    channel: source.channel, channelUserId: source.channelUserId,
    sourceOccurredAt: source.occurredAt, outcome: item.outcome,
    runId: item.runId, taskRevision: item.taskRevision, planId: item.planId,
    planVersion: item.planVersion, planDigest: item.planDigest, baseSha: item.baseSha,
    effect: 'production_deploy', decision: 'approve',
    approverPrincipal: drift === 'binding' ? 'user:drift' : identity.approverPrincipal,
    authorPrincipal: identity.authorPrincipal, authorLogin: identity.authorLogin,
    rolesDigest: identity.approverRolesDigest, separationVerified: identity.separationVerified,
    approvalId: accepted ? item.approvalId : undefined,
    lineageId: accepted ? item.lineageId : undefined,
    rejectionId: accepted ? undefined : item.rejectionId,
    reason: accepted ? undefined : item.rejectionReason,
    expiresAt: accepted ? item.expiresAt : undefined,
    decisionRecordedAt: source.occurredAt,
  };
  const binding = accepted ? item.binding : null;
  return {
    schemaVersion: '1',
    run: { id: item.runId, version: item.currentRunVersion, state: item.runState },
    task: { repository: REPOSITORY },
    answers: {
      who: { attempts: [] },
      approvals: accepted ? [{
        approvalId: item.approvalId, effect: 'production_deploy', decision: 'approve',
        planId: item.planId, planVersion: item.planVersion, planDigest: item.planDigest,
        baseSha: item.baseSha, approver: identity.approverPrincipal,
        lineageId: item.lineageId, invalidated: false,
      }] : [],
      deployments: drift === 'effect' ? [{ kind: 'production', deploymentId: 'production-effect' }] : [],
      checks: {
        identityApprovals: [identityRow],
        productionApprovals: binding === null ? [] : [{
          approvalId: binding.approvalId, runId: item.runId, taskRevision: binding.taskRevision,
          planId: binding.planId, planVersion: binding.planVersion, planDigest: binding.planDigest,
          baseSha: binding.baseSha, mergeId: binding.mergeId, mergeSha: binding.mergeSha,
          environment: 'production', decision: 'approve', expiresAt: item.expiresAt,
          sourceId: source.sourceId, provider: source.provider, eventDigest: source.eventDigest,
          approverPrincipal: identity.approverPrincipal, rolesDigest: identity.approverRolesDigest,
          separationVerified: true,
        }],
        effectOutboxes: drift === 'effect' ? [{ kind: 'production_deploy' }] : [],
      },
    },
  };
}

function fakeFetch(
  manifest: ProductionApprovalEvidenceManifestV1,
  drift: 'none' | 'binding' | 'effect' | 'github' = 'none',
): typeof fetch {
  return (async (request) => {
    const url = new URL(String(request));
    if (url.origin === 'https://control.example') {
      const runId = url.pathname.split('/').at(-2);
      const item = manifest.cases.find((candidate) => candidate.runId === runId);
      return item === undefined ? new Response('missing', { status: 404 }) : Response.json(
        auditFor(item, drift === 'binding' ? 'binding' : drift === 'effect' ? 'effect' : 'none'),
      );
    }
    const number = Number(url.pathname.split('/').at(-1));
    const item = manifest.cases.find((candidate) => candidate.mergeFact.number === number);
    if (item === undefined) return new Response('missing', { status: 404 });
    const fact = item.mergeFact;
    return Response.json({
      number, html_url: fact.url, state: 'closed', merged: true,
      merge_commit_sha: drift === 'github' && item.outcome === 'accepted' ? SHA('0') : fact.mergeSha,
      merged_at: fact.mergedAt, merged_by: { login: fact.mergedByLogin },
      head: { ref: fact.headBranch, sha: fact.headSha, repo: { full_name: REPOSITORY } },
      base: { ref: fact.baseBranch, sha: fact.headSha, repo: { full_name: REPOSITORY } },
      updated_at: fact.externalUpdatedAt,
    });
  }) as typeof fetch;
}

describe('production approval external evidence', () => {
  it('verifies exact revision/merge/environment binding and rejected zero-effect paths', async () => {
    const input = await makeManifest();
    expect(ProductionApprovalEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/production-approval-evidence-v1.example.json', import.meta.url), 'utf8',
    )) as unknown;
    expect(ProductionApprovalEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(ProductionApprovalEvidenceManifestV1Schema.safeParse({ ...input, raw: 'SECRET' }).success).toBe(false);
    await expect(verifyProductionApprovalEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(input),
    })).resolves.toEqual({
      schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
      caseCount: 3, acceptedCases: 1, rejectedCases: 2,
      verifiedMergeFacts: 3, productionEffects: 0,
    });
  });

  it('rejects binding, GitHub and effect drift without leaking raw/token data', async () => {
    const input = await makeManifest();
    await expect(verifyProductionApprovalEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test', fetch: fakeFetch(input, 'binding'),
    })).rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
    await expect(verifyProductionApprovalEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test', fetch: fakeFetch(input, 'github'),
    })).rejects.toMatchObject({ code: 'github_fact_mismatch' });
    await expect(verifyProductionApprovalEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test', fetch: fakeFetch(input, 'effect'),
    })).rejects.toMatchObject({ code: 'production_effect_mismatch' });
    const raw = 'CANARY_PRODUCTION_APPROVAL_RAW_RESPONSE';
    const error = await verifyProductionApprovalEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: async () => new Response(raw, { status: 503 }),
    }).catch((value: unknown) => value);
    expect(String(error)).not.toContain(raw);
    expect(String(error)).not.toContain(CONTROL_TOKEN);
    expect(String(error)).not.toContain(GITHUB_TOKEN);
  });

  it('keeps Watt-derived CLI opt-in before manifest or network access', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_PRODUCTION_APPROVAL_E2E;
    const result = spawnSync(
      'pnpm', ['exec', 'tsx', 'scripts/verify-production-approval-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('production-approval-e2e: opt-in missing');
  });
});
