import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ControlledReplayEvidenceManifestV1 } from
  '../src/domain/controlled-replay-evidence.js';
import { canonicalSha256 } from '../src/domain/digest.js';
import type { FeishuIngressEvidenceManifestV1 } from
  '../src/domain/feishu-ingress-evidence.js';
import type { FeishuRetryEvidenceManifestV1 } from
  '../src/domain/feishu-retry-evidence.js';
import type { GitHubPullRequestEvidenceManifestV1 } from
  '../src/domain/github-pull-request-evidence.js';
import {
  ReplayFailureE2EEvidenceManifestV1Schema,
  ReplayFailureObservabilityReportV1Schema,
  type ReplayFailureE2EEvidenceManifestV1,
  type ReplayFailureObservabilityReportV1,
} from '../src/domain/replay-failure-e2e-evidence.js';
import {
  verifyReplayFailureE2EEvidence,
} from '../src/pilot/replay-failure-e2e-evidence-verifier.js';

const CONTROL_ORIGIN = 'https://control.example.com';
const GITHUB_ORIGIN = 'https://api.github.test';
const FEISHU_ORIGIN = 'https://open.feishu.test';
const CLOUDFLARE_ORIGIN = 'https://api.cloudflare.test/client/v4';
const TOP_REPORT_URL = 'https://observability.example.com/replay-failure/live';
const ACCOUNT_ID = 'a'.repeat(32);
const CANARY = `github_pat_${'z'.repeat(30)}`;
const CARD = {
  config: { wide_screen_mode: true, update_multi: true },
  elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**状态**\n已恢复' } }],
};

interface Fixture {
  manifest: ReplayFailureE2EEvidenceManifestV1;
  report: ReplayFailureObservabilityReportV1;
  ingress: FeishuIngressEvidenceManifestV1;
  ingressReport: Record<string, unknown>;
  retry: FeishuRetryEvidenceManifestV1;
  github: GitHubPullRequestEvidenceManifestV1;
  controlled: ControlledReplayEvidenceManifestV1;
}

function example<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../schemas/${name}`, import.meta.url), 'utf8')) as T;
}

function controlledReconciliations(manifest: ControlledReplayEvidenceManifestV1) {
  const deployment = manifest.deployments[0]!;
  return [
    {
      sourceKind: 'evidence', sourceRef: `d1://evidence/${deployment.evidenceId}`,
      sourceDigest: `sha256:${'4'.repeat(64)}`, evidenceId: deployment.evidenceId,
      evidenceKind: 'deployment', status: 'passed', verificationStatus: 'verified',
      sha: deployment.sha,
    },
    {
      sourceKind: 'evidence', sourceRef: `d1://evidence/${manifest.pullRequest.evidenceId}`,
      sourceDigest: `sha256:${'3'.repeat(64)}`, evidenceId: manifest.pullRequest.evidenceId,
      evidenceKind: 'pull_request', status: 'passed', verificationStatus: 'verified',
      sha: manifest.pullRequest.headSha,
    },
    {
      sourceKind: 'outbox', sourceRef: `d1://outbox/${manifest.replay.dispatchOutboxIds[0]}`,
      sourceDigest: `sha256:${'2'.repeat(64)}`,
      outboxId: manifest.replay.dispatchOutboxIds[0], outboxKind: 'execution_dispatch',
      deliveryState: 'settled',
    },
  ];
}

