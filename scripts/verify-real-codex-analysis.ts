import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CodexAnalysisAdapter,
  executeCommand,
} from '../src/agent/codex-analysis-adapter.js';
import {
  classifyProviderProcessFailure,
} from '../src/agent/provider-preflight-failure.js';
import {
  ANALYSIS_AGENT_OUTPUT_V1_JSON_SCHEMA,
  AnalysisAgentOutputV1Schema,
  createAnalysisContextFileV1,
} from '../src/domain/analysis-plan.js';
import { ExecutionPlanValidationError } from '../src/domain/plan.js';
import type { CodexModelUsage } from '../src/domain/quota.js';

const executeFile = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let processFailureCode: string | undefined;
let stdoutObserverFailed = false;
let structuredOutputIssueCode: string | undefined;

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
  await mkdir(workspacePath, { mode: 0o700 });
  await mkdir(contextRoot, { mode: 0o700 });
  await git(['init', '--initial-branch=main'], workspacePath);
  await git(['config', 'user.name', 'Delivery Loop E2E'], workspacePath);
  await git(['config', 'user.email', 'delivery-loop-e2e@example.test'], workspacePath);
  await writeFile(
    join(workspacePath, 'README.md'),
    '# Delivery fixture\n\nThe repository needs one read-only inspection plan with source evidence.\n',
    { mode: 0o600, flag: 'wx' },
  );
  await git(['add', 'README.md'], workspacePath);
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
        const sample = result.stderr ?? '';
        processFailureCode = stdoutObserverFailed
          ? 'jsonl_usage_rejected'
          : /uniqueItems/i.test(sample)
          ? 'provider_schema_unique_items_rejected'
          : /(?:minLength|maxLength|minItems|maxItems|minimum|maximum)/i.test(sample)
            ? 'provider_schema_bounds_rejected'
            : /\brequired\b/i.test(sample)
              ? 'provider_schema_required_rejected'
              : /(?:json[_ -]schema|\bschema\b|response[_ -]?format)/i.test(sample)
                ? 'provider_output_schema_rejected'
                : /(?:status(?: code)?|http(?:\/\d(?:\.\d)?)?|response)[^\d]{0,12}400\b|\b400 bad request\b/i
                    .test(sample)
                  ? 'provider_invalid_request'
                  : classifyProviderProcessFailure(sample);
      } else {
        try {
          const raw = JSON.parse(await readFile(outputFilePath, 'utf8')) as unknown;
          const parsed = AnalysisAgentOutputV1Schema.safeParse(raw);
          if (!parsed.success) {
            structuredOutputIssueCode = [...new Set(parsed.error.issues.map((issue) => {
              const path = issue.path.map((part) => typeof part === 'number' ? '*' : part).join('.');
              return `${path}_${issue.code}`;
            }))].sort().join('__');
          }
        } catch {
          structuredOutputIssueCode = 'json_parse_failed';
        }
      }
      return result;
    },
  });
  let plan: Awaited<ReturnType<CodexAnalysisAdapter['start']>>;
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
    plan.items.some((item) => item.effects.some((effect) => effect !== 'repo_read'))
  ) throw new Error('analysis_contract_failed');

  process.stdout.write(JSON.stringify({
    schemaVersion: '1',
    status: 'passed',
    planDigest: plan.digest,
    itemCount: plan.items.length,
    evidenceRefCount: plan.evidenceRefs.length,
    repositoryClean: true,
    usageRecorded: true,
  }) + '\n');
}

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const validationCodes = error instanceof ExecutionPlanValidationError
    ? [...new Set(error.issues.map((issue) => issue.code))].sort().join('_')
    : '';
  const code = validationCodes !== ''
    ? `plan_validation_${validationCodes}`
    : message === 'workspace_precondition_failed'
    ? 'workspace_precondition_failed'
    : message === 'analysis_contract_failed'
      ? 'analysis_contract_failed'
    : message === 'Codex analysis process timed out'
      ? 'provider_timeout'
    : message === 'Codex analysis process could not be started'
        ? 'provider_process_start_failed'
    : /^Codex analysis process failed with exit code [0-9]+$/.test(message)
          ? processFailureCode ?? 'provider_process_failed'
          : message === 'Codex analysis usage is unavailable'
            ? 'usage_unavailable'
            : message === 'Codex analysis output is invalid'
              ? `structured_output_invalid_${structuredOutputIssueCode ?? 'unknown'}`
            : message === 'Codex analysis context proof is invalid'
              ? 'context_proof_invalid'
              : message.startsWith('ExecutionPlan validation failed with ')
                ? 'plan_validation_failed'
                : 'analysis_adapter_failed';
  console.error(`real-codex-analysis: FAIL ${code}`);
  process.exitCode = 1;
}
