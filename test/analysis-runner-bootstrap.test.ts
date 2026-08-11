import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CodexAnalysisAdapter,
  CodexAnalysisAdapterError,
  type CodexAnalysisStartInput,
} from '../src/agent/codex-analysis-adapter.js';
import { deriveAnalysisPlanId } from '../src/domain/analysis-plan.js';
import {
  computeDiagnosticEvidenceDigest,
  computeDiagnosticRootCauseDigest,
  type DiagnosticEvidenceV1,
} from '../src/domain/diagnostic-evidence.js';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  computeExecutionPlanDigest,
  type ExecutionPlanBodyV1,
  type ExecutionPlanV1,
} from '../src/domain/plan.js';
import { taskRevisionDigest, type TaskEnvelope } from '../src/domain/task.js';
import { TRIAGE_TOOL_ACTIONS } from '../src/domain/tool-bridge.js';
import {
  runAnalysisAttempt,
} from '../src/runner/analysis-runner.js';
import type { AnalysisRunnerError } from '../src/runner/analysis-runner.js';

const ATTEMPT_ID = 'attempt-analysis-bootstrap';
const RUN_ID = 'run-analysis-bootstrap';
const BASE_SHA = 'a'.repeat(40);
const OIDC_TOKEN = 'CANARY_GITHUB_OIDC_TOKEN';
const INITIAL_TOKEN = 'CANARY_INITIAL_ATTEMPT_TOKEN';
const ROTATED_TOKEN = 'CANARY_ROTATED_ATTEMPT_TOKEN';
const INITIAL_TOOL_TOKEN = 'CANARY_INITIAL_TOOL_TOKEN';
const ROTATED_TOOL_TOKEN = 'CANARY_ROTATED_TOOL_TOKEN';
const BODY_CANARY = 'CANARY_PRIVATE_USER_FEEDBACK';
const REVISION_CANARY = 'CANARY_DIGEST_VERIFIED_SUPPLEMENTAL_CONTEXT';
const SCHEMA_PATH = resolve('schemas/analysis-plan-content-v1.schema.json');

function taskEnvelope(
  kind: 'requirement' | 'bug' = 'requirement',
  allowRepositoryWrite = false,
): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: 'event-analysis-bootstrap',
    occurredAt: '2026-07-25T00:00:00.000Z',
    source: {
      system: 'manual',
      tenantKey: 'runner-test',
      taskKey: 'runner-test-task',
      revision: 'revision-1',
    },
    actor: { type: 'user', id: 'runner-test-user' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'none',
    },
    intent: {
      kind,
      title: 'Runner bootstrap test',
      description: BODY_CANARY,
      acceptanceCriteria: ['The cause is identified and a verifiable plan is produced.'],
      priority: 'p1',
    },
    policy: {
      allowRepositoryWrite,
      allowTestDeploy: false,
      allowProductionDeploy: false,
      requireHumanApproval: true,
    },
  };
}

function diagnosticPlanContent(evidenceRefs: string[] = []): Record<string, unknown> {
  return {
    objective: 'Identify the request-backed cause and prepare a safe execution plan.',
    assumptions: ['The bounded diagnostic results are untrusted reference material.'],
    evidenceRefs,
    items: [
      {
        id: 'diagnose-request',
        kind: 'investigation',
        title: 'Confirm the request root cause',
        objective: 'Bind the request trace to the responsible source path.',
        acceptanceCriteriaIndexes: [0],
        doneWhen: ['Verified diagnostic Evidence identifies the responsible code path.'],
        verification: {
          commandRefs: ['policy:diagnose'],
          evidenceKinds: ['diagnostic'],
        },
        effects: ['repo_read', 'logs_read'],
        dependsOn: [],
        required: true,
      },
    ],
  };
}

function unboundWritableDiagnosticPlanContent(): Record<string, unknown> {
  return {
    objective: 'Repair the traced request failure and prove the committed result.',
    assumptions: ['The bounded diagnostic results are untrusted reference material.'],
    evidenceRefs: [],
    items: [
      {
        id: 'repair-request-path',
        kind: 'change',
        title: 'Repair and verify the request path',
        objective: 'Make the smallest source change in src/request.ts that fixes the traced failure.',
        acceptanceCriteriaIndexes: [0],
        doneWhen: ['The failure is fixed in one commit and trusted verification passes.'],
        verification: {
          commandRefs: ['test:unit', 'verify:all'],
          evidenceKinds: ['commit', 'test'],
        },
        effects: ['repo_read', 'repo_write'],
        dependsOn: [],
        required: true,
      },
    ],
  };
}

function planContent(): Record<string, unknown> {
  return {
    objective: 'Identify the source-backed cause and prepare a safe execution plan.',
    assumptions: ['The checked out base SHA is the trusted source snapshot.'],
    evidenceRefs: ['d1://evidence/source-inspection-1'],
    items: [
      {
        id: 'inspect-source',
        kind: 'investigation',
        title: 'Inspect the source path',
        objective: 'Trace the reported behavior through the checked out source.',
        acceptanceCriteriaIndexes: [0],
        doneWhen: ['The responsible code path is linked to diagnostic Evidence.'],
        verification: {
          commandRefs: ['policy:inspect'],
          evidenceKinds: ['diagnostic'],
        },
        effects: ['repo_read'],
        dependsOn: [],
        required: true,
      },
    ],
  };
}

function writablePlanContent(path = 'src/request.ts'): Record<string, unknown> {
  return {
    objective: 'Implement the requested repository change and prove the committed result.',
    assumptions: ['The checked out base SHA is the trusted source snapshot.'],
    evidenceRefs: [],
    items: [
      {
        id: 'implement-request',
        kind: 'change',
        title: 'Implement and verify the request',
        objective: `Make the smallest requested change in ${path}.`,
        acceptanceCriteriaIndexes: [0],
        doneWhen: ['The committed change passes targeted and required verification.'],
        verification: {
          commandRefs: ['test:unit', 'verify:all'],
          evidenceKinds: ['commit', 'test'],
        },
        effects: ['repo_write'],
        dependsOn: [],
        required: true,
      },
    ],
  };
}

async function responsePlan(content: Record<string, unknown> = planContent()): Promise<{
  planId: string;
  digest: string;
  payloadRef: string;
}> {
  const planId = await deriveAnalysisPlanId(RUN_ID, ATTEMPT_ID, 1);
  const body: ExecutionPlanBodyV1 = {
    schemaVersion: '1',
    id: planId,
    runId: RUN_ID,
    version: 1,
    taskRevision: 'revision-1',
    baseSha: BASE_SHA,
    createdByAttemptId: ATTEMPT_ID,
    ...(content as Omit<
      ExecutionPlanBodyV1,
      | 'schemaVersion'
      | 'id'
      | 'runId'
      | 'version'
      | 'taskRevision'
      | 'baseSha'
      | 'createdByAttemptId'
    >),
  };
  return {
    planId,
    digest: await computeExecutionPlanDigest(body),
    payloadRef: `d1://execution-plans/${planId}`,
  };
}

async function proposedPlan(
  input: CodexAnalysisStartInput,
  content: Record<string, unknown>,
): Promise<ExecutionPlanV1> {
  const body: ExecutionPlanBodyV1 = {
    schemaVersion: '1',
    id: input.identity.planId,
    runId: input.identity.runId,
    version: input.identity.version,
    taskRevision: input.identity.taskRevision,
    baseSha: input.identity.baseSha,
    createdByAttemptId: input.identity.attemptId,
    ...(content as Omit<
      ExecutionPlanBodyV1,
      | 'schemaVersion'
      | 'id'
      | 'runId'
      | 'version'
      | 'taskRevision'
      | 'baseSha'
      | 'createdByAttemptId'
    >),
  };
  return {
    ...body,
    digest: await computeExecutionPlanDigest(body),
    status: 'proposed',
  };
}

async function runnerEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const taskDigest = await taskRevisionDigest(taskEnvelope());
  return {
    DELIVERY_SCHEMA_VERSION: '1',
    DELIVERY_RUN_ID: RUN_ID,
    DELIVERY_ATTEMPT_ID: ATTEMPT_ID,
    DELIVERY_TASK_DIGEST: taskDigest,
    DELIVERY_BASE_SHA: BASE_SHA,
    DELIVERY_ATTEMPT_MODE: 'analysis',
    DELIVERY_MODEL_PROFILE_ID: 'profile-analysis-test',
    DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token?job=123',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_RUNTIME_TOKEN',
    GITHUB_WORKSPACE: join(root, 'workspace'),
    RUNNER_TEMP: join(root, 'runner-temp'),
  };
}