async function fixture(): Promise<Fixture> {
  const ingress = example<FeishuIngressEvidenceManifestV1>(
    'feishu-ingress-evidence-v1.example.json',
  );
  const ingressReport = example<Record<string, unknown>>(
    'feishu-ingress-observability-v1.example.json',
  );
  const retryExample = example<FeishuRetryEvidenceManifestV1>(
    'feishu-retry-evidence-v1.example.json',
  );
  const retry: FeishuRetryEvidenceManifestV1 = {
    ...retryExample,
    runId: ingress.task.runId,
    card: {
      ...retryExample.card,
      tenantKey: ingress.tenantKey,
      finalRenderedDigest: await canonicalSha256(CARD),
    },
  };
  const githubExample = example<GitHubPullRequestEvidenceManifestV1>(
    'github-pull-request-evidence-v1.example.json',
  );
  const githubBody = '# replay evidence\n';
  const github: GitHubPullRequestEvidenceManifestV1 = {
    ...githubExample,
    publication: {
      ...githubExample.publication,
      bodyDigest: await canonicalSha256(githubBody),
    },
  };
  const controlledExample = example<ControlledReplayEvidenceManifestV1>(
    'controlled-replay-evidence-v1.example.json',
  );
  let controlled: ControlledReplayEvidenceManifestV1 = {
    ...controlledExample,
    replay: {
      ...controlledExample.replay,
      dispatchOutboxIds: ['outbox-execution-dispatch-example'],
    },
  };
  const reconciliations = controlledReconciliations(controlled);
  controlled = {
    ...controlled,
    replay: {
      ...controlled.replay,
      effectSnapshotDigest: await canonicalSha256({
        target: {
          name: `plan-v${controlled.planVersion}-item-${controlled.replay.planItemId}-verify`,
          type: 'do',
          count: 1,
        },
        effects: controlled.replay.effects,
        reconciliations: reconciliations.map((source) => ({
          sourceKind: source.sourceKind,
          sourceRef: source.sourceRef,
          sourceDigest: source.sourceDigest,
        })),
      }),
    },
  };
  const reportBody = {
    schemaVersion: '1' as const,
    evidenceId: 'replay-failure-e2e-live',
    service: 'delivery-loop-control-plane' as const,
    generatedAt: '2026-07-26T16:00:00.000Z',
    githubRequests: [
      ['github-request-1', '2026-07-26T14:40:01.000Z', 'applied'],
      ['github-request-2', '2026-07-26T14:40:02.000Z', 'duplicate'],
      ['github-request-3', '2026-07-26T14:40:03.000Z', 'duplicate'],
    ].map(([requestId, startedAt, disposition]) => ({
      requestId: requestId!, startedAt: startedAt!,
      completedAt: new Date(Date.parse(startedAt!) + 100).toISOString(), latencyMs: 100,
      deliveryId: github.publication.webhook.deliveryId,
      eventType: 'pull_request' as const, action: 'opened' as const,
      payloadDigest: github.publication.webhook.payloadDigest, statusCode: 202 as const,
      disposition: disposition as 'applied' | 'duplicate',
    })),
    queueReplayRequests: [
      ['queue-request-1', '2026-07-26T11:10:00.000Z', true],
      ['queue-request-2', '2026-07-26T11:10:01.000Z', false],
      ['queue-request-3', '2026-07-26T11:10:02.000Z', false],
    ].map(([requestId, startedAt, created]) => ({
      requestId: String(requestId), startedAt: String(startedAt),
      completedAt: new Date(Date.parse(String(startedAt)) + 100).toISOString(), latencyMs: 100,
      deadLetterId: 'outbox-dlq-controlled-example',
      outboxId: controlled.replay.dispatchOutboxIds[0]!,
      replayId: 'outbox-dlq-replay-outbox-dlq-controlled-example',
      expectedOutboxAttemptCount: 3, reasonCode: 'upstream_recovered' as const,
      statusCode: 202 as const, created: Boolean(created),
    })),
  };
  const report = ReplayFailureObservabilityReportV1Schema.parse({
    ...reportBody,
    reportDigest: await canonicalSha256(reportBody),
  });
  const manifest = ReplayFailureE2EEvidenceManifestV1Schema.parse({
    schemaVersion: '1',
    evidenceId: report.evidenceId,
    repository: controlled.repository,
    recordedAt: '2026-07-27T11:20:00.000Z',
    observedWindow: {
      startedAt: '2026-07-26T10:00:00.000Z',
      endedAt: '2026-07-27T11:10:00.000Z',
    },
    components: {
      feishuIngress: {
        manifestDigest: await canonicalSha256(ingress),
        evidenceId: ingress.evidenceId,
        runId: ingress.task.runId,
      },
      feishuRetry: {
        manifestDigest: await canonicalSha256(retry),
        evidenceId: retry.evidenceId,
        runId: retry.runId,
      },
      githubPullRequest: {
        manifestDigest: await canonicalSha256(github),
        evidenceId: github.evidenceId,
        runId: github.runId,
        publicationId: github.publication.publicationId,
        deliveryId: github.publication.webhook.deliveryId,
      },
      controlledReplay: {
        manifestDigest: await canonicalSha256(controlled),
        evidenceId: controlled.evidenceId,
        runId: controlled.runId,
      },
    },
    observability: { reportUrl: TOP_REPORT_URL, reportDigest: report.reportDigest },
    callbackRecovery: {
      runId: controlled.runId,
      publicationId: controlled.pullRequest.publicationId,
      apiObservationId: 'controlled-pr-api-observation',
      factDigest: `sha256:${'7'.repeat(64)}`,
      externalUpdatedAt: '2026-07-26T10:30:00.000Z',
      observedAt: '2026-07-26T10:31:00.000Z',
      processedAt: '2026-07-26T10:31:01.000Z',
      webhookObservationCount: 0,
      apiObservationCount: 1,
    },
    queueReplay: {
      runId: controlled.runId,
      deadLetterId: 'outbox-dlq-controlled-example',
      outboxId: controlled.replay.dispatchOutboxIds[0],
      replayId: 'outbox-dlq-replay-outbox-dlq-controlled-example',
      sourceQueue: 'delivery-loop-workflow-outbox',
      sourceAttempts: 4,
      outboxKind: 'execution_dispatch',
      destination: 'github_actions',
      expectedOutboxAttemptCount: 3,
      reasonCode: 'upstream_recovered',
      capturedAt: '2026-07-26T11:09:00.000Z',
      replayRequestedAt: '2026-07-26T11:10:00.000Z',
      resolvedAt: '2026-07-26T11:11:00.000Z',
      resolutionCode: 'outbox_settled',
    },
    safety: { canaryDigest: await canonicalSha256(CANARY) },
  });
  return { manifest, report, ingress, ingressReport, retry, github, controlled };
}

