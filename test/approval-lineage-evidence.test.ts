import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  ApprovalLineageEvidenceManifestV1Schema,
  ApprovalLineageObservabilityReportV1Schema,
  type ApprovalLineageEvidenceManifestV1,
  type ApprovalLineageObservabilityReportV1,
} from '../src/domain/approval-lineage-evidence.js';
import {
  verifyApprovalLineageEvidence,
} from '../src/pilot/approval-lineage-evidence-verifier.js';

const CONTROL_ORIGIN = 'https://control.example';
const OBSERVER_URL = 'https://observer.example/approval-lineage/round-112';
const GITHUB_ORIGIN = 'https://api.github.example';
const OPERATIONS_TOKEN = 'approval-lineage-operations-purpose';
const OBSERVABILITY_TOKEN = 'approval-lineage-observer-purpose';
const GITHUB_TOKEN = 'approval-lineage-github-read-purpose';
const CANARY = 'github_pat_APPROVAL_LINEAGE_CANARY_1234567890';
const REPOSITORY = 'example/delivery-target';
const OPEN_ID = 'ou_delivery_reviewer';
const CHAT_ID = 'oc_delivery_pilot';

function digest(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(2, '0').repeat(32)}`;
}

interface Fixture {
  manifest: ApprovalLineageEvidenceManifestV1;
  report: ApprovalLineageObservabilityReportV1;
  audit: Record<string, unknown>;
  feishu: Record<string, unknown>;
  isolation: Record<string, unknown>;
  pullRequest: Record<string, unknown>;
  reviews: Array<Record<string, unknown>>;
}

async function fixture(): Promise<Fixture> {
  const roles = ['approve:merge', 'human'];
  const principal = 'user:delivery-reviewer';
  const taskDigest = digest(1);
  const rolesDigest = await canonicalSha256(roles);
  const principalDigest = await canonicalSha256(principal);
  const openIdDigest = await canonicalSha256(OPEN_ID);
  const chatDigest = await canonicalSha256(CHAT_ID);
  const feishu = {
    externalEventId: 'evt_feishu_approval_primary',
    externalEventDigest: digest(2),
    sourceId: 'approval_source_feishu_primary',
    approvalId: 'approval_feishu_primary',
    lineageId: 'approval_lineage_feishu_primary',
    sourceOccurredAt: '2026-07-27T09:00:00.000Z',
    decisionRecordedAt: '2026-07-27T09:00:01.000Z',
    expiresAt: '2026-07-27T11:00:00.000Z',
    tenantKey: 'tenant_delivery_loop',
    appId: 'cli_delivery_loop',
    deliveryId: 'delivery_feishu_primary',
    actionReceiptId: 'receipt_feishu_primary',
    outcomeId: 'outcome_feishu_primary',
    operatorDigest: openIdDigest,
    openIdDigest,
    chatDigest,
    messageId: 'om_approval_lineage',
    cardId: 'card_approval_lineage',
    presentationId: 'presentation_approval_lineage',
    actionId: 'action_approve_merge',
    requestDigest: digest(3),
  };
  const github = {
    externalEventId: 'evt_github_approval_primary',
    externalEventDigest: digest(4),
    sourceId: 'approval_source_github_primary',
    approvalId: 'approval_github_primary',
    lineageId: 'approval_lineage_github_primary',
    sourceOccurredAt: '2026-07-27T09:01:00.000Z',
    decisionRecordedAt: '2026-07-27T09:01:01.000Z',
    expiresAt: '2026-07-27T11:01:00.000Z',
    requestDigest: digest(7),
    reviewerLogin: 'delivery-reviewer',
    pullRequestNumber: 42,
    reviewId: '9001',
    headBranch: 'codex/approval-lineage',
    baseBranch: 'main',
    headSha: 'b'.repeat(40),
    reviewSubmittedAt: '2026-07-27T09:01:00.000Z',
  };
  const requestRows = [
    {
      scenario: 'feishu_primary' as const,
      provider: 'feishu' as const,
      externalEventId: feishu.externalEventId,
      externalEventDigest: feishu.externalEventDigest,
      requestDigest: feishu.requestDigest,
      responseDigest: digest(20),
      signatureVerified: true as const,
      signatureAlgorithm: 'feishu_v2' as const,
      statusCode: 200 as const,
      outcome: 'created' as const,
      approvalId: feishu.approvalId,
      lineageId: feishu.lineageId,
      reasonCode: null,
    },
    {
      scenario: 'feishu_retry' as const,
      provider: 'feishu' as const,
      externalEventId: feishu.externalEventId,
      externalEventDigest: feishu.externalEventDigest,
      requestDigest: feishu.requestDigest,
      responseDigest: digest(21),
      signatureVerified: true as const,
      signatureAlgorithm: 'feishu_v2' as const,
      statusCode: 200 as const,
      outcome: 'converged' as const,
      approvalId: feishu.approvalId,
      lineageId: feishu.lineageId,
      reasonCode: null,
    },
    {
      scenario: 'feishu_distinct_event' as const,
      provider: 'feishu' as const,
      externalEventId: 'evt_feishu_approval_distinct',
      externalEventDigest: digest(5),
      requestDigest: digest(6),
      responseDigest: digest(22),
      signatureVerified: true as const,
      signatureAlgorithm: 'feishu_v2' as const,
      statusCode: 409 as const,
      outcome: 'rejected' as const,
      approvalId: null,
      lineageId: null,
      reasonCode: 'replay_rejected' as const,
    },
    {
      scenario: 'github_primary' as const,
      provider: 'github' as const,
      externalEventId: github.externalEventId,
      externalEventDigest: github.externalEventDigest,
      requestDigest: github.requestDigest,
      responseDigest: digest(23),
      signatureVerified: true as const,
      signatureAlgorithm: 'github_hmac_sha256' as const,
      statusCode: 201 as const,
      outcome: 'created' as const,
      approvalId: github.approvalId,
      lineageId: github.lineageId,
      reasonCode: null,
    },
    {
      scenario: 'github_retry' as const,
      provider: 'github' as const,
      externalEventId: github.externalEventId,
      externalEventDigest: github.externalEventDigest,
      requestDigest: github.requestDigest,
      responseDigest: digest(24),
      signatureVerified: true as const,
      signatureAlgorithm: 'github_hmac_sha256' as const,
      statusCode: 200 as const,
      outcome: 'converged' as const,
      approvalId: github.approvalId,
      lineageId: github.lineageId,
      reasonCode: null,
    },
    {
      scenario: 'github_snapshot_mutation' as const,
      provider: 'github' as const,
      externalEventId: github.externalEventId,
      externalEventDigest: github.externalEventDigest,
      requestDigest: digest(8),
      responseDigest: digest(25),
      signatureVerified: true as const,
      signatureAlgorithm: 'github_hmac_sha256' as const,
      statusCode: 409 as const,
      outcome: 'rejected' as const,
      approvalId: null,
      lineageId: null,
      reasonCode: 'source_conflict' as const,
    },
  ].map((item, index) => ({
    ...item,
    startedAt: `2026-07-27T09:0${index + 2}:00.000Z`,
    completedAt: `2026-07-27T09:0${index + 2}:00.100Z`,
    latencyMs: 100,
  }));
  const reportBody = {
    schemaVersion: '1' as const,
    evidenceId: 'approval_lineage_round_112',
    service: 'delivery-loop-approval-lineage-observer' as const,
    generatedAt: '2026-07-27T09:09:00.000Z',
    requests: requestRows,
  };
  const report = ApprovalLineageObservabilityReportV1Schema.parse({
    ...reportBody,
    reportDigest: await canonicalSha256(reportBody),
  });
  const snapshot = {
    taskId: 'task_approval_lineage',
    taskRevision: 'revision-approval-lineage-1',
    taskDigest,
    runId: 'run_approval_lineage',
    runVersion: 7,
    planId: 'plan_approval_lineage',
    planVersion: 2,
    planDigest: digest(9),
    baseSha: 'a'.repeat(40),
    effect: 'merge' as const,
    decision: 'approve' as const,
  };
  const manifest = ApprovalLineageEvidenceManifestV1Schema.parse({
    schemaVersion: '1',
    evidenceId: report.evidenceId,
    recordedAt: '2026-07-27T10:00:00.000Z',
    controlPlaneOrigin: CONTROL_ORIGIN,
    observabilityReportUrl: OBSERVER_URL,
    observabilityReportDigest: report.reportDigest,
    repository: REPOSITORY,
    snapshot,
    identity: {
      principal,
      principalDigest,
      roles,
      rolesDigest,
      pullRequestAuthorPrincipal: 'user:delivery-author',
      pullRequestAuthorLogin: 'delivery-author',
      separationVerified: true,
    },
    feishu,
    github,
    isolation: {
      feishuDistinctEvent: {
        eventId: requestRows[2]!.externalEventId,
        eventDigest: requestRows[2]!.externalEventDigest,
        deliveryId: 'delivery_feishu_distinct',
        requestDigest: requestRows[2]!.requestDigest,
        expectedReason: 'replay_rejected',
      },
      githubSnapshotMutation: {
        requestDigest: requestRows[5]!.requestDigest,
        expectedReason: 'source_conflict',
      },
    },
    noEffect: { mergeOutboxes: 0, merges: 0 },
    safety: { canaryDigest: await canonicalSha256(CANARY) },
    review: {
      mappingEvidenceUrl: 'https://evidence.example/approval-lineage/mapping.json',
      feishuEventEvidenceUrl: 'https://evidence.example/approval-lineage/feishu-event.json',
      githubReviewUrl:
        `https://github.com/${REPOSITORY}/pull/${github.pullRequestNumber}` +
        `#pullrequestreview-${github.reviewId}`,
      case8ReportUrl: `${CONTROL_ORIGIN}/v1/runs/${snapshot.runId}/audit`,
      reviewer: 'release_owner',
      reviewedAt: '2026-07-27T09:30:00.000Z',
      sameHumanConfirmed: true,
    },
  });

  const identityRow = (
    provider: 'feishu' | 'github',
  ): Record<string, unknown> => {
    const source = provider === 'feishu' ? manifest.feishu : manifest.github;
    const tenant = provider === 'feishu' ? manifest.feishu.tenantKey : manifest.repository;
    const user = provider === 'feishu' ? OPEN_ID : manifest.github.reviewerLogin;
    return {
      sourceId: source.sourceId,
      provider,
      tenantKey: tenant,
      externalEventId: source.externalEventId,
      eventDigest: source.externalEventDigest,
      channel: `${provider}:${tenant}`,
      channelUserId: user,
      sourceOccurredAt: source.sourceOccurredAt,
      outcome: 'accepted',
      approvalId: source.approvalId,
      lineageId: source.lineageId,
      runId: snapshot.runId,
      taskRevision: snapshot.taskRevision,
      planId: snapshot.planId,
      planVersion: snapshot.planVersion,
      planDigest: snapshot.planDigest,
      baseSha: snapshot.baseSha,
      effect: 'merge',
      decision: 'approve',
      decisionRecordedAt: source.decisionRecordedAt,
      approverPrincipal: principal,
      approverChannel: `${provider}:${tenant}`,
      approverChannelUserId: user,
      authorPrincipal: manifest.identity.pullRequestAuthorPrincipal,
      authorChannel: `github:${manifest.repository}`,
      authorLogin: manifest.identity.pullRequestAuthorLogin,
      rolesDigest,
      separationVerified: true,
      expiresAt: source.expiresAt,
    };
  };
  const approvalRow = (
    provider: 'feishu' | 'github',
  ): Record<string, unknown> => {
    const source = provider === 'feishu' ? manifest.feishu : manifest.github;
    return {
      approvalId: source.approvalId,
      taskId: snapshot.taskId,
      taskRevision: snapshot.taskRevision,
      approver: principal,
      effect: 'merge',
      decision: 'approve',
      planId: snapshot.planId,
      planVersion: snapshot.planVersion,
      planDigest: snapshot.planDigest,
      baseSha: snapshot.baseSha,
      expiresAt: source.expiresAt,
      createdAt: source.decisionRecordedAt,
      rolesDigest,
      separationVerified: true,
      provider,
      lineageId: source.lineageId,
      sourceRecordId: source.sourceId,
      externalEventId: source.externalEventId,
      eventDigest: source.externalEventDigest,
      sourceOccurredAt: source.sourceOccurredAt,
      decisionRecordedAt: source.decisionRecordedAt,
      invalidated: false,
    };
  };
  const audit = {
    schemaVersion: '1',
    runId: snapshot.runId,
    run: {
      state: 'awaiting_review',
      version: snapshot.runVersion,
      baseSha: snapshot.baseSha,
      activePlanId: snapshot.planId,
      activePlanVersion: snapshot.planVersion,
      activePlanDigest: snapshot.planDigest,
    },
    task: {
      id: snapshot.taskId,
      revision: snapshot.taskRevision,
      digest: snapshot.taskDigest,
      repository: REPOSITORY,
      baseBranch: 'main',
      targetEnvironment: 'test',
    },
    answers: {
      checks: {
        identityApprovals: [identityRow('feishu'), identityRow('github')],
        effectOutboxes: [],
      },
      approvals: [approvalRow('feishu'), approvalRow('github')],
      changes: [],
      deployments: [],
    },
  };
  const feishuProjection = {
    schemaVersion: '1',
    tenantKey: manifest.feishu.tenantKey,
    eventId: manifest.feishu.externalEventId,
    counts: {
      deliveries: 1, ingressOutboxes: 0, actionReceipts: 1,
      actionOutcomes: 1, businessEffects: 1,
    },
    delivery: {
      deliveryId: manifest.feishu.deliveryId,
      appId: manifest.feishu.appId,
      eventType: 'card.action.trigger',
      eventCreatedAt: manifest.feishu.sourceOccurredAt,
      verificationMode: 'encrypted',
      requestDigest: manifest.feishu.requestDigest,
      eventDigest: manifest.feishu.externalEventDigest,
      receivedAt: manifest.feishu.decisionRecordedAt,
    },
    action: {
      actionReceiptId: manifest.feishu.actionReceiptId,
      deliveryId: manifest.feishu.deliveryId,
      eventCreatedAt: manifest.feishu.sourceOccurredAt,
      operatorDigest: manifest.feishu.operatorDigest,
      principalDigest: manifest.identity.principalDigest,
      rolesDigest: manifest.identity.rolesDigest,
      chatDigest: manifest.feishu.chatDigest,
      messageId: manifest.feishu.messageId,
      cardId: manifest.feishu.cardId,
      presentationId: manifest.feishu.presentationId,
      taskId: snapshot.taskId,
      runId: snapshot.runId,
      runVersion: snapshot.runVersion,
      taskRevisionDigest: snapshot.taskDigest,
      planId: snapshot.planId,
      planVersion: snapshot.planVersion,
      planDigest: snapshot.planDigest,
      baseSha: snapshot.baseSha,
      actionId: manifest.feishu.actionId,
      command: 'approve',
      effect: 'merge',
      contextMode: null,
      commandDigest: digest(10),
      receivedAt: manifest.feishu.decisionRecordedAt,
      createdAt: manifest.feishu.decisionRecordedAt,
      outcome: {
        outcomeId: manifest.feishu.outcomeId,
        disposition: 'applied',
        resultKind: 'approval',
        resultId: manifest.feishu.approvalId,
        reasonCode: null,
        completedAt: manifest.feishu.decisionRecordedAt,
      },
      businessEffect: {
        kind: 'approval',
        approvalId: manifest.feishu.approvalId,
        decision: 'approve',
        effect: 'merge',
        expiresAt: manifest.feishu.expiresAt,
        lineageId: manifest.feishu.lineageId,
        sourceOccurredAt: manifest.feishu.sourceOccurredAt,
        decisionRecordedAt: manifest.feishu.decisionRecordedAt,
        externalEventDigest: manifest.feishu.externalEventDigest,
        currentTrusted: true,
      },
    },
  };
  const isolationProjection = {
    schemaVersion: '1',
    tenantKey: manifest.feishu.tenantKey,
    eventId: manifest.isolation.feishuDistinctEvent.eventId,
    counts: {
      deliveries: 1, ingressOutboxes: 0, actionReceipts: 0,
      actionOutcomes: 0, businessEffects: 0,
    },
    delivery: {
      deliveryId: manifest.isolation.feishuDistinctEvent.deliveryId,
      appId: manifest.feishu.appId,
      eventType: 'card.action.trigger',
      eventCreatedAt: '2026-07-27T09:02:00.000Z',
      verificationMode: 'encrypted',
      requestDigest: manifest.isolation.feishuDistinctEvent.requestDigest,
      eventDigest: manifest.isolation.feishuDistinctEvent.eventDigest,
      receivedAt: '2026-07-27T09:02:00.100Z',
    },
    action: null,
  };
  const pullRequest = {
    state: 'open',
    user: { login: manifest.identity.pullRequestAuthorLogin },
    head: {
      ref: manifest.github.headBranch,
      sha: manifest.github.headSha,
      repo: { full_name: REPOSITORY },
    },
    base: { ref: manifest.github.baseBranch, repo: { full_name: REPOSITORY } },
  };
  const reviews = [{
    id: Number(manifest.github.reviewId),
    user: { login: manifest.github.reviewerLogin },
    state: 'APPROVED',
    commit_id: manifest.github.headSha,
    submitted_at: manifest.github.reviewSubmittedAt,
  }];
  return {
    manifest,
    report,
    audit,
    feishu: feishuProjection,
    isolation: isolationProjection,
    pullRequest,
    reviews,
  };
}