describe('analysis Runner bootstrap', () => {
  it('preserves a fixed Agent failure kind and stage without changing terminal failure payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-runner-classification-'));
    const environment = await runnerEnvironment(root);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(environment.GITHUB_WORKSPACE!, { recursive: true });
    await mkdir(environment.RUNNER_TEMP!, { recursive: true });
    const bugTask = taskEnvelope('bug');
    environment.DELIVERY_TASK_DIGEST = await taskRevisionDigest(bugTask);
    let failureBody: unknown;
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken: INITIAL_TOKEN,
          expiresAt: '2026-07-25T00:05:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: INITIAL_TOOL_TOKEN,
            expiresAt: '2026-07-25T00:05:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith('/context')) {
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID, runId: RUN_ID, mode: 'analysis', version: 7,
            leaseGeneration: 3, baseSha: BASE_SHA,
          },
          task: bugTask,
          planPolicy: {
            version: 1,
            allowedEffects: ['repo_read', 'logs_read'],
            allowedCommandRefs: ['policy:diagnose'],
          },
        });
      }
      if (url.endsWith('/events')) {
        failureBody = JSON.parse(String(init?.body)) as unknown;
        return Response.json({ accepted: true }, { status: 202 });
      }
      throw new Error('unexpected classification fake request');
    };
    const promise = runAnalysisAttempt({
      environment,
      fetch: fetchImplementation,
      agent: {
        start: async () => {
          throw new CodexAnalysisAdapterError(
            'process_nonzero_exit',
            'diagnostic_root_cause',
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
        stage: 'diagnostic_root_cause',
        providerFailureCode: 'provider_output_schema_rejected',
      },
    } satisfies Partial<AnalysisRunnerError>);
    expect(failureBody).toMatchObject({
      failureCode: 'invalid_agent_output',
      failureSite: 'agent_output',
      attemptedPaths: ['repository_inspection'],
      neededHumanInput: 'manual_investigation',
    });
    expect(failureBody).not.toHaveProperty('analysisFailure');
  });

  it('keeps trusted context readable inside the read-only workspace and removes it before the final snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-runner-test-'));
    const environment = await runnerEnvironment(root);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(environment.GITHUB_WORKSPACE!, { recursive: true });
    await mkdir(environment.RUNNER_TEMP!, { recursive: true });
    const expectedPlan = await responsePlan();
    let heartbeatObserved!: () => void;
    const heartbeatDone = new Promise<void>((resolvePromise) => {
      heartbeatObserved = resolvePromise;
    });
    let heartbeatCount = 0;
    let planBody: unknown;
    let completionBody: unknown;
    const requestLog: Array<{ url: string; authorization: string | null }> = [];

    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization');
      requestLog.push({ url, authorization });
      if (url.startsWith('https://oidc.actions.test/token')) {
        expect(new URL(url).searchParams.get('audience')).toBe('delivery-loop-control-plane');
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/exchange`)) {
        expect(authorization).toBe(`Bearer ${OIDC_TOKEN}`);
        return Response.json({
          attemptToken: INITIAL_TOKEN,
          expiresAt: '2026-07-25T00:05:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: INITIAL_TOOL_TOKEN,
            expiresAt: '2026-07-25T00:05:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/context`)) {
        expect(authorization).toBe(`Bearer ${INITIAL_TOKEN}`);
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID,
            runId: RUN_ID,
            mode: 'analysis',
            version: 7,
            leaseGeneration: 3,
            baseSha: BASE_SHA,
          },
          task: taskEnvelope(),
          revisionSource: {
            schemaVersion: '1',
            kind: 'supplemental_context',
            digest: `sha256:${'9'.repeat(64)}`,
            data: {
              schemaVersion: '1',
              source: {
                system: 'manual',
                tenantKey: 'runner-test',
                taskKey: 'runner-test-task',
                priorRevision: 'revision-0',
                revision: 'revision-1',
              },
              actor: { type: 'user', id: 'runner-test-user' },
              body: REVISION_CANARY,
              taskRevision: {
                digest: await taskRevisionDigest(taskEnvelope()),
                task: taskEnvelope(),
              },
            },
          },
          planPolicy: {
            version: 1,
            allowedEffects: ['repo_read', 'logs_read', 'database_diagnostic'],
            allowedCommandRefs: ['policy:inspect', 'policy:diagnose'],
          },
        });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/model-reservations`)) {
        expect(authorization).toBe(`Bearer ${INITIAL_TOKEN}`);
        const body = JSON.parse(String(init?.body)) as {
          reservationId: string;
          profileId: string;
        };
        expect(body.profileId).toBe('profile-analysis-test');
        return Response.json({
          reservationId: body.reservationId,
          attemptId: ATTEMPT_ID,
          runId: RUN_ID,
          provider: 'openai',
          model: 'gpt-test-metered',
          reservedTokens: 1_000,
          reservedCostMicrousd: 1_000,
          expiresAt: '2026-07-25T00:10:00.000Z',
          overrideId: null,
          disposition: 'created',
        }, { status: 201 });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/heartbeat`)) {
        heartbeatCount += 1;
        expect(authorization).toBe(`Bearer ${INITIAL_TOKEN}`);
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersion: 7,
          leaseGeneration: 3,
        });
        heartbeatObserved();
        return Response.json({
          attemptToken: ROTATED_TOKEN,
          toolBridgeToken: ROTATED_TOOL_TOKEN,
          version: 8,
          leaseGeneration: 3,
          expiresAt: '2026-07-25T00:06:00.000Z',
        });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/plan`)) {
        expect(authorization).toBe(`Bearer ${ROTATED_TOKEN}`);
        planBody = JSON.parse(String(init?.body)) as unknown;
        return Response.json(
          {
            planId: expectedPlan.planId,
            version: 1,
            digest: expectedPlan.digest,
            status: 'validated',
            payloadRef: expectedPlan.payloadRef,
          },
          { status: 201 },
        );
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/model-usage`)) {
        expect(authorization).toBe(`Bearer ${ROTATED_TOKEN}`);
        const body = JSON.parse(String(init?.body)) as {
          reservationId: string;
          usageId: string;
          inputTokens: number;
          outputTokens: number;
        };
        expect(body).toMatchObject({ inputTokens: 100, outputTokens: 20 });
        return Response.json({
          usageId: body.usageId,
          reservationId: body.reservationId,
          totalTokens: 120,
          costMicrousd: 42,
          disposition: 'created',
        }, { status: 201 });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/complete`)) {
        expect(authorization).toBe(`Bearer ${ROTATED_TOKEN}`);
        completionBody = JSON.parse(String(init?.body)) as unknown;
        return Response.json(
          { accepted: true, signalId: 'signal-runner-test', outboxId: 'outbox-runner-test' },
          { status: 202 },
        );
      }
      throw new Error('unexpected fake URL');
    };

    const adapter = new CodexAnalysisAdapter({
      outputSchemaPath: SCHEMA_PATH,
      execute: async (request) => {
        const contextDirectoryName = (await readdir(environment.GITHUB_WORKSPACE!)).find(
          (name) => name.startsWith('.delivery-loop-analysis-context-'),
        );
        expect(contextDirectoryName).toBeDefined();
        const contextDirectory = join(environment.GITHUB_WORKSPACE!, contextDirectoryName!);
        const contextPath = join(contextDirectory, 'context.json');
        expect((await stat(contextDirectory)).mode & 0o777).toBe(0o700);
        expect((await stat(contextPath)).mode & 0o777).toBe(0o600);
        expect(request.stdin).toContain(contextPath);
        const outputPath = request.args[request.args.indexOf('--output-last-message') + 1]!;
        expect(outputPath.startsWith(`${environment.RUNNER_TEMP!}/`)).toBe(true);
        expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
        const schemaPath = join(
          resolve(outputPath, '..'),
          'analysis-agent-output-schema.json',
        );
        expect(schemaPath.startsWith(`${environment.RUNNER_TEMP!}/`)).toBe(true);
        expect((await stat(schemaPath)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(schemaPath, 'utf8'))).toMatchObject({
          additionalProperties: false,
          required: ['contextDigest', 'plan'],
        });
        const contextFile = JSON.parse(await readFile(contextPath, 'utf8')) as {
          schemaVersion: string;
          contextDigest: string;
          context: unknown;
        };
        expect(contextFile.schemaVersion).toBe('1');
        expect(JSON.stringify(contextFile.context)).toContain(BODY_CANARY);
        expect(JSON.stringify(contextFile.context)).toContain(REVISION_CANARY);
        expect(contextFile.contextDigest).toBe(
          `sha256:${createHash('sha256')
            .update(JSON.stringify(contextFile.context))
            .digest('hex')}`,
        );
        await heartbeatDone;
        request.onStdoutLine?.(JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 100,
            cached_input_tokens: 60,
            output_tokens: 20,
            reasoning_output_tokens: 5,
          },
        }));
        await writeFile(
          request.args[request.args.indexOf('--output-last-message') + 1]!,
          JSON.stringify({
            contextDigest: contextFile.contextDigest,
            plan: planContent(),
          }),
        );
        return { exitCode: 0 };
      },
    });
    let snapshotCount = 0;

    const result = await runAnalysisAttempt({
      environment,
      fetch: fetchImplementation,
      agent: adapter,
      heartbeatIntervalMs: 500,
      snapshotWorkspace: async () => {
        snapshotCount += 1;
        if (snapshotCount === 2) {
          expect(await readdir(environment.GITHUB_WORKSPACE!)).toEqual([]);
        }
        return 'clean-snapshot';
      },
      now: () => new Date('2026-07-25T00:01:00.000Z'),
    });

    expect(result).toEqual({
      planId: expectedPlan.planId,
      version: 1,
      digest: expectedPlan.digest,
      payloadRef: expectedPlan.payloadRef,
    });
    expect(heartbeatCount).toBe(1);
    expect(planBody).toEqual(planContent());
    expect(Object.keys(planBody as Record<string, unknown>)).not.toEqual(
      expect.arrayContaining([
        'id',
        'runId',
        'version',
        'taskRevision',
        'baseSha',
        'createdByAttemptId',
        'digest',
        'status',
      ]),
    );
    expect(completionBody).toMatchObject({
      schemaVersion: '1',
      sequence: 1,
      payloadRef: expectedPlan.payloadRef,
      digest: expectedPlan.digest,
      expectedVersion: 8,
      leaseGeneration: 3,
    });
    expect(JSON.stringify(requestLog)).not.toContain(BODY_CANARY);
    expect(snapshotCount).toBe(2);
    expect(await readdir(environment.GITHUB_WORKSPACE!)).toEqual([]);
    expect(await readdir(environment.RUNNER_TEMP!)).toEqual([]);
  });

  it('fixes bug mediation to rotated-token logs, trace, Evidence, and exact Plan binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-runner-diagnostic-'));
    const environment = await runnerEnvironment(root);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(environment.GITHUB_WORKSPACE!, { recursive: true });
    await mkdir(environment.RUNNER_TEMP!, { recursive: true });
    const bugTask = taskEnvelope('bug');
    environment.DELIVERY_TASK_DIGEST = await taskRevisionDigest(bugTask);
    const evidenceRef = 'd1://evidence/diagnostic_runner_verified';
    const expectedContent = diagnosticPlanContent([evidenceRef]);
    const expectedPlan = await responsePlan(expectedContent);
    let heartbeatObserved!: () => void;
    const heartbeatDone = new Promise<void>((resolvePromise) => {
      heartbeatObserved = resolvePromise;
    });
    const relevantOrder: string[] = [];
    let planBody: unknown;
    let evidenceBody: DiagnosticEvidenceV1 | undefined;
    let reservationCount = 0;
    let usageCount = 0;

    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization');
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken: INITIAL_TOKEN,
          expiresAt: '2026-07-25T00:05:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: INITIAL_TOOL_TOKEN,
            expiresAt: '2026-07-25T00:05:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith('/context')) {
        expect(authorization).toBe(`Bearer ${INITIAL_TOKEN}`);
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID,
            runId: RUN_ID,
            mode: 'analysis',
            version: 7,
            leaseGeneration: 3,
            baseSha: BASE_SHA,
          },
          task: bugTask,
          planPolicy: {
            version: 1,
            allowedEffects: ['repo_read', 'logs_read'],
            allowedCommandRefs: ['policy:inspect', 'policy:diagnose'],
          },
        });
      }
      if (url.endsWith('/model-reservations')) {
        reservationCount += 1;
        expect(authorization).toBe(`Bearer ${INITIAL_TOKEN}`);
        const body = JSON.parse(String(init?.body)) as { reservationId: string };
        return Response.json({
          reservationId: body.reservationId,
          attemptId: ATTEMPT_ID,
          runId: RUN_ID,
          provider: 'openai',
          model: 'gpt-test-metered',
          reservedTokens: 1_000,
          reservedCostMicrousd: 1_000,
          expiresAt: '2026-07-25T00:10:00.000Z',
          overrideId: null,
          disposition: 'created',
        }, { status: 201 });
      }
      if (url.endsWith('/heartbeat')) {
        expect(authorization).toBe(`Bearer ${INITIAL_TOKEN}`);
        heartbeatObserved();
        return Response.json({
          attemptToken: ROTATED_TOKEN,
          toolBridgeToken: ROTATED_TOOL_TOKEN,
          version: 8,
          leaseGeneration: 3,
          expiresAt: '2026-07-25T00:06:00.000Z',
        });
      }
      if (url.endsWith('/tools/call')) {
        expect(authorization).toBe(`Bearer ${ROTATED_TOOL_TOKEN}`);
        const body = JSON.parse(String(init?.body)) as {
          toolPath: string;
          arguments: Record<string, unknown>;
        };
        relevantOrder.push(body.toolPath);
        if (body.toolPath === 'logs/search') {
          expect(body.arguments).toEqual({
            uid: 'safe-user-locator',
            cid: 'safe-conversation-locator',
            path: '/v1/chat',
          });
          return Response.json({
            ok: true,
            traceId: 'tooltrace_z_logs',
            result: { entries: [{ requestTraceId: 'safe-request-trace' }] },
          });
        }
        expect(body.toolPath).toBe('traces/get');
        expect(body.arguments).toEqual({ requestTraceId: 'safe-request-trace' });
        return Response.json({
          ok: true,
          traceId: 'tooltrace_a_request',
          result: { spans: [{ service: 'chat-api', outcome: 'stale-cache' }] },
        });
      }
      if (url.endsWith('/model-usage')) {
        usageCount += 1;
        expect(authorization).toBe(`Bearer ${ROTATED_TOKEN}`);
        const body = JSON.parse(String(init?.body)) as {
          reservationId: string;
          usageId: string;
        };
        return Response.json({
          usageId: body.usageId,
          reservationId: body.reservationId,
          totalTokens: 120,
          costMicrousd: 42,
          disposition: 'created',
        }, { status: 201 });
      }
      if (url.endsWith('/diagnostic-evidence')) {
        relevantOrder.push('diagnostic-evidence');
        expect(authorization).toBe(`Bearer ${ROTATED_TOKEN}`);
        evidenceBody = JSON.parse(String(init?.body)) as DiagnosticEvidenceV1;
        return Response.json({
          evidenceId: 'diagnostic_runner_verified',
          evidenceRef,
          evidenceDigest: await computeDiagnosticEvidenceDigest(evidenceBody),
          rootCauseDigest: await computeDiagnosticRootCauseDigest(evidenceBody.rootCause),
          created: true,
        }, { status: 201 });
      }
      if (url.endsWith('/plan')) {
        relevantOrder.push('plan');
        expect(authorization).toBe(`Bearer ${ROTATED_TOKEN}`);
        planBody = JSON.parse(String(init?.body)) as unknown;
        return Response.json({
          planId: expectedPlan.planId,
          version: 1,
          digest: expectedPlan.digest,
          status: 'validated',
          payloadRef: expectedPlan.payloadRef,
        }, { status: 201 });
      }
      if (url.endsWith('/complete')) {
        return Response.json(
          { accepted: true, signalId: 'signal-diagnostic', outboxId: 'outbox-diagnostic' },
          { status: 202 },
        );
      }
      throw new Error('unexpected diagnostic fake request');
    };

    const agent = {
      usesMeteredModel: true as const,
      async start(input: CodexAnalysisStartInput): Promise<ExecutionPlanV1> {
        expect(JSON.stringify(input)).not.toContain(INITIAL_TOKEN);
        expect(JSON.stringify(input)).not.toContain(INITIAL_TOOL_TOKEN);
        expect(input.diagnostic).toBeDefined();
        await heartbeatDone;
        const diagnostic = input.diagnostic!;
        for (const path of [
          diagnostic.mediationContextFilePath,
          diagnostic.logRequestOutputFilePath,
          diagnostic.traceRequestOutputFilePath,
          diagnostic.logRequestSchemaPath,
          diagnostic.traceRequestSchemaPath,
          diagnostic.rootCauseSchemaPath,
        ]) expect((await stat(path)).mode & 0o777).toBe(0o600);
        const logs = await diagnostic.mediation.searchLogs({
          schemaVersion: '1',
          locatorKinds: ['uid', 'cid', 'path'],
          arguments: {
            uid: 'safe-user-locator',
            cid: 'safe-conversation-locator',
            path: '/v1/chat',
          },
        });
        expect(logs).toMatchObject({ entries: [{ requestTraceId: 'safe-request-trace' }] });
        const trace = await diagnostic.mediation.getTrace({
          schemaVersion: '1',
          arguments: { requestTraceId: 'safe-request-trace' },
        });
        expect(trace).toMatchObject({ spans: [{ outcome: 'stale-cache' }] });
        await diagnostic.mediation.finish({
          summary: 'A stale cache branch returns the previous response.',
          confidence: 'high',
          codeRefs: [{ path: 'src/cache.ts', line: 42 }],
        });
        for (let index = 0; index < 4; index += 1) {
          input.onUsage?.({
            inputTokens: 100,
            cachedInputTokens: 60,
            outputTokens: 20,
            reasoningOutputTokens: 5,
          });
        }
        return await proposedPlan(input, diagnosticPlanContent());
      },
    };
    const snapshots = ['clean', 'clean'];
    const result = await runAnalysisAttempt({
      environment,
      fetch: fetchImplementation,
      agent,
      // Leave enough time for the diagnostic mediation filesystem/tool
      // round-trip after the first rotation; hosted runners are slower than
      // the local workerd process and should not accidentally start a second
      // heartbeat against this single-rotation fixture.
      heartbeatIntervalMs: 1_000,
      snapshotWorkspace: async () => snapshots.shift() ?? 'unexpected',
      now: () => new Date('2026-07-25T00:01:00.000Z'),
    });

    expect(result).toEqual({
      planId: expectedPlan.planId,
      version: 1,
      digest: expectedPlan.digest,
      payloadRef: expectedPlan.payloadRef,
    });
    expect(reservationCount).toBe(4);
    expect(usageCount).toBe(4);
    expect(relevantOrder).toEqual(['logs/search', 'traces/get', 'diagnostic-evidence', 'plan']);
    expect(planBody).toEqual(expectedContent);
    expect(evidenceBody).toMatchObject({
      schemaVersion: '1',
      locatorKinds: ['uid', 'cid', 'path'],
      sourceTraceIds: ['tooltrace_a_request', 'tooltrace_z_logs'],
    });
    expect(evidenceBody?.locatorDigest).toBe(await canonicalSha256({
      schemaVersion: '1',
      logsSearchArguments: {
        uid: 'safe-user-locator',
        cid: 'safe-conversation-locator',
        path: '/v1/chat',
      },
      traceGetArguments: { requestTraceId: 'safe-request-trace' },
    }));
    expect(await readdir(environment.RUNNER_TEMP!)).toEqual([]);
  });

  it.each([
    { name: 'binds the trusted ref', agentEvidenceRefs: [] as string[], succeeds: true },
    {
      name: 'rejects an Agent-authored diagnostic ref',
      agentEvidenceRefs: ['d1://evidence/diagnostic_prior_verified'],
      succeeds: false,
    },
  ])('$name during a base-only writable BUG replan', async (testCase) => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-runner-carried-diagnostic-'));
    const environment = await runnerEnvironment(root);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(environment.GITHUB_WORKSPACE!, { recursive: true });
    await mkdir(environment.RUNNER_TEMP!, { recursive: true });
    const bugTask = taskEnvelope('bug', true);
    environment.DELIVERY_TASK_DIGEST = await taskRevisionDigest(bugTask);
    const evidenceRef = 'd1://evidence/diagnostic_prior_verified';
    const expectedContent = {
      ...unboundWritableDiagnosticPlanContent(),
      evidenceRefs: [evidenceRef],
      items: [{
        ...(unboundWritableDiagnosticPlanContent().items as Array<Record<string, unknown>>)[0],
        effects: ['repo_read', 'logs_read', 'repo_write'],
        verification: {
          commandRefs: ['test:unit', 'verify:all'],
          evidenceKinds: ['commit', 'test'],
        },
      }],
    };
    const expectedPlan = await responsePlan(expectedContent);
    let reservationCount = 0;
    let usageCount = 0;
    let planBody: unknown;
    let diagnosticRequestObserved = false;

    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization');
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken: INITIAL_TOKEN,
          expiresAt: '2026-07-25T00:05:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: INITIAL_TOOL_TOKEN,
            expiresAt: '2026-07-25T00:05:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith('/context')) {
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID, runId: RUN_ID, mode: 'analysis', version: 7,
            leaseGeneration: 3, baseSha: BASE_SHA,
          },
          task: bugTask,
          revisionSource: {
            schemaVersion: '1',
            kind: 'base_update',
            digest: `sha256:${'8'.repeat(64)}`,
            data: {
              schemaVersion: '1',
              repository: 'example/delivery-target',
              baseBranch: 'main',
              beforeSha: 'b'.repeat(40),
              afterSha: BASE_SHA,
              relationship: 'ahead',
              aheadBy: 1,
              referenceDigest: `sha256:${'6'.repeat(64)}`,
              comparisonDigest: `sha256:${'7'.repeat(64)}`,
            },
          },
          carriedDiagnosticEvidenceRef: evidenceRef,
          planPolicy: {
            version: 1,
            allowedEffects: ['repo_read', 'logs_read', 'database_diagnostic', 'repo_write'],
            allowedCommandRefs: ['policy:inspect', 'policy:diagnose', 'test:unit', 'verify:all'],
            verificationCommandRefs: ['verify:all'],
            requiresRepositoryChange: true,
          },
        });
      }
      if (url.endsWith('/model-reservations')) {
        reservationCount += 1;
        const body = JSON.parse(String(init?.body)) as { reservationId: string };
        return Response.json({
          reservationId: body.reservationId,
          attemptId: ATTEMPT_ID,
          runId: RUN_ID,
          provider: 'openai',
          model: 'gpt-test-metered',
          reservedTokens: 1_000,
          reservedCostMicrousd: 1_000,
          expiresAt: '2026-07-25T00:10:00.000Z',
          overrideId: null,
          disposition: 'created',
        }, { status: 201 });
      }
      if (url.endsWith('/model-usage')) {
        usageCount += 1;
        const body = JSON.parse(String(init?.body)) as {
          reservationId: string;
          usageId: string;
        };
        return Response.json({
          usageId: body.usageId,
          reservationId: body.reservationId,
          totalTokens: 120,
          costMicrousd: 42,
          disposition: 'created',
        }, { status: 201 });
      }
      if (url.endsWith('/tools/call') || url.endsWith('/diagnostic-evidence')) {
        diagnosticRequestObserved = true;
        throw new Error('base-only replan must not repeat diagnostic mediation');
      }
      if (url.endsWith('/plan')) {
        expect(authorization).toBe(`Bearer ${INITIAL_TOKEN}`);
        planBody = JSON.parse(String(init?.body)) as unknown;
        return Response.json({
          planId: expectedPlan.planId,
          version: 1,
          digest: expectedPlan.digest,
          status: 'validated',
          payloadRef: expectedPlan.payloadRef,
        }, { status: 201 });
      }
      if (url.endsWith('/complete')) {
        return Response.json(
          { accepted: true, signalId: 'signal-carried-diagnostic', outboxId: 'outbox-carried' },
          { status: 202 },
        );
      }
      if (url.endsWith('/events')) {
        return Response.json({ accepted: true }, { status: 202 });
      }
      throw new Error(`unexpected carried diagnostic fake request: ${url}`);
    };

    const result = runAnalysisAttempt({
      environment,
      fetch: fetchImplementation,
      agent: {
        usesMeteredModel: true,
        async start(input) {
          expect(input.diagnostic).toBeUndefined();
          expect(await readFile(input.contextFilePath, 'utf8')).not.toContain(evidenceRef);
          input.onUsage?.({
            inputTokens: 100,
            cachedInputTokens: 60,
            outputTokens: 20,
            reasoningOutputTokens: 5,
          });
          return await proposedPlan(input, {
            ...unboundWritableDiagnosticPlanContent(),
            evidenceRefs: testCase.agentEvidenceRefs,
          });
        },
      },
      heartbeatIntervalMs: 60_000,
      snapshotWorkspace: async () => 'clean',
      listWritableRepositoryPaths: async () => ['src/request.ts'],
    });

    if (testCase.succeeds) {
      await expect(result).resolves.toEqual({
        planId: expectedPlan.planId,
        version: 1,
        digest: expectedPlan.digest,
        payloadRef: expectedPlan.payloadRef,
      });
    } else {
      await expect(result).rejects.toThrow();
    }
    expect(reservationCount).toBe(1);
    expect(usageCount).toBe(1);
    expect(diagnosticRequestObserved).toBe(false);
    expect(planBody).toEqual(testCase.succeeds ? expectedContent : undefined);
    expect(await readdir(environment.RUNNER_TEMP!)).toEqual([]);
  });

  it('rejects a Secret-bearing log result before trace, Evidence, or Plan submission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-runner-diagnostic-secret-'));
    const environment = await runnerEnvironment(root);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(environment.GITHUB_WORKSPACE!, { recursive: true });
    await mkdir(environment.RUNNER_TEMP!, { recursive: true });
    const bugTask = taskEnvelope('bug');
    environment.DELIVERY_TASK_DIGEST = await taskRevisionDigest(bugTask);
    const requestedPaths: string[] = [];
    let failureBody: unknown;
    let evidenceOrPlanSubmitted = false;
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken: INITIAL_TOKEN,
          expiresAt: '2026-07-25T00:05:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: INITIAL_TOOL_TOKEN,
            expiresAt: '2026-07-25T00:05:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith('/context')) {
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID, runId: RUN_ID, mode: 'analysis', version: 7,
            leaseGeneration: 3, baseSha: BASE_SHA,
          },
          task: bugTask,
          planPolicy: {
            version: 1,
            allowedEffects: ['repo_read', 'logs_read'],
            allowedCommandRefs: ['policy:diagnose'],
          },
        });
      }
      if (url.endsWith('/tools/call')) {
        const body = JSON.parse(String(init?.body)) as { toolPath: string };
        requestedPaths.push(body.toolPath);
        return Response.json({
          ok: true,
          traceId: 'tooltrace_secret_log',
          result: { message: `Injected log contains ${INITIAL_TOKEN}` },
        });
      }
      if (url.endsWith('/diagnostic-evidence') || url.endsWith('/plan')) {
        evidenceOrPlanSubmitted = true;
      }
      if (url.endsWith('/events')) {
        failureBody = JSON.parse(String(init?.body)) as unknown;
        return Response.json({ accepted: true }, { status: 202 });
      }
      throw new Error('unexpected diagnostic secret fake request');
    };
    const agent = {
      async start(input: CodexAnalysisStartInput): Promise<ExecutionPlanV1> {
        await input.diagnostic!.mediation.searchLogs({
          schemaVersion: '1',
          locatorKinds: ['uid'],
          arguments: { uid: 'safe-user-locator' },
        });
        throw new Error('unreachable');
      },
    };
    const promise = runAnalysisAttempt({
      environment,
      fetch: fetchImplementation,
      agent,
      heartbeatIntervalMs: 60_000,
      snapshotWorkspace: async () => 'clean',
    });
    await expect(promise).rejects.toThrow('analysis diagnostic tool call failed');
    await expect(promise).rejects.not.toThrow(INITIAL_TOKEN);
    expect(requestedPaths).toEqual(['logs/search']);
    expect(evidenceOrPlanSubmitted).toBe(false);
    expect(failureBody).toMatchObject({
      failureCode: 'tool_unavailable',
      failureSite: 'tool_logs_search',
      attemptedPaths: ['log_query'],
      neededHumanInput: 'resolve_external_dependency',
    });
    expect(JSON.stringify(failureBody)).not.toContain(INITIAL_TOKEN);
    expect(await readdir(environment.GITHUB_WORKSPACE!)).toEqual([]);
    expect(await readdir(environment.RUNNER_TEMP!)).toEqual([]);
  });

  it.each([
    {
      name: 'a repeated logs request',
      mode: 'duplicate_logs' as const,
      expectedPaths: ['logs/search'],
      expectedFailure: {
        failureCode: 'invalid_agent_output',
        failureSite: 'agent_output',
        attemptedPaths: ['log_query'],
        neededHumanInput: 'manual_investigation',
      },
    },
    {
      name: 'an unavailable request trace',
      mode: 'trace_unavailable' as const,
      expectedPaths: ['logs/search', 'traces/get'],
      expectedFailure: {
        failureCode: 'tool_unavailable',
        failureSite: 'tool_trace_get',
        attemptedPaths: ['log_query', 'trace_query'],
        neededHumanInput: 'resolve_external_dependency',
      },
    },
  ])('fails closed on $name without exceeding the fixed tool sequence', async (testCase) => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-runner-diagnostic-order-'));
    const environment = await runnerEnvironment(root);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(environment.GITHUB_WORKSPACE!, { recursive: true });
    await mkdir(environment.RUNNER_TEMP!, { recursive: true });
    const bugTask = taskEnvelope('bug');
    environment.DELIVERY_TASK_DIGEST = await taskRevisionDigest(bugTask);
    const requestedPaths: string[] = [];
    let failureBody: unknown;
    let evidenceOrPlanSubmitted = false;
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken: INITIAL_TOKEN,
          expiresAt: '2026-07-25T00:05:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: INITIAL_TOOL_TOKEN,
            expiresAt: '2026-07-25T00:05:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith('/context')) {
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID, runId: RUN_ID, mode: 'analysis', version: 7,
            leaseGeneration: 3, baseSha: BASE_SHA,
          },
          task: bugTask,
          planPolicy: {
            version: 1,
            allowedEffects: ['repo_read', 'logs_read'],
            allowedCommandRefs: ['policy:diagnose'],
          },
        });
      }
      if (url.endsWith('/tools/call')) {
        const body = JSON.parse(String(init?.body)) as { toolPath: string };
        requestedPaths.push(body.toolPath);
        if (body.toolPath === 'logs/search') {
          return Response.json({
            ok: true,
            traceId: 'tooltrace_order_log',
            result: { requestTraceId: 'safe-request-trace' },
          });
        }
        return new Response('', { status: 503 });
      }
      if (url.endsWith('/diagnostic-evidence') || url.endsWith('/plan')) {
        evidenceOrPlanSubmitted = true;
      }
      if (url.endsWith('/events')) {
        failureBody = JSON.parse(String(init?.body)) as unknown;
        return Response.json({ accepted: true }, { status: 202 });
      }
      throw new Error('unexpected diagnostic order fake request');
    };
    const agent = {
      async start(input: CodexAnalysisStartInput): Promise<ExecutionPlanV1> {
        const mediation = input.diagnostic!.mediation;
        const request: Parameters<typeof mediation.searchLogs>[0] = {
          schemaVersion: '1',
          locatorKinds: ['uid'],
          arguments: { uid: 'safe-user-locator' },
        };
        await mediation.searchLogs(request);
        if (testCase.mode === 'duplicate_logs') await mediation.searchLogs(request);
        else {
          await mediation.getTrace({
            schemaVersion: '1',
            arguments: { requestTraceId: 'safe-request-trace' },
          });
        }
        throw new Error('unreachable');
      },
    };
    const promise = runAnalysisAttempt({
      environment,
      fetch: fetchImplementation,
      agent,
      heartbeatIntervalMs: 60_000,
      snapshotWorkspace: async () => 'clean',
    });
    await expect(promise).rejects.toThrow();
    expect(requestedPaths).toEqual(testCase.expectedPaths);
    expect(evidenceOrPlanSubmitted).toBe(false);
    expect(failureBody).toMatchObject(testCase.expectedFailure);
    expect(await readdir(environment.RUNNER_TEMP!)).toEqual([]);
  });

  it.each([
    {
      name: 'an Agent-authored diagnostic ref',
      evidenceRefs: ['d1://evidence/diagnostic_attacker_selected'],
      snapshots: ['clean'],
      expectedFailure: {
        failureCode: 'invalid_agent_output',
        failureSite: 'agent_output',
      },
      writable: false,
      missingDiagnosticBinding: false,
      expectedClassification: undefined,
    },
    {
      name: 'a repository workspace mutation',
      evidenceRefs: [],
      snapshots: ['clean', 'changed'],
      expectedFailure: {
        failureCode: 'workspace_changed',
        failureSite: 'repo_snapshot',
      },
      writable: false,
      missingDiagnosticBinding: false,
      expectedClassification: undefined,
    },
    {
      name: 'a writable bug Plan missing its diagnostic binding',
      evidenceRefs: [],
      snapshots: ['clean'],
      expectedFailure: {
        failureCode: 'invalid_agent_output',
        failureSite: 'agent_output',
      },
      writable: true,
      missingDiagnosticBinding: true,
      expectedClassification: {
        kind: 'plan_validation_failed',
        stage: 'diagnostic_plan',
      } as const,
    },
  ])('does not persist Evidence or Plan after $name', async (testCase) => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-runner-diagnostic-prewrite-'));
    const environment = await runnerEnvironment(root);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(environment.GITHUB_WORKSPACE!, { recursive: true });
    await mkdir(environment.RUNNER_TEMP!, { recursive: true });
    const bugTask = taskEnvelope('bug', testCase.writable);
    environment.DELIVERY_TASK_DIGEST = await taskRevisionDigest(bugTask);
    let evidenceOrPlanSubmitted = false;
    let failureBody: unknown;
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken: INITIAL_TOKEN,
          expiresAt: '2026-07-25T00:05:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: INITIAL_TOOL_TOKEN,
            expiresAt: '2026-07-25T00:05:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith('/context')) {
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID, runId: RUN_ID, mode: 'analysis', version: 7,
            leaseGeneration: 3, baseSha: BASE_SHA,
          },
          task: bugTask,
          planPolicy: {
            version: 1,
            allowedEffects: testCase.writable
              ? ['repo_read', 'logs_read', 'database_diagnostic', 'repo_write']
              : ['repo_read', 'logs_read'],
            allowedCommandRefs: testCase.writable
              ? ['policy:inspect', 'policy:diagnose', 'test:unit', 'verify:all']
              : ['policy:diagnose'],
            verificationCommandRefs: testCase.writable ? ['verify:all'] : [],
            requiresRepositoryChange: testCase.writable,
          },
        });
      }
      if (url.endsWith('/tools/call')) {
        const body = JSON.parse(String(init?.body)) as { toolPath: string };
        return body.toolPath === 'logs/search'
          ? Response.json({
              ok: true,
              traceId: 'tooltrace_prewrite_log',
              result: { requestTraceId: 'safe-request-trace' },
            })
          : Response.json({
              ok: true,
              traceId: 'tooltrace_prewrite_trace',
              result: { spans: [{ outcome: 'stale-cache' }] },
            });
      }
      if (url.endsWith('/diagnostic-evidence') || url.endsWith('/plan')) {
        evidenceOrPlanSubmitted = true;
      }
      if (url.endsWith('/events')) {
        failureBody = JSON.parse(String(init?.body)) as unknown;
        return Response.json({ accepted: true }, { status: 202 });
      }
      throw new Error('unexpected diagnostic prewrite fake request');
    };
    const agent = {
      async start(input: CodexAnalysisStartInput): Promise<ExecutionPlanV1> {
        const mediation = input.diagnostic!.mediation;
        await mediation.searchLogs({
          schemaVersion: '1',
          locatorKinds: ['uid'],
          arguments: { uid: 'safe-user-locator' },
        });
        await mediation.getTrace({
          schemaVersion: '1',
          arguments: { requestTraceId: 'safe-request-trace' },
        });
        await mediation.finish({
          summary: 'A source-backed stale cache branch caused the response mismatch.',
          confidence: 'high',
          codeRefs: [{ path: 'src/cache.ts', line: 42 }],
        });
        return await proposedPlan(
          input,
          testCase.missingDiagnosticBinding
            ? unboundWritableDiagnosticPlanContent()
            : diagnosticPlanContent(testCase.evidenceRefs),
        );
      },
    };
    const snapshots = [...testCase.snapshots];
    const promise = runAnalysisAttempt({
      environment,
      fetch: fetchImplementation,
      agent,
      heartbeatIntervalMs: 60_000,
      snapshotWorkspace: async () => snapshots.shift() ?? 'unexpected',
      listWritableRepositoryPaths: async () => ['src/request.ts'],
    });
    if (testCase.expectedClassification === undefined) {
      await expect(promise).rejects.toThrow();
    } else {
      await expect(promise).rejects.toMatchObject({
        name: 'AnalysisRunnerError',
        analysisFailure: testCase.expectedClassification,
      } satisfies Partial<AnalysisRunnerError>);
    }
    expect(evidenceOrPlanSubmitted).toBe(false);
    expect(failureBody).toMatchObject(testCase.expectedFailure);
    expect(await readdir(environment.RUNNER_TEMP!)).toEqual([]);
  });

  it('fails closed on workspace mutation without submitting a Plan or leaking canaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-runner-failure-'));
    const environment = await runnerEnvironment(root);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(environment.GITHUB_WORKSPACE!, { recursive: true });
    await mkdir(environment.RUNNER_TEMP!, { recursive: true });
    let planSubmitted = false;
    let failureBody: unknown;
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization');
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken: INITIAL_TOKEN,
          expiresAt: '2026-07-25T00:05:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: INITIAL_TOOL_TOKEN,
            expiresAt: '2026-07-25T00:05:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith('/context')) {
        expect(authorization).toBe(`Bearer ${INITIAL_TOKEN}`);
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID,
            runId: RUN_ID,
            mode: 'analysis',
            version: 7,
            leaseGeneration: 3,
            baseSha: BASE_SHA,
          },
          task: taskEnvelope(),
          planPolicy: {
            version: 1,
            allowedEffects: ['repo_read'],
            allowedCommandRefs: ['policy:inspect'],
          },
        });
      }
      if (url.endsWith('/model-reservations')) {
        const body = JSON.parse(String(init?.body)) as { reservationId: string };
        return Response.json({
          reservationId: body.reservationId,
          attemptId: ATTEMPT_ID,
          runId: RUN_ID,
          provider: 'openai',
          model: 'gpt-test-metered',
          reservedTokens: 1_000,
          reservedCostMicrousd: 1_000,
          expiresAt: '2026-07-25T00:10:00.000Z',
          overrideId: null,
          disposition: 'created',
        }, { status: 201 });
      }
      if (url.endsWith('/model-usage')) {
        const body = JSON.parse(String(init?.body)) as {
          usageId: string;
          reservationId: string;
        };
        return Response.json({
          usageId: body.usageId,
          reservationId: body.reservationId,
          totalTokens: 120,
          costMicrousd: 42,
          disposition: 'created',
        }, { status: 201 });
      }
      if (url.endsWith('/plan')) planSubmitted = true;
      if (url.endsWith('/events')) {
        failureBody = JSON.parse(String(init?.body)) as unknown;
        return Response.json({ accepted: true }, { status: 202 });
      }
      throw new Error('unexpected fake request');
    };
    const adapter = new CodexAnalysisAdapter({
      outputSchemaPath: SCHEMA_PATH,
      execute: async (request) => {
        request.onStdoutLine?.(JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 100,
            cached_input_tokens: 60,
            output_tokens: 20,
            reasoning_output_tokens: 5,
          },
        }));
        const contextDirectoryName = (await readdir(environment.GITHUB_WORKSPACE!)).find(
          (name) => name.startsWith('.delivery-loop-analysis-context-'),
        );
        expect(contextDirectoryName).toBeDefined();
        const contextFile = JSON.parse(await readFile(
          join(environment.GITHUB_WORKSPACE!, contextDirectoryName!, 'context.json'),
          'utf8',
        )) as { contextDigest: string };
        await writeFile(
          request.args[request.args.indexOf('--output-last-message') + 1]!,
          JSON.stringify({
            contextDigest: contextFile.contextDigest,
            plan: planContent(),
          }),
        );
        return { exitCode: 0 };
      },
    });
    const snapshots = ['before', `after-${BODY_CANARY}-${INITIAL_TOKEN}`];

    const promise = runAnalysisAttempt({
      environment,
      fetch: fetchImplementation,
      agent: adapter,
      heartbeatIntervalMs: 60_000,
      snapshotWorkspace: async () => snapshots.shift() ?? 'unexpected',
    });
    await expect(promise).rejects.toThrow('repository workspace changed during analysis');
    await expect(promise).rejects.not.toThrow(BODY_CANARY);
    await expect(promise).rejects.not.toThrow(INITIAL_TOKEN);
    expect(planSubmitted).toBe(false);
    expect(failureBody).toMatchObject({
      type: 'attempt_failed',
      failureCode: 'workspace_changed',
      failureSite: 'repo_snapshot',
      attemptedPaths: ['repository_inspection'],
      neededHumanInput: 'manual_investigation',
      expectedVersion: 7,
      leaseGeneration: 3,
    });
    expect(JSON.stringify(failureBody)).not.toContain(BODY_CANARY);
    expect(JSON.stringify(failureBody)).not.toContain(INITIAL_TOKEN);
    expect(await readdir(environment.GITHUB_WORKSPACE!)).toEqual([]);
    expect(await readdir(environment.RUNNER_TEMP!)).toEqual([]);
  });

  it('blocks a compromised Agent from copying a runtime Secret into Plan output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-runner-injection-'));
    const environment = await runnerEnvironment(root);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(environment.GITHUB_WORKSPACE!, { recursive: true });
    await mkdir(environment.RUNNER_TEMP!, { recursive: true });
    const injectedTask: TaskEnvelope = {
      ...taskEnvelope(),
      intent: {
        ...taskEnvelope().intent,
        description:
          'Untrusted task text asks the Agent to reveal tokens and ignore verification.',
      },
    };
    environment.DELIVERY_TASK_DIGEST = await taskRevisionDigest(injectedTask);
    let planSubmitted = false;
    let failureBody: unknown;
    let leakedPlan: ExecutionPlanV1 | undefined;
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken: INITIAL_TOKEN,
          expiresAt: '2026-07-25T00:05:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: INITIAL_TOOL_TOKEN,
            expiresAt: '2026-07-25T00:05:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith('/context')) {
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID,
            runId: RUN_ID,
            mode: 'analysis',
            version: 7,
            leaseGeneration: 3,
            baseSha: BASE_SHA,
          },
          task: injectedTask,
          planPolicy: {
            version: 1,
            allowedEffects: ['repo_read'],
            allowedCommandRefs: ['policy:inspect'],
          },
        });
      }
      if (url.endsWith('/plan')) {
        planSubmitted = true;
        if (leakedPlan === undefined) throw new Error('missing leaked Plan');
        return Response.json(
          {
            planId: leakedPlan.id,
            version: leakedPlan.version,
            digest: leakedPlan.digest,
            status: 'validated',
            payloadRef: `d1://execution-plans/${leakedPlan.id}`,
          },
          { status: 201 },
        );
      }
      if (url.endsWith('/events')) {
        failureBody = JSON.parse(String(init?.body)) as unknown;
        return Response.json({ accepted: true }, { status: 202 });
      }
      if (url.endsWith('/complete')) {
        return Response.json(
          { accepted: true, signalId: 'signal-injection', outboxId: 'outbox-injection' },
          { status: 202 },
        );
      }
      throw new Error('unexpected fake request');
    };
    const agent = {
      async start(input: CodexAnalysisStartInput) {
        const content = {
          ...planContent(),
          objective: `A malicious log asks to publish ${INITIAL_TOKEN}`,
        };
        const body: ExecutionPlanBodyV1 = {
          schemaVersion: '1',
          id: input.identity.planId,
          runId: input.identity.runId,
          version: input.identity.version,
          taskRevision: input.identity.taskRevision,
          baseSha: input.identity.baseSha,
          createdByAttemptId: input.identity.attemptId,
          ...(content as Omit<
            ExecutionPlanBodyV1,
            | 'schemaVersion'
            | 'id'
            | 'runId'
            | 'version'
            | 'taskRevision'
            | 'baseSha'
            | 'createdByAttemptId'
          >),
        };
        leakedPlan = {
          ...body,
          digest: await computeExecutionPlanDigest(body),
          status: 'proposed',
        };
        return leakedPlan;
      },
    };
    const snapshots = ['clean', 'clean'];
    const promise = runAnalysisAttempt({
      environment,
      fetch: fetchImplementation,
      agent,
      heartbeatIntervalMs: 60_000,
      snapshotWorkspace: async () => snapshots.shift() ?? 'unexpected',
    });
    await expect(promise).rejects.toThrow('analysis Agent output contains sensitive material');
    await expect(promise).rejects.not.toThrow(INITIAL_TOKEN);
    expect(planSubmitted).toBe(false);
    expect(failureBody).toMatchObject({
      type: 'attempt_failed',
      failureCode: 'invalid_agent_output',
      failureSite: 'agent_output',
      attemptedPaths: ['repository_inspection'],
      neededHumanInput: 'manual_investigation',
    });
    expect(JSON.stringify(failureBody)).not.toContain(INITIAL_TOKEN);
    expect(await readdir(environment.RUNNER_TEMP!)).toEqual([]);
  });

  it('rejects a runtime Secret reflected into control-plane context before Agent start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-runner-context-secret-'));
    const environment = await runnerEnvironment(root);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(environment.GITHUB_WORKSPACE!, { recursive: true });
    await mkdir(environment.RUNNER_TEMP!, { recursive: true });
    const reflectedTask: TaskEnvelope = {
      ...taskEnvelope(),
      intent: {
        ...taskEnvelope().intent,
        description: `Untrusted source reflected ${INITIAL_TOKEN}`,
      },
    };
    environment.DELIVERY_TASK_DIGEST = await taskRevisionDigest(reflectedTask);
    let agentStarted = false;
    const fetchImplementation: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken: INITIAL_TOKEN,
          expiresAt: '2026-07-25T00:05:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: INITIAL_TOOL_TOKEN,
            expiresAt: '2026-07-25T00:05:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith('/context')) {
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID,
            runId: RUN_ID,
            mode: 'analysis',
            version: 7,
            leaseGeneration: 3,
            baseSha: BASE_SHA,
          },
          task: reflectedTask,
          planPolicy: {
            version: 1,
            allowedEffects: ['repo_read'],
            allowedCommandRefs: ['policy:inspect'],
          },
        });
      }
      throw new Error('unexpected context Secret fake request');
    };

    const promise = runAnalysisAttempt({
      environment,
      fetch: fetchImplementation,
      agent: {
        async start() {
          agentStarted = true;
          throw new Error('must not start');
        },
      },
      heartbeatIntervalMs: 60_000,
      snapshotWorkspace: async () => 'clean',
    });

    await expect(promise).rejects.toThrow('analysis context contains a runtime Secret');
    await expect(promise).rejects.not.toThrow(INITIAL_TOKEN);
    expect(agentStarted).toBe(false);
    expect(await readdir(environment.GITHUB_WORKSPACE!)).toEqual([]);
    expect(await readdir(environment.RUNNER_TEMP!)).toEqual([]);
  });

  it.each([
    { name: 'accepts the second valid proposal', secondValid: true, writable: false },
    { name: 'fails after the second invalid proposal', secondValid: false, writable: false },
    { name: 'adds an exact trusted repository path', secondValid: true, writable: true },
  ])('runs one bounded initial Plan correction and $name', async ({ secondValid, writable }) => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-runner-plan-correction-'));
    const environment = await runnerEnvironment(root);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(environment.GITHUB_WORKSPACE!, { recursive: true });
    await mkdir(environment.RUNNER_TEMP!, { recursive: true });
    if (writable) {
      environment.DELIVERY_TASK_DIGEST = await taskRevisionDigest(
        taskEnvelope('requirement', true),
      );
    }
    const expectedContent = writable ? writablePlanContent() : planContent();
    const expectedPlan = await responsePlan(expectedContent);
    const reservationIds: string[] = [];
    const usageReservationIds: string[] = [];
    const correctionCodes: Array<readonly string[] | undefined> = [];
    let planSubmitted = false;
    let failureBody: unknown;

    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken: INITIAL_TOKEN,
          expiresAt: '2026-07-25T00:05:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: INITIAL_TOOL_TOKEN,
            expiresAt: '2026-07-25T00:05:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith('/context')) {
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID,
            runId: RUN_ID,
            mode: 'analysis',
            version: 7,
            leaseGeneration: 3,
            baseSha: BASE_SHA,
          },
          task: taskEnvelope('requirement', writable),
          planPolicy: writable
            ? {
                version: 1,
                allowedEffects: [
                  'repo_read', 'logs_read', 'database_diagnostic', 'repo_write',
                ],
                allowedCommandRefs: [
                  'policy:inspect', 'policy:diagnose', 'test:unit', 'verify:all',
                ],
                verificationCommandRefs: ['verify:all'],
                requiresRepositoryChange: true,
              }
            : {
                version: 1,
                allowedEffects: ['repo_read'],
                allowedCommandRefs: ['policy:inspect'],
              },
        });
      }
      if (url.endsWith('/model-reservations')) {
        const body = JSON.parse(String(init?.body)) as { reservationId: string };
        reservationIds.push(body.reservationId);
        return Response.json({
          reservationId: body.reservationId,
          attemptId: ATTEMPT_ID,
          runId: RUN_ID,
          provider: 'openai',
          model: 'gpt-test-metered',
          reservedTokens: 1_000,
          reservedCostMicrousd: 1_000,
          expiresAt: '2026-07-25T00:10:00.000Z',
          overrideId: null,
          disposition: 'created',
        }, { status: 201 });
      }
      if (url.endsWith('/model-usage')) {
        const body = JSON.parse(String(init?.body)) as {
          usageId: string;
          reservationId: string;
        };
        usageReservationIds.push(body.reservationId);
        return Response.json({
          usageId: body.usageId,
          reservationId: body.reservationId,
          totalTokens: 120,
          costMicrousd: 42,
          disposition: 'created',
        }, { status: 201 });
      }
      if (url.endsWith('/plan')) {
        planSubmitted = true;
        return Response.json({
          planId: expectedPlan.planId,
          version: 1,
          digest: expectedPlan.digest,
          status: 'validated',
          payloadRef: expectedPlan.payloadRef,
        }, { status: 201 });
      }
      if (url.endsWith('/complete')) {
        return Response.json({
          accepted: true,
          signalId: 'signal-plan-correction',
          outboxId: 'outbox-plan-correction',
        }, { status: 202 });
      }
      if (url.endsWith('/events')) {
        failureBody = JSON.parse(String(init?.body)) as unknown;
        return Response.json({ accepted: true }, { status: 202 });
      }
      throw new Error(`unexpected Plan correction fake request: ${url}`);
    };
    let invocation = 0;
    const result = runAnalysisAttempt({
      environment,
      fetch: fetchImplementation,
      agent: {
        usesMeteredModel: true,
        async start(input) {
          invocation += 1;
          correctionCodes.push(input.correctionIssueCodes);
          expect(input.onPlanCorrection === undefined).toBe(invocation === 2);
          input.onUsage?.({
            inputTokens: 100,
            cachedInputTokens: 60,
            outputTokens: 20,
            reasoningOutputTokens: 5,
          });
          const content = writable
            ? writablePlanContent(invocation === 1 || !secondValid ? 'src/request.ts.generated' : undefined)
            : planContent();
          if (!writable && (invocation === 1 || !secondValid)) {
            (content.items as Array<Record<string, unknown>>)[0]!
              .acceptanceCriteriaIndexes = [];
          }
          return await proposedPlan(input, content);
        },
      },
      heartbeatIntervalMs: 60_000,
      snapshotWorkspace: async () => 'clean',
      listWritableRepositoryPaths: async () => ['src/request.ts'],
      now: () => new Date('2026-07-25T00:01:00.000Z'),
    });

    if (secondValid) {
      await expect(result).resolves.toEqual({
        planId: expectedPlan.planId,
        version: 1,
        digest: expectedPlan.digest,
        payloadRef: expectedPlan.payloadRef,
      });
      expect(planSubmitted).toBe(true);
      expect(failureBody).toBeUndefined();
    } else {
      await expect(result).rejects.toMatchObject({
        name: 'AnalysisRunnerError',
        analysisFailure: {
          kind: 'plan_validation_failed',
          stage: 'plan_validation',
        },
      } satisfies Partial<AnalysisRunnerError>);
      expect(planSubmitted).toBe(false);
      expect(failureBody).toMatchObject({
        type: 'attempt_failed',
        failureCode: 'invalid_agent_output',
        failureSite: 'agent_output',
      });
    }
    expect(invocation).toBe(2);
    expect(correctionCodes).toEqual([
      undefined,
      [writable ? 'repository_path_required' : 'acceptance_criterion_uncovered'],
    ]);
    expect(reservationIds).toHaveLength(2);
    expect(new Set(reservationIds).size).toBe(2);
    expect(usageReservationIds).toEqual(reservationIds);
    expect(await readdir(environment.GITHUB_WORKSPACE!)).toEqual([]);
    expect(await readdir(environment.RUNNER_TEMP!)).toEqual([]);
  });

  it('durably reports an unclassified post-reservation failure with one exact retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-runner-terminal-failure-'));
    const environment = await runnerEnvironment(root);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(environment.GITHUB_WORKSPACE!, { recursive: true });
    await mkdir(environment.RUNNER_TEMP!, { recursive: true });
    const eventBodies: unknown[] = [];
    let eventRequests = 0;

    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken: INITIAL_TOKEN,
          expiresAt: '2026-07-25T00:05:00.000Z',
          attemptVersion: 7,
          leaseGeneration: 3,
          grant: {
            toolBridgeToken: INITIAL_TOOL_TOKEN,
            expiresAt: '2026-07-25T00:05:00.000Z',
            scopes: [...TRIAGE_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith('/context')) {
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID,
            runId: RUN_ID,
            mode: 'analysis',
            version: 7,
            leaseGeneration: 3,
            baseSha: BASE_SHA,
          },
          task: taskEnvelope(),
          planPolicy: {
            version: 1,
            allowedEffects: ['repo_read'],
            allowedCommandRefs: ['policy:inspect'],
          },
        });
      }
      if (url.endsWith('/model-reservations')) {
        const body = JSON.parse(String(init?.body)) as { reservationId: string };
        return Response.json({
          reservationId: body.reservationId,
          attemptId: ATTEMPT_ID,
          runId: RUN_ID,
          provider: 'openai',
          model: 'gpt-test-metered',
          reservedTokens: 1_000,
          reservedCostMicrousd: 1_000,
          expiresAt: '2026-07-25T00:10:00.000Z',
          overrideId: null,
          disposition: 'created',
        }, { status: 201 });
      }
      if (url.endsWith('/model-usage')) {
        return Response.json(
          { error: { code: 'temporarily_unavailable' } },
          { status: 503 },
        );
      }
      if (url.endsWith('/events')) {
        eventRequests += 1;
        eventBodies.push(JSON.parse(String(init?.body)) as unknown);
        if (eventRequests === 1) throw new Error('CANARY_AMBIGUOUS_FAILURE_CALLBACK');
        return Response.json({ accepted: true }, { status: 202 });
      }
      throw new Error(`unexpected terminal failure fake request: ${url}`);
    };

    const promise = runAnalysisAttempt({
      environment,
      fetch: fetchImplementation,
      agent: {
        usesMeteredModel: true,
        async start(input) {
          input.onUsage?.({
            inputTokens: 100,
            cachedInputTokens: 60,
            outputTokens: 20,
            reasoningOutputTokens: 5,
          });
          return await proposedPlan(input, planContent());
        },
      },
      heartbeatIntervalMs: 60_000,
      snapshotWorkspace: async () => 'clean',
      now: () => new Date('2026-07-25T00:01:00.000Z'),
    });

    await expect(promise).rejects.toMatchObject({
      name: 'AnalysisRunnerError',
      analysisFailure: {
        kind: 'runner_internal_failure',
        stage: 'runner_boundary',
      },
    } satisfies Partial<AnalysisRunnerError>);
    await expect(promise).rejects.not.toThrow(/CANARY_AMBIGUOUS_FAILURE_CALLBACK/);
    expect(eventRequests).toBe(2);
    expect(eventBodies[0]).toEqual(eventBodies[1]);
    expect(eventBodies[0]).toMatchObject({
      type: 'attempt_failed',
      failureCode: 'unknown_failure',
      failureSite: 'external_reconciliation',
      attemptedPaths: ['external_reconciliation'],
      neededHumanInput: 'manual_investigation',
      expectedVersion: 7,
      leaseGeneration: 3,
    });
    expect(JSON.stringify(eventBodies)).not.toContain('CANARY_AMBIGUOUS_FAILURE_CALLBACK');
    expect(await readdir(environment.GITHUB_WORKSPACE!)).toEqual([]);
    expect(await readdir(environment.RUNNER_TEMP!)).toEqual([]);
  });
});