function ingressProjection(
  manifest: FeishuIngressEvidenceManifestV1,
  role: 'replayed' | 'sameRevisionPeer',
) {
  const event = manifest.events[role];
  const requestTimes = role === 'replayed'
    ? ['2026-07-27T11:01:00.000Z', '2026-07-27T11:02:00.000Z', '2026-07-27T11:03:00.000Z']
    : ['2026-07-27T11:04:00.000Z'];
  return {
    schemaVersion: '1', tenantKey: manifest.tenantKey, eventId: event.eventId,
    counts: {
      deliveries: 1, transportReceipts: event.requestDigests.length, ingressOutboxes: 1,
      queueMessageIdentities: 1, queueObservations: event.queueObservationCount,
      tasks: 1, runs: 1, workflowCreateOutboxes: 1,
    },
    delivery: {
      deliveryId: event.deliveryId, eventType: manifest.eventType,
      eventDigest: event.eventDigest, verificationMode: 'encrypted', receivedAt: requestTimes[0],
    },
    transportReceipts: event.requestDigests.map((requestDigest, index) => ({
      requestTimestamp: requestTimes[index], requestDigest,
      receivedAt: new Date(Date.parse(requestTimes[index]!) + 100).toISOString(),
    })),
    ingress: {
      outboxId: event.ingressOutboxId, deliveryId: event.deliveryId,
      eventType: manifest.eventType, eventDigest: event.eventDigest, deliveryState: 'settled',
      relayAttemptCount: event.relayAttemptCount, enqueuedAt: event.enqueuedAt,
      queueObservedAt: event.queueObservedAt, taskId: manifest.task.taskId,
      runId: manifest.task.runId, taskDigest: manifest.task.taskDigest, settledAt: event.settledAt,
    },
    queueObservations: Array.from({ length: event.queueObservationCount }, (_, index) => ({
      queueName: manifest.cloudflare.queueName,
      queueMessageIdDigest: event.queueMessageIdDigest,
      deliveryAttempt: index + 1,
      messageTimestamp: event.enqueuedAt,
      observedAt: new Date(Date.parse(event.queueObservedAt) + index).toISOString(),
    })),
    task: {
      sourceSystem: manifest.task.sourceSystem, tenantKey: manifest.tenantKey,
      sourceTaskKey: manifest.task.sourceTaskKey, taskRevision: manifest.task.taskRevision,
      taskDigest: manifest.task.taskDigest, taskId: manifest.task.taskId, runId: manifest.task.runId,
      workflowInstanceId: manifest.task.workflowInstanceId, runState: 'queued',
      workflowCreateOutboxId: manifest.task.workflowCreateOutboxId,
      workflowCreateState: 'settled',
    },
  };
}