function fakeFetch(current: Fixture, requests: Array<{ url: string; authorization: string }>) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get('authorization') ?? '' });
    let body: unknown;
    if (url === OBSERVER_URL) body = current.report;
    else if (url === `${CONTROL_ORIGIN}/v1/runs/${current.manifest.snapshot.runId}/audit`) {
      body = current.audit;
    } else if (
      url.includes('/v1/operations/feishu-card-action/evidence') &&
      url.includes(encodeURIComponent(current.manifest.feishu.externalEventId))
    ) body = current.feishu;
    else if (
      url.includes('/v1/operations/feishu-card-action/evidence') &&
      url.includes(encodeURIComponent(current.manifest.isolation.feishuDistinctEvent.eventId))
    ) body = current.isolation;
    else if (url === `${GITHUB_ORIGIN}/repos/${REPOSITORY}/pulls/42`) body = current.pullRequest;
    else if (url === `${GITHUB_ORIGIN}/repos/${REPOSITORY}/pulls/42/reviews?per_page=100`) {
      body = current.reviews;
    } else return new Response(null, { status: 404 });
    return Response.json(body);
  };
}

async function verify(current: Fixture) {
  const requests: Array<{ url: string; authorization: string }> = [];
  const summary = await verifyApprovalLineageEvidence(current.manifest, {
    controlPlaneOrigin: CONTROL_ORIGIN,
    operationsToken: OPERATIONS_TOKEN,
    observabilityReportUrl: OBSERVER_URL,
    observabilityToken: OBSERVABILITY_TOKEN,
    githubToken: GITHUB_TOKEN,
    githubApiOrigin: GITHUB_ORIGIN,
    canary: CANARY,
    fetcher: fakeFetch(current, requests),
  });
  return { summary, requests };
}

