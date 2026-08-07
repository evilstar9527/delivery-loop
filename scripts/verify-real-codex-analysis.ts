import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CodexAnalysisAdapter,
  CodexAnalysisAdapterError,
  executeCommand,
} from '../src/agent/codex-analysis-adapter.js';
import {
  classifyAnalysisProviderProcessFailure,
} from '../src/agent/provider-preflight-failure.js';
import {
  ANALYSIS_AGENT_OUTPUT_V1_JSON_SCHEMA,
  AnalysisAgentOutputV1Schema,
  DIAGNOSTIC_ROOT_CAUSE_RESULT_V1_JSON_SCHEMA,
  DIAGNOSTIC_LOG_SEARCH_REQUEST_V1_JSON_SCHEMA,
  DIAGNOSTIC_TRACE_REQUEST_V1_JSON_SCHEMA,
  createAnalysisContextFileV1,
} from '../src/domain/analysis-plan.js';
import type { CodexModelUsage } from '../src/domain/quota.js';

const executeFile = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let processFailureCode: string | undefined;
let stdoutObserverFailed = false;
let structuredOutputInvalid = false;

async function git(args: string[], cwd = projectRoot): Promise<string> {
  const result = await executeFile('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1_024,
  });
  return result.stdout.trim();
}

async function run(): Promise<void> {
  if (process.env.DELIVERY_LOOP_CODEX_ANALYSIS_E2E !== '1') {
    console.error('real-codex-analysis: opt-in missing');
    process.exitCode = 2;
    return;
  }
  const providerBaseUrl = process.env.OPENAI_BASE_URL;
  const model = process.env.DELIVERY_LOOP_CODEX_ADAPTER_MODEL;
  const reasoningEffort = process.env.DELIVERY_LOOP_CODEX_ANALYSIS_REASONING_EFFORT;
  if (
    process.env.CODEX_API_KEY === undefined || process.env.CODEX_API_KEY.length === 0 ||
    providerBaseUrl === undefined || providerBaseUrl.length === 0 ||
    model === undefined || model.length === 0 || reasoningEffort !== 'medium'
  ) {
    console.error('real-codex-analysis: prerequisite missing');
    process.exitCode = 2;
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-real-analysis-'));
  const workspacePath = join(root, 'repo');
  const contextRoot = join(workspacePath, '.delivery-loop-analysis-context-preflight');
  const contextFilePath = join(contextRoot, 'context.json');
  const outputFilePath = join(root, 'plan.json');
  const analysisOutputSchemaPath = join(root, 'analysis-agent-output-schema.json');
  const mediationContextFilePath = join(root, 'diagnostic-context.json');
  const logRequestOutputFilePath = join(root, 'diagnostic-log-request.json');
  const traceRequestOutputFilePath = join(root, 'diagnostic-trace-request.json');
  const logRequestSchemaPath = join(root, 'diagnostic-log-request-schema.json');
  const traceRequestSchemaPath = join(root, 'diagnostic-trace-request-schema.json');
  const diagnosticRootCauseSchemaPath = join(root, 'diagnostic-root-cause-schema.json');
  await mkdir(workspacePath, { mode: 0o700 });
  await mkdir(contextRoot, { mode: 0o700 });
  await mkdir(join(workspacePath, 'src'), { mode: 0o700 });
  await git(['init', '--initial-branch=main'], workspacePath);
  await git(['config', 'user.name', 'Delivery Loop E2E'], workspacePath);
  await git(['config', 'user.email', 'delivery-loop-e2e@example.test'], workspacePath);
  await writeFile(
    join(workspacePath, 'README.md'),
    '# Delivery fixture\n\nThe repository needs one read-only inspection plan with source evidence.\n',
    { mode: 0o600, flag: 'wx' },
  );
  await writeFile(
    join(workspacePath, 'src/request.ts'),
    "export function handleRequest(): { outcome: 'synthetic-failure' } {\n  return { outcome: 'synthetic-failure' };\n}\n",
    { mode: 0o600, flag: 'wx' },
  );
  await git(['add', 'README.md', 'src/request.ts'], workspacePath);
  await git(['commit', '-m', 'create analysis fixture'], workspacePath);
  const baseSha = await git(['rev-parse', 'HEAD'], workspacePath);
  const statusBefore = await git(
    ['status', '--porcelain=v1', '--untracked-files=all'],
    workspacePath,
  );
  if (!/^[a-f0-9]{40}$/.test(baseSha) || statusBefore !== '') {
    throw new Error('workspace_precondition_failed');
  }
  const context = {
    schemaVersion: '1',
    task: {
      source: { system: 'manual', revision: 'provider-analysis-preflight-v1' },
      intent: {
        kind: 'requirement',
        description: 'Inspect this repository and propose a read-only delivery execution plan.',
        acceptanceCriteria: ['The plan cites repository evidence and performs no write effect.'],
      },
    },
    planPolicy: {
      version: 1,
      allowedEffects: ['repo_read'],
      allowedCommandRefs: ['policy:inspect'],
      requiresRepositoryChange: false,
    },
  };
  await writeFile(
    contextFilePath,
    JSON.stringify(await createAnalysisContextFileV1(context)),
    { mode: 0o600, flag: 'wx' },
  );
  await writeFile(outputFilePath, '', { mode: 0o600, flag: 'wx' });
  await writeFile(
    analysisOutputSchemaPath,
    JSON.stringify(ANALYSIS_AGENT_OUTPUT_V1_JSON_SCHEMA),
    { mode: 0o600, flag: 'wx' },
  );
  await chmod(contextFilePath, 0o600);
  await chmod(outputFilePath, 0o600);

  let usage: CodexModelUsage | undefined;
  const adapter = new CodexAnalysisAdapter({
    outputSchemaPath: analysisOutputSchemaPath,
    providerBaseUrl,
    reasoningEffort,
    execute: async (request) => {
      const observe = request.onStdoutLine;
      const result = await executeCommand({
        ...request,
        ...(observe === undefined
          ? {}
          : {
              onStdoutLine: (line: string) => {
                try {
                  observe(line);
                } catch {
                  stdoutObserverFailed = true;
                  throw new Error('stdout_observer_failed');
                }
              },
            }),
      });
      if (result.exitCode !== 0) {
        processFailureCode = stdoutObserverFailed
          ? 'jsonl_usage_rejected'
          : classifyAnalysisProviderProcessFailure(result.stderr);
      } else if (
        request.args[request.args.indexOf('--output-schema') + 1] ===
          analysisOutputSchemaPath
      ) {
        try {
          const raw = JSON.parse(await readFile(outputFilePath, 'utf8')) as unknown;
          const parsed = AnalysisAgentOutputV1Schema.safeParse(raw);
          if (!parsed.success) structuredOutputInvalid = true;
        } catch {
          structuredOutputInvalid = true;
        }
      }
      return result;
    },
  });
  let plan: Awaited<ReturnType<CodexAnalysisAdapter['start']>>;
  let diagnosticPlan: Awaited<ReturnType<CodexAnalysisAdapter['start']>>;
  const diagnosticUsages: CodexModelUsage[] = [];
  let diagnosticFinished = false;
  try {
    plan = await adapter.start({
      workspacePath,
      contextFilePath,
      outputFilePath,
      timeoutMs: 10 * 60_000,
      identity: {
        planId: 'plan-provider-analysis-preflight-v1',
        runId: 'run-provider-analysis-preflight-v1',
        version: 1,
        taskRevision: 'provider-analysis-preflight-v1',
        baseSha,
        attemptId: 'attempt-provider-analysis-preflight-v1',
      },
      validation: {
        runId: 'run-provider-analysis-preflight-v1',
        taskRevision: 'provider-analysis-preflight-v1',
        baseSha,
        expectedVersion: 1,
        acceptanceCriteriaCount: 1,
        allowedEffects: ['repo_read'],
        allowedCommandRefs: ['policy:inspect'],
        requiresRepositoryChange: false,
      },
      model,
      onUsage: (value) => { usage = value; },
    });
    const diagnosticContext = {
      schemaVersion: '1',
      task: {
        source: { system: 'manual', revision: 'provider-diagnostic-preflight-v1' },
        intent: {
          kind: 'bug',
          description: [
            'Investigate a synthetic failed request.',
            'Use uid=preflight-user, cid=preflight-conversation, and path=/v1/preflight.',
          ].join(' '),
          acceptanceCriteria: [
            'The plan binds a source-backed root cause without any repository write.',
          ],
        },
      },
      planPolicy: {
        version: 1,
        allowedEffects: ['repo_read', 'logs_read'],
        allowedCommandRefs: ['policy:diagnose'],
        requiresRepositoryChange: false,
      },
    };
    await Promise.all([
      writeFile(
        contextFilePath,
        JSON.stringify(await createAnalysisContextFileV1(diagnosticContext)),
        { mode: 0o600 },
      ),
      writeFile(outputFilePath, '', { mode: 0o600 }),
      writeFile(mediationContextFilePath, '', { mode: 0o600, flag: 'wx' }),
      writeFile(logRequestOutputFilePath, '', { mode: 0o600, flag: 'wx' }),
      writeFile(traceRequestOutputFilePath, '', { mode: 0o600, flag: 'wx' }),
      writeFile(
        logRequestSchemaPath,
        JSON.stringify(DIAGNOSTIC_LOG_SEARCH_REQUEST_V1_JSON_SCHEMA),
        { mode: 0o600, flag: 'wx' },
      ),
      writeFile(
        traceRequestSchemaPath,
        JSON.stringify(DIAGNOSTIC_TRACE_REQUEST_V1_JSON_SCHEMA),
        { mode: 0o600, flag: 'wx' },
      ),
      writeFile(
        diagnosticRootCauseSchemaPath,
        JSON.stringify(DIAGNOSTIC_ROOT_CAUSE_RESULT_V1_JSON_SCHEMA),
        { mode: 0o600, flag: 'wx' },
      ),
    ]);
    diagnosticPlan = await adapter.start({
      workspacePath,
      contextFilePath,
      outputFilePath,
      timeoutMs: 10 * 60_000,
      identity: {
        planId: 'plan-provider-diagnostic-preflight-v1',
        runId: 'run-provider-diagnostic-preflight-v1',
        version: 1,
        taskRevision: 'provider-diagnostic-preflight-v1',
        baseSha,
        attemptId: 'attempt-provider-diagnostic-preflight-v1',
      },
      validation: {
        runId: 'run-provider-diagnostic-preflight-v1',
        taskRevision: 'provider-diagnostic-preflight-v1',
        baseSha,
        expectedVersion: 1,
        acceptanceCriteriaCount: 1,
        allowedEffects: ['repo_read', 'logs_read'],
        allowedCommandRefs: ['policy:diagnose'],
        requiresRepositoryChange: false,
      },
      model,
      onUsage: (value) => { diagnosticUsages.push(value); },
      diagnostic: {
        mediationContextFilePath,
        logRequestOutputFilePath,
        traceRequestOutputFilePath,
        logRequestSchemaPath,
        traceRequestSchemaPath,
        rootCauseSchemaPath: diagnosticRootCauseSchemaPath,
        mediation: {
          async searchLogs() {
            return { entries: [{ requestId: 'preflight-request' }] };
          },
          async getTrace() {
            return {
              spans: [{
                service: 'preflight-service',
                outcome: 'synthetic-failure',
                codeRef: { path: 'src/request.ts', symbol: 'handleRequest' },
              }],
            };
          },
          async finish() { diagnosticFinished = true; },
        },
      },
    });
  } finally {
    await rm(contextRoot, { recursive: true, force: true });
  }
  const [statusAfter, output] = await Promise.all([
    git(['status', '--porcelain=v1', '--untracked-files=all'], workspacePath),
    readFile(outputFilePath, 'utf8'),
  ]);
  if (
    statusAfter !== '' || output.length === 0 || usage === undefined ||
    plan.items.length === 0 || plan.evidenceRefs.length === 0 ||
    plan.items.some((item) => item.effects.some((effect) => effect !== 'repo_read')) ||
    diagnosticPlan.items.length === 0 || diagnosticUsages.length !== 4 ||
    !diagnosticFinished || diagnosticPlan.items.some((item) =>
      item.effects.some((effect) => effect !== 'repo_read' && effect !== 'logs_read'))
  ) throw new Error('analysis_contract_failed');

  process.stdout.write(JSON.stringify({
    schemaVersion: '1',
    status: 'passed',
    planDigest: plan.digest,
    diagnosticPlanDigest: diagnosticPlan.digest,
    itemCount: plan.items.length,
    evidenceRefCount: plan.evidenceRefs.length,
    repositoryClean: true,
    usageRecorded: true,
    diagnosticSchemaVerified: true,
    diagnosticUsageRecords: diagnosticUsages.length,
  }) + '\n');
}

try {
  await run();
} catch (error) {
  let failure: Record<string, string>;
  if (error instanceof CodexAnalysisAdapterError) {
    failure = {
      failureKind: error.kind,
      failureStage: error.stage,
      ...(error.kind === 'process_nonzero_exit'
        ? { providerFailureCode: error.providerFailureCode ?? 'provider_process_failed' }
        : {}),
    };
  } else {
    const message = error instanceof Error ? error.message : '';
    const failureCode = message === 'workspace_precondition_failed'
      ? 'workspace_precondition_failed'
      : message === 'analysis_contract_failed'
        ? 'analysis_contract_failed'
        : processFailureCode ?? (structuredOutputInvalid
          ? 'structured_output_invalid'
          : 'analysis_adapter_failed');
    failure = { failureCode };
  }
  console.error(`real-codex-analysis: FAIL ${JSON.stringify(failure)}`);
  process.exitCode = 1;
}