function retryOperations(manifest: FeishuRetryEvidenceManifestV1) {
  return {
    schemaVersion: '1',
    card: {
      runId: manifest.runId,
      latest: {
        presentationId: manifest.refresh.nextPresentationId,
        revision: manifest.refresh.nextRevision, digest: manifest.refresh.nextDigest,
        renderedDigest: manifest.card.finalRenderedDigest, outboxId: manifest.refresh.nextOutboxId,
        deliveryState: 'settled', attemptCount: 1, lastErrorCode: null,
      },
      delivered: {
        presentationId: manifest.refresh.nextPresentationId,
        revision: manifest.refresh.nextRevision, digest: manifest.refresh.nextDigest,
        messageId: manifest.refresh.finalMessageId,
      },
      retryHistory: manifest.first.retryHistory.map((retry) => ({
        outboxId: manifest.first.outboxId, presentationId: manifest.first.presentationId, ...retry,
      })),
      refresh: {
        requestId: manifest.refresh.requestId,
        expectedPresentationId: manifest.refresh.expectedPresentationId,
        expectedRevision: manifest.refresh.expectedRevision,
        expectedDigest: manifest.refresh.expectedDigest,
        nextPresentationId: manifest.refresh.nextPresentationId,
        nextRevision: manifest.refresh.nextRevision, nextDigest: manifest.refresh.nextDigest,
        nextOutboxId: manifest.refresh.nextOutboxId, nextDeliveryState: 'settled',
      },
    },
  };
}

function retryMessage(manifest: FeishuRetryEvidenceManifestV1) {
  return {
    code: 0,
    data: { items: [{
      message_id: manifest.refresh.finalMessageId, msg_type: 'interactive',
      chat_id: manifest.card.chatId, deleted: false,
      create_time: String(Date.parse(manifest.card.finalCreatedAt)),
      update_time: String(Date.parse(manifest.card.finalUpdatedAt)),
      sender: { sender_type: 'app', id: manifest.card.appId, tenant_key: manifest.card.tenantKey },
      body: { content: JSON.stringify(CARD) },
    }] },
  };
}

function githubAudit(manifest: GitHubPullRequestEvidenceManifestV1) {
  const publication = manifest.publication;
  return {
    schemaVersion: '1', runId: manifest.runId,
    run: { state: 'pull_request_open' }, task: { repository: manifest.repository },
    answers: {
      changes: [{ kind: 'pull_request', ...publication }],
      checks: { pullRequestObservations: [
        {
          sourceKind: 'webhook', sourceId: publication.webhook.deliveryId,
          publicationId: publication.publicationId, factDigest: publication.webhook.payloadDigest,
          processingState: 'applied', externalUpdatedAt: publication.webhook.externalUpdatedAt,
          observedAt: publication.webhook.receivedAt,
        },
        {
          sourceKind: 'api', sourceId: publication.apiObservation.observationId,
          publicationId: publication.publicationId,
          factDigest: publication.apiObservation.factDigest, processingState: 'applied',
          externalUpdatedAt: publication.apiObservation.externalUpdatedAt,
          observedAt: publication.apiObservation.observedAt,
        },
      ] },
    },
  };
}

function githubPull(manifest: GitHubPullRequestEvidenceManifestV1) {
  return {
    number: manifest.publication.number, state: 'open', draft: true,
    html_url: manifest.publication.url, body: '# replay evidence\n',
    head: {
      ref: manifest.publication.headBranch, sha: manifest.publication.headSha,
      repo: { full_name: manifest.repository },
    },
    base: {
      ref: manifest.publication.baseBranch, repo: { full_name: manifest.repository },
    },
  };
}

