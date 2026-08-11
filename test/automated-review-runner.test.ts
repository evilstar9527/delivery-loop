import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AutomatedReviewContextV1Schema,
  automatedReviewContextDigest,
} from '../src/domain/automated-review.js';
import { TRIAGE_TOOL_ACTIONS } from '../src/domain/tool-bridge.js';
import { CodexReviewAdapterError } from '../src/agent/codex-review-adapter.js';
import { canonicalSha256 } from '../src/domain/digest.js';
import { runAnalysisAttempt } from '../src/runner/analysis-runner.js';
import type { AnalysisRunnerError } from '../src/runner/analysis-runner.js';

const RUN_ID = 'run-review-runner';
const ATTEMPT_ID = 'attempt-review-runner';
const HEAD_SHA = 'a'.repeat(40);
const TASK_DIGEST = `sha256:${'b'.repeat(64)}`;
const ATTEMPT_TOKEN = 'CANARY_REVIEW_ATTEMPT_TOKEN';

function context() {
  return AutomatedReviewContextV1Schema.parse({
    schemaVersion: '1',
    kind: 'automated_review',
    attempt: {
      id: ATTEMPT_ID,
      runId: RUN_ID,
      mode: 'analysis',
      version: 7,
      leaseGeneration: 3,
      baseSha: HEAD_SHA,
    },
    review: {
      id: 'review-runner',
      iteration: 1,
      publicationId: 'publication-runner',
      repository: 'example/repo',
      pullRequestNumber: 42,
      baseBranch: 'main',
      headBranch: 'agent/task/attempt',
      headSha: HEAD_SHA,
    },
    task: {
      revision: 'revision-1',
      digest: TASK_DIGEST,
      title: 'Fix the regression',
      description: 'Correct the reported regression while preserving existing behavior.',
      acceptanceCriteria: ['The regression is fixed and trusted tests pass.'],
    },
    plan: {
      id: 'plan-runner',
      version: 1,
      digest: `sha256:${'c'.repeat(64)}`,
      objective: 'Implement and verify the correction.',
      item: {
        id: 'item-runner',
        title: 'Implement and verify',
        objective: 'Apply the correction and preserve the permission boundary.',
        doneWhen: ['The regression is fixed and verification passes.'],
        commandRefs: ['verify:all'],
      },
    },
  });
}