describe('approval lineage external evidence', () => {
  it('accepts only a strict paired manifest, report, and checked-in example', async () => {
    const current = await fixture();
    expect(ApprovalLineageEvidenceManifestV1Schema.safeParse(current.manifest).success).toBe(true);
    expect(ApprovalLineageObservabilityReportV1Schema.safeParse(current.report).success).toBe(true);
    const example = JSON.parse(readFileSync(resolve(
      'schemas/approval-lineage-evidence-v1.example.json',
    ), 'utf8')) as unknown;
    const reportExample = JSON.parse(readFileSync(resolve(
      'schemas/approval-lineage-observability-v1.example.json',
    ), 'utf8')) as unknown;
    expect(ApprovalLineageEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(ApprovalLineageObservabilityReportV1Schema.safeParse(reportExample).success).toBe(true);
    expect(ApprovalLineageEvidenceManifestV1Schema.safeParse({
      ...current.manifest,
      rawEvent: 'untrusted',
    }).success).toBe(false);
    expect(ApprovalLineageEvidenceManifestV1Schema.safeParse({
      ...current.manifest,
      github: { ...current.manifest.github, lineageId: current.manifest.feishu.lineageId },
    }).success).toBe(false);
  });

  it('cross-checks signed retries, two immutable lineages, exact snapshot and live review', async () => {
    const current = await fixture();
    const { summary, requests } = await verify(current);
    expect(summary).toEqual({
      schemaVersion: '1',
      evidenceId: 'approval_lineage_round_112',
      repository: REPOSITORY,
      runId: 'run_approval_lineage',
      providerApprovals: 2,
      independentLineages: 2,
      sameHumanPrincipal: 'verified',
      exactSnapshotBinding: 'verified',
      replayConvergence: 'verified',
      eventAndSnapshotIsolation: 'verified',
      mergeEffects: 0,
      plaintextLeaks: 0,
      humanReview: 'required_and_recorded',
    });
    expect(requests).toHaveLength(6);
    expect(requests.filter((item) => item.url.startsWith(CONTROL_ORIGIN)))
      .toHaveLength(3);
    expect(requests.filter((item) => item.url.startsWith(GITHUB_ORIGIN)))
      .toHaveLength(2);
    expect(requests.every((item) => !item.url.includes(CANARY))).toBe(true);
    expect(requests.map((item) => item.authorization)).toEqual([
      `Bearer ${OBSERVABILITY_TOKEN}`,
      `Bearer ${OPERATIONS_TOKEN}`,
      `Bearer ${OPERATIONS_TOKEN}`,
      `Bearer ${OPERATIONS_TOKEN}`,
      `Bearer ${GITHUB_TOKEN}`,
      `Bearer ${GITHUB_TOKEN}`,
    ]);
  });

  it('fails closed when a provider lineage, isolation fact, or GitHub review drifts', async () => {
    const identity = await fixture();
    identity.manifest.identity.rolesDigest = digest(30);
    await expect(verify(identity)).rejects.toMatchObject({
      code: 'cross_provider_binding_mismatch',
    });

    const swapped = await fixture();
    const audit = swapped.audit.answers as Record<string, unknown>;
    const approvals = audit.approvals as Array<Record<string, unknown>>;
    approvals[1]!.lineageId = swapped.manifest.feishu.lineageId;
    await expect(verify(swapped)).rejects.toMatchObject({
      code: 'cross_provider_binding_mismatch',
    });

    const isolated = await fixture();
    isolated.isolation.action = { businessEffect: { kind: 'approval' } };
    await expect(verify(isolated)).rejects.toMatchObject({
      code: 'isolation_mismatch',
    });

    const review = await fixture();
    review.reviews[0]!.commit_id = 'c'.repeat(40);
    await expect(verify(review)).rejects.toMatchObject({
      code: 'github_fact_mismatch',
    });
  });

  it('rejects a forged observability digest and plaintext canary', async () => {
    const forged = await fixture();
    forged.report = { ...forged.report, generatedAt: '2026-07-27T09:09:01.000Z' };
    await expect(verify(forged)).rejects.toMatchObject({
      code: 'observability_digest_mismatch',
    });

    const leaked = await fixture();
    leaked.audit.leak = CANARY;
    await expect(verify(leaked)).rejects.toMatchObject({
      code: 'secret_leak_detected',
    });
  });

  it('keeps the real verifier explicit opt-in with prerequisite exit 2', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/verify-approval-lineage-evidence.ts'],
      {
        cwd: resolve('.'),
        env: { ...process.env, DELIVERY_LOOP_APPROVAL_LINEAGE_E2E: '' },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('approval-lineage-e2e: opt-in missing');
    expect(result.stderr).not.toContain(CANARY);
    const incomplete = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/verify-approval-lineage-evidence.ts'],
      {
        cwd: resolve('.'),
        env: { ...process.env, DELIVERY_LOOP_APPROVAL_LINEAGE_E2E: '1' },
        encoding: 'utf8',
      },
    );
    expect(incomplete.status).toBe(2);
    expect(incomplete.stderr).toContain(
      'approval-lineage-e2e: required evidence configuration is incomplete',
    );
  });
});