function controlledAudit(
  evidence: Fixture,
  options: { callbackWebhook?: boolean } = {},
) {
  const manifest = evidence.controlled;
  const deployment = manifest.deployments[0]!;
  const reconciliations = controlledReconciliations(manifest);
  const callback = evidence.manifest.callbackRecovery;
  return {
    schemaVersion: '1', runId: manifest.runId,
    run: { state: 'succeeded', version: manifest.postReplayRunVersion, baseSha: 'c'.repeat(40) },
    task: { repository: manifest.repository },
    answers: {
      approvals: manifest.replay.effects.map((effect) => ({
        approvalId: effect.approvalId, effect: effect.effect, decision: 'approve',
        planId: manifest.planId, planVersion: manifest.planVersion, baseSha: 'c'.repeat(40),
        expiresAt: '2026-07-27T11:06:00.000Z', invalidated: false,
        separationVerified: true,
      })),
      changes: [{
        kind: 'pull_request', publicationId: manifest.pullRequest.publicationId,
        repository: manifest.repository, headBranch: manifest.pullRequest.headBranch,
        headSha: manifest.pullRequest.headSha, status: 'verified',
        number: manifest.pullRequest.number, evidenceId: manifest.pullRequest.evidenceId,
      }],
      deployments: [{
        kind: deployment.kind, deploymentId: deployment.deploymentId,
        repository: manifest.repository, environment: deployment.environment,
        status: 'succeeded', sha: deployment.sha,
        githubDeploymentId: deployment.githubDeploymentId, evidenceId: deployment.evidenceId,
      }],
      checks: {
        replays: [{
          replayId: manifest.replay.replayId,
          expectedRunVersion: manifest.replay.expectedRunVersion,
          planId: manifest.planId, planVersion: manifest.planVersion,
          itemId: manifest.replay.planItemId,
          target: {
            kind: 'plan_item',
            name: `plan-v${manifest.planVersion}-item-${manifest.replay.planItemId}-verify`,
            type: 'do', count: 1,
          },
          reasonDigest: `sha256:${'5'.repeat(64)}`,
          effectSnapshotDigest: manifest.replay.effectSnapshotDigest,
          createdAt: manifest.replay.createdAt, updatedAt: manifest.replay.restartObservedAt,
          restartObservedAt: manifest.replay.restartObservedAt,
          outbox: { id: manifest.replay.outboxId, state: 'settled', attemptCount: 1 },
          effects: manifest.replay.effects, reconciliations,
        }],
        effectOutboxes: [{
          id: manifest.replay.dispatchOutboxIds[0], kind: 'execution_dispatch',
          state: 'settled', createdAt: '2026-07-26T10:20:00.000Z',
        }],
        pullRequestObservations: [
          {
            sourceKind: 'api', sourceId: callback.apiObservationId,
            publicationId: callback.publicationId, repository: manifest.repository,
            githubPrNumber: manifest.pullRequest.number, factDigest: callback.factDigest,
            processingState: 'applied', ignoreReason: null,
            externalUpdatedAt: callback.externalUpdatedAt, observedAt: callback.observedAt,
            processedAt: callback.processedAt,
          },
          ...(options.callbackWebhook === true ? [{
            sourceKind: 'webhook', sourceId: 'unexpected-controlled-webhook',
            publicationId: callback.publicationId,
          }] : []),
        ],
      },
    },
  };
}

function controlledCorrelation(manifest: ControlledReplayEvidenceManifestV1) {
  const action = manifest.agentActions[0]!;
  const deployment = manifest.deployments[0]!;
  return {
    correlationId: manifest.runId,
    run: { id: manifest.runId, state: 'succeeded', version: manifest.postReplayRunVersion },
    attempts: [{
      id: action.attemptId, status: 'completed', githubRunId: action.actionRunId,
      githubStatus: 'completed', githubConclusion: 'success',
    }],
    githubRuns: [{
      kind: 'agent', id: action.actionRunId, attemptId: action.attemptId,
      status: 'completed', conclusion: 'success',
    }],
    pullRequests: [{
      publicationId: manifest.pullRequest.publicationId, status: 'verified',
      number: manifest.pullRequest.number, evidenceId: manifest.pullRequest.evidenceId,
    }],
    deployments: [{
      kind: deployment.kind, id: deployment.deploymentId, status: 'succeeded',
      sha: deployment.sha, githubDeploymentId: deployment.githubDeploymentId,
      evidenceId: deployment.evidenceId,
    }],
    truncated: { attempts: false, githubRuns: false, pullRequests: false, deployments: false },
  };
}