describe('automated review Runner', () => {
  it('binds model reservation identity to the review lease generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-review-quota-'));
    const workspace = join(root, 'workspace');
    const runnerTemp = join(root, 'runner-temp');
    await Promise.all([mkdir(workspace), mkdir(runnerTemp)]);
    let reservationBody: { reservationId: string } | undefined;
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: 'CANARY_REVIEW_OIDC_TOKEN' });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/exchange`)) {
        return Response.json({
          attemptToken: ATTEMPT_TOKEN,
          expiresAt: '2099-01-01T00:00:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: 'CANARY_REVIEW_TOOL_TOKEN',
            expiresAt: '2099-01-01T00:00:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/context`)) {
        return Response.json(context());
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/model-reservations`)) {
        reservationBody = JSON.parse(String(init?.body)) as { reservationId: string };
        return Response.json({
          reservationId: reservationBody.reservationId,
          attemptId: ATTEMPT_ID,
          runId: RUN_ID,
          provider: 'openai',
          model: 'gpt-test-metered',
          reservedTokens: 1_000,
          reservedCostMicrousd: 1_000,
          expiresAt: '2099-01-01T00:10:00.000Z',
          overrideId: null,
          disposition: 'created',
        }, { status: 201 });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/model-usage`)) {
        const body = JSON.parse(String(init?.body)) as {
          reservationId: string;
          usageId: string;
        };
        return Response.json({
          usageId: body.usageId,
          reservationId: body.reservationId,
          totalTokens: 15,
          costMicrousd: 1,
          disposition: 'created',
        }, { status: 201 });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/automated-review-result`)) {
        return Response.json({
          accepted: true,
          reviewId: 'review-runner',
          status: 'approved',
          created: true,
        }, { status: 201 });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    await runAnalysisAttempt({
      environment: {
        DELIVERY_SCHEMA_VERSION: '1',
        DELIVERY_RUN_ID: RUN_ID,
        DELIVERY_ATTEMPT_ID: ATTEMPT_ID,
        DELIVERY_TASK_DIGEST: TASK_DIGEST,
        DELIVERY_BASE_SHA: HEAD_SHA,
        DELIVERY_ATTEMPT_MODE: 'analysis',
        DELIVERY_MODEL_PROFILE_ID: 'profile-review-test',
        DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_RUNTIME_TOKEN',
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
      },
      fetch: fetchImplementation,
      reviewAgent: {
        usesMeteredModel: true,
        start: async (input) => {
          input.onUsage?.({
            inputTokens: 10,
            cachedInputTokens: 5,
            outputTokens: 5,
            reasoningOutputTokens: 2,
          });
          return {
            schemaVersion: '1',
            contextDigest: await automatedReviewContextDigest(context()),
            verdict: 'approved',
            summary: 'No blocker or major findings remain.',
            findings: [],
          };
        },
      },
      heartbeatIntervalMs: 60_000,
      snapshotWorkspace: async () => 'clean',
    });
    const expected = await canonicalSha256({
      attemptId: ATTEMPT_ID,
      kind: 'automated_review',
      leaseGeneration: 3,
    });
    const nextGeneration = await canonicalSha256({
      attemptId: ATTEMPT_ID,
      kind: 'automated_review',
      leaseGeneration: 4,
    });
    expect(reservationBody?.reservationId).toBe(
      `model_reservation_${expected.slice('sha256:'.length, 'sha256:'.length + 48)}`,
    );
    expect(expected).not.toBe(nextGeneration);
  });

  it('uses the existing analysis bootstrap and submits one read-only review result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-review-runner-'));
    const workspace = join(root, 'workspace');
    const runnerTemp = join(root, 'runner-temp');
    await Promise.all([mkdir(workspace), mkdir(runnerTemp)]);
    let submitted: unknown;
    const requestPaths: string[] = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      requestPaths.push(new URL(url).pathname);
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: 'CANARY_REVIEW_OIDC_TOKEN' });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/exchange`)) {
        return Response.json({
          attemptToken: ATTEMPT_TOKEN,
          expiresAt: '2099-01-01T00:00:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: 'CANARY_REVIEW_TOOL_TOKEN',
            expiresAt: '2099-01-01T00:00:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/context`)) {
        return Response.json(context());
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/automated-review-result`)) {
        submitted = JSON.parse(String(init?.body)) as unknown;
        return Response.json({
          accepted: true,
          reviewId: 'review-runner',
          status: 'approved',
          created: true,
        }, { status: 201 });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const result = await runAnalysisAttempt({
      environment: {
        DELIVERY_SCHEMA_VERSION: '1',
        DELIVERY_RUN_ID: RUN_ID,
        DELIVERY_ATTEMPT_ID: ATTEMPT_ID,
        DELIVERY_TASK_DIGEST: TASK_DIGEST,
        DELIVERY_BASE_SHA: HEAD_SHA,
        DELIVERY_ATTEMPT_MODE: 'analysis',
        DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_RUNTIME_TOKEN',
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
      },
      fetch: fetchImplementation,
      reviewAgent: {
        usesMeteredModel: false,
        start: async () => ({
          schemaVersion: '1',
          contextDigest: await automatedReviewContextDigest(context()),
          verdict: 'approved',
          summary: 'No blocker or major findings remain.',
          findings: [],
        }),
      },
      heartbeatIntervalMs: 60_000,
      snapshotWorkspace: async () => 'clean',
    });
    expect(result).toEqual({ reviewId: 'review-runner', status: 'approved' });
    expect(submitted).toMatchObject({ verdict: 'approved', findings: [] });
    expect(requestPaths).toEqual([
      '/token',
      `/v1/attempts/${ATTEMPT_ID}/exchange`,
      `/v1/attempts/${ATTEMPT_ID}/context`,
      `/v1/attempts/${ATTEMPT_ID}/automated-review-result`,
    ]);
  });

  it('keeps automated-review provider failures safe and loggable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-review-runner-failure-'));
    const workspace = join(root, 'workspace');
    const runnerTemp = join(root, 'runner-temp');
    await Promise.all([mkdir(workspace), mkdir(runnerTemp)]);
    let failureBody: unknown;
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: 'CANARY_REVIEW_OIDC_TOKEN' });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/exchange`)) {
        return Response.json({
          attemptToken: ATTEMPT_TOKEN,
          expiresAt: '2099-01-01T00:00:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: 'CANARY_REVIEW_TOOL_TOKEN',
            expiresAt: '2099-01-01T00:00:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/context`)) {
        return Response.json(context());
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/events`)) {
        failureBody = JSON.parse(String(init?.body)) as unknown;
        return Response.json({ accepted: true }, { status: 202 });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const promise = runAnalysisAttempt({
      environment: {
        DELIVERY_SCHEMA_VERSION: '1',
        DELIVERY_RUN_ID: RUN_ID,
        DELIVERY_ATTEMPT_ID: ATTEMPT_ID,
        DELIVERY_TASK_DIGEST: TASK_DIGEST,
        DELIVERY_BASE_SHA: HEAD_SHA,
        DELIVERY_ATTEMPT_MODE: 'analysis',
        DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_RUNTIME_TOKEN',
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
      },
      fetch: fetchImplementation,
      reviewAgent: {
        usesMeteredModel: false,
        start: async () => {
          throw new CodexReviewAdapterError(
            'process_nonzero_exit',
            'provider_output_schema_rejected',
          );
        },
      },
      heartbeatIntervalMs: 60_000,
      snapshotWorkspace: async () => 'clean',
    });
    await expect(promise).rejects.toMatchObject({
      name: 'AnalysisRunnerError',
      analysisFailure: {
        kind: 'process_nonzero_exit',
        stage: 'single_pass',
        providerFailureCode: 'provider_output_schema_rejected',
      },
    } satisfies Partial<AnalysisRunnerError>);
    expect(failureBody).toMatchObject({
      failureCode: 'invalid_agent_output',
      failureSite: 'agent_output',
      attemptedPaths: ['repository_inspection'],
      neededHumanInput: 'manual_investigation',
    });
  });
});