function controlledAction(manifest: ControlledReplayEvidenceManifestV1) {
  const action = manifest.agentActions[0]!;
  return {
    id: Number(action.actionRunId), status: 'completed', conclusion: 'success',
    head_sha: action.workflowHeadSha, repository: { full_name: manifest.repository },
    event: 'workflow_dispatch', path: '.github/workflows/delivery-agent.yml',
    display_title: `delivery-loop/${action.attemptId}`, created_at: '2026-07-26T10:15:00.000Z',
  };
}

function controlledPull(manifest: ControlledReplayEvidenceManifestV1) {
  return {
    number: manifest.pullRequest.number, created_at: '2026-07-26T10:30:00.000Z',
    head: {
      ref: manifest.pullRequest.headBranch, sha: manifest.pullRequest.headSha,
      repo: { full_name: manifest.repository },
    },
    base: { ref: 'main', repo: { full_name: manifest.repository } },
  };
}

function controlledDeployment(manifest: ControlledReplayEvidenceManifestV1) {
  const deployment = manifest.deployments[0]!;
  return {
    id: Number(deployment.githubDeploymentId), sha: deployment.sha,
    task: `delivery-loop:${deployment.kind}`, environment: deployment.environment,
    created_at: '2026-07-26T10:45:00.000Z',
    payload: { delivery_deployment_id: deployment.deploymentId },
  };
}

function resolvedDeadLetters(evidence: Fixture, drift = false) {
  const expected = evidence.manifest.queueReplay;
  return {
    schemaVersion: '1',
    deadLetters: [{
      id: expected.deadLetterId, outboxId: drift ? 'outbox-other' : expected.outboxId,
      runId: expected.runId, sourceQueue: expected.sourceQueue,
      sourceMessageId: 'queue-source-message', sourceAttempts: expected.sourceAttempts,
      outboxKind: expected.outboxKind, destination: expected.destination,
      outboxAttemptCount: expected.expectedOutboxAttemptCount, status: 'resolved',
      capturedAt: expected.capturedAt, replayRequestedAt: expected.replayRequestedAt,
      resolvedAt: expected.resolvedAt, resolutionCode: expected.resolutionCode,
    }],
  };
}

function fakeFetch(
  evidence: Fixture,
  options: {
    callbackWebhook?: boolean;
    queueDrift?: boolean;
    duplicateGitHubPull?: boolean;
    responseCanary?: boolean;
  } = {},
): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.toString() === TOP_REPORT_URL) {
      return Response.json(options.responseCanary === true ? { raw: CANARY } : evidence.report);
    }
    if (url.toString() === evidence.ingress.observabilityReportUrl) {
      return Response.json(evidence.ingressReport);
    }
    if (url.origin === CONTROL_ORIGIN) {
      if (url.pathname === '/v1/dead-letters') {
        return Response.json(resolvedDeadLetters(evidence, options.queueDrift === true));
      }
      if (url.pathname === '/v1/operations/feishu-ingress/evidence') {
        const role = url.searchParams.get('eventId') === evidence.ingress.events.replayed.eventId
          ? 'replayed' : 'sameRevisionPeer';
        return Response.json(ingressProjection(evidence.ingress, role));
      }
      if (url.pathname === `/v1/runs/${evidence.retry.runId}/feishu-card`) {
        return Response.json(retryOperations(evidence.retry));
      }
      if (url.pathname === `/v1/runs/${evidence.github.runId}/audit`) {
        return Response.json(githubAudit(evidence.github));
      }
      if (url.pathname === `/v1/runs/${evidence.controlled.runId}/audit`) {
        return Response.json(controlledAudit(
          evidence,
          options.callbackWebhook === true ? { callbackWebhook: true } : {},
        ));
      }
      if (url.pathname === '/v1/correlations') {
        return Response.json(controlledCorrelation(evidence.controlled));
      }
    }
    if (url.origin === 'https://api.cloudflare.test') {
      return Response.json({
        success: true, errors: [], messages: [],
        result: {
          status: evidence.ingress.cloudflare.workflowInstanceStatus,
          versionId: evidence.ingress.cloudflare.workflowInstanceVersionId,
          start: evidence.ingress.cloudflare.workflowInstanceStartedAt,
        },
      });
    }
    if (url.origin === FEISHU_ORIGIN) return Response.json(retryMessage(evidence.retry));
    if (url.origin === GITHUB_ORIGIN) {
      const github = evidence.github;
      const controlled = evidence.controlled;
      if (url.pathname === `/repos/${github.repository}/pulls/${github.publication.number}`) {
        return Response.json(githubPull(github));
      }
      if (
        url.pathname === `/repos/${github.repository}/pulls` &&
        url.searchParams.get('head')?.endsWith(github.publication.headBranch) === true
      ) {
        const pulls = [githubPull(github)];
        if (options.duplicateGitHubPull === true) pulls.push({ ...githubPull(github), number: 43 });
        return Response.json(pulls);
      }
      if (url.pathname.endsWith('/actions/workflows/delivery-agent.yml/runs')) {
        return Response.json({ total_count: 1, workflow_runs: [controlledAction(controlled)] });
      }
      if (url.pathname === `/repos/${controlled.repository}/actions/runs/` +
        controlled.agentActions[0]!.actionRunId) {
        return Response.json(controlledAction(controlled));
      }
      if (url.pathname === `/repos/${controlled.repository}/pulls/${controlled.pullRequest.number}`) {
        return Response.json(controlledPull(controlled));
      }
      if (url.pathname === `/repos/${controlled.repository}/pulls`) {
        return Response.json([controlledPull(controlled)]);
      }
      if (url.pathname === `/repos/${controlled.repository}/deployments`) {
        return Response.json([controlledDeployment(controlled)]);
      }
      if (url.pathname.endsWith(`/deployments/${controlled.deployments[0]!.githubDeploymentId}/statuses`)) {
        return Response.json([{ state: 'success' }]);
      }
    }
    return Response.json({ message: 'not found' }, { status: 404 });
  }) as typeof fetch;
}

function options(evidence: Fixture, fetcher: typeof fetch) {
  return {
    controlPlaneOrigin: CONTROL_ORIGIN,
    operationsToken: 'operations-read-value',
    queryToken: 'query-read-value',
    githubToken: 'github-read-value',
    feishuAccessToken: 'feishu-read-value',
    feishuIngressObservabilityReportUrl: evidence.ingress.observabilityReportUrl,
    feishuIngressObservabilityToken: 'ingress-report-read-value',
    replayObservabilityReportUrl: TOP_REPORT_URL,
    replayObservabilityToken: 'replay-report-read-value',
    cloudflareAccountId: ACCOUNT_ID,
    cloudflareToken: 'cloudflare-read-value',
    canary: CANARY,
    githubApiOrigin: GITHUB_ORIGIN,
    feishuApiOrigin: FEISHU_ORIGIN,
    cloudflareApiOrigin: CLOUDFLARE_ORIGIN,
    fetch: fetcher,
  };
}

describe('replay and failure E2E evidence', () => {
  it('keeps the aggregate manifest and transport report strict', async () => {
    const evidence = await fixture();
    expect(ReplayFailureE2EEvidenceManifestV1Schema.safeParse(evidence.manifest).success).toBe(true);
    expect(ReplayFailureObservabilityReportV1Schema.safeParse(evidence.report).success).toBe(true);
    expect(ReplayFailureE2EEvidenceManifestV1Schema.safeParse({
      ...evidence.manifest,
      rawWebhook: 'unsafe',
    }).success).toBe(false);
    expect(ReplayFailureObservabilityReportV1Schema.safeParse({
      ...evidence.report,
      githubRequests: evidence.report.githubRequests.map((request) => ({
        ...request, disposition: 'duplicate',
      })),
    }).success).toBe(false);
    const manifestExample = example<unknown>('replay-failure-e2e-evidence-v1.example.json');
    const reportExample = ReplayFailureObservabilityReportV1Schema.parse(
      example<unknown>('replay-failure-observability-v1.example.json'),
    );
    expect(ReplayFailureE2EEvidenceManifestV1Schema.safeParse(manifestExample).success).toBe(true);
    const { reportDigest, ...body } = reportExample;
    expect(await canonicalSha256(body)).toBe(reportDigest);
  });

  it('runs all component authorities and proves replay/failure convergence', async () => {
    const evidence = await fixture();
    const summary = await verifyReplayFailureE2EEvidence(
      evidence.manifest,
      {
        feishuIngress: evidence.ingress, feishuRetry: evidence.retry,
        githubPullRequest: evidence.github, controlledReplay: evidence.controlled,
      },
      options(evidence, fakeFetch(evidence)),
    );
    expect(summary).toEqual({
      schemaVersion: '1', evidenceId: evidence.manifest.evidenceId,
      repository: evidence.manifest.repository, verifiedComponentCount: 4,
      distinctRunCount: 3, feishuReplayCount: 3, githubReplayCount: 3,
      queueReplayCount: 3, recoveredCallbackCount: 1, rateLimitRecovery: 'verified',
      finalRunState: 'succeeded', duplicateTasks: 0, duplicateRuns: 0,
      duplicateDispatches: 0, duplicatePullRequests: 0, duplicateDeployments: 0,
      plaintextLeaks: 0,
    });
  });

  it('fails closed on a delivered callback, DLQ drift, or duplicate PR inventory', async () => {
    const evidence = await fixture();
    const components = {
      feishuIngress: evidence.ingress, feishuRetry: evidence.retry,
      githubPullRequest: evidence.github, controlledReplay: evidence.controlled,
    };
    await expect(verifyReplayFailureE2EEvidence(
      evidence.manifest, components, options(evidence, fakeFetch(evidence, {
        callbackWebhook: true,
      })),
    )).rejects.toMatchObject({ code: 'callback_recovery_mismatch' });
    await expect(verifyReplayFailureE2EEvidence(
      evidence.manifest, components, options(evidence, fakeFetch(evidence, { queueDrift: true })),
    )).rejects.toMatchObject({ code: 'queue_replay_mismatch' });
    await expect(verifyReplayFailureE2EEvidence(
      evidence.manifest,
      components,
      options(evidence, fakeFetch(evidence, { duplicateGitHubPull: true })),
    )).rejects.toMatchObject({ code: 'duplicate_pull_request' });
  });

  it('rejects component digest drift and scans every external response before parsing', async () => {
    const evidence = await fixture();
    await expect(verifyReplayFailureE2EEvidence(
      {
        ...evidence.manifest,
        components: {
          ...evidence.manifest.components,
          feishuRetry: {
            ...evidence.manifest.components.feishuRetry,
            manifestDigest: `sha256:${'9'.repeat(64)}`,
          },
        },
      },
      {
        feishuIngress: evidence.ingress, feishuRetry: evidence.retry,
        githubPullRequest: evidence.github, controlledReplay: evidence.controlled,
      },
      options(evidence, fakeFetch(evidence)),
    )).rejects.toMatchObject({ code: 'component_digest_mismatch' });
    const failure = await verifyReplayFailureE2EEvidence(
      evidence.manifest,
      {
        feishuIngress: evidence.ingress, feishuRetry: evidence.retry,
        githubPullRequest: evidence.github, controlledReplay: evidence.controlled,
      },
      options(evidence, fakeFetch(evidence, { responseCanary: true })),
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'secret_leak_detected' });
    expect(String(failure)).not.toContain(CANARY);
  });

  it('keeps the CLI opt-in and prerequisite exits distinct from fact failure', () => {
    const missing = spawnSync('pnpm', ['run', 'e2e:replay-failure'], {
      cwd: resolve('.'),
      env: { ...process.env, DELIVERY_LOOP_REPLAY_FAILURE_E2E: undefined },
      encoding: 'utf8', timeout: 30_000,
    });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('replay-failure-e2e: opt-in missing');
    const incomplete = spawnSync('pnpm', ['run', 'e2e:replay-failure'], {
      cwd: resolve('.'),
      env: { ...process.env, DELIVERY_LOOP_REPLAY_FAILURE_E2E: '1' },
      encoding: 'utf8', timeout: 30_000,
    });
    expect(incomplete.status).toBe(2);
    expect(incomplete.stderr).toContain('required external configuration is incomplete');
  });
});
