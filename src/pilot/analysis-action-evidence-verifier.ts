import { parseDocument } from 'yaml';
import { canonicalSha256 } from '../domain/digest.js';
import {
  ANALYSIS_RUNNER_CONTRACT_PATHS,
  AnalysisActionEvidenceManifestV1Schema,
  type AnalysisActionEvidenceManifestV1,
} from '../domain/analysis-action-evidence.js';
import { PlanItemV1Schema } from '../domain/plan.js';
import { TRIAGE_TOOL_ACTIONS } from '../domain/tool-bridge.js';
import {
  GitHubAppDispatchEvidenceVerificationError,
  verifyGitHubAppDispatchEvidence,
  type GitHubAppDispatchEvidenceVerifierOptions,
} from './github-app-dispatch-evidence-verifier.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,20000}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const MAX_SOURCE_BYTES = 768 * 1_024;
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const CONTEXT_ACTIONS = {
  repository: 'repo:read',
  logs: 'logs:read',
  traces: 'trace:read',
  k8s: 'k8s:read',
  database: 'database:diagnostic',
} as const;

export type AnalysisActionEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'dispatch_evidence_mismatch'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'task_projection_mismatch'
  | 'plan_projection_mismatch'
  | 'context_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'runner_contract_mismatch';

export class AnalysisActionEvidenceVerificationError extends Error {
  constructor(readonly code: AnalysisActionEvidenceVerificationErrorCode) {
    super(`Analysis Action evidence verification failed: ${code}`);
    this.name = 'AnalysisActionEvidenceVerificationError';
  }
}

export interface AnalysisActionEvidenceVerifierOptions extends
  GitHubAppDispatchEvidenceVerifierOptions {
  expectedRunnerContractDigest: string;
}

export interface AnalysisActionEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  runId: string;
  actionRunId: string;
  taskInputClass: 'user_feedback' | 'prd';
  planId: string;
  planVersion: number;
  evidenceRefCount: number;
  itemCount: number;
  contextCategories: string[];
  contextCallCount: number;
  codexVersion: string;
  runnerContractDigest: string;
  immutableHeadVerified: true;
  detachedHeadVerified: true;
  repositoryCleanVerified: true;
  repositoryWriteCredentials: 0;
}

type Source = 'control_plane' | 'github';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function recordArray(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const values = value.map(record);
  return values.every((entry): entry is Record<string, unknown> => entry !== null)
    ? values : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new AnalysisActionEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new AnalysisActionEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

async function readBounded(response: Response): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function unavailableCode(source: Source): AnalysisActionEvidenceVerificationErrorCode {
  return source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable';
}

function invalidCode(source: Source): AnalysisActionEvidenceVerificationErrorCode {
  return source === 'control_plane'
    ? 'control_plane_response_invalid' : 'github_response_invalid';
}

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  source: Source,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: {
        accept: source === 'github' ? 'application/vnd.github+json' : 'application/json',
        authorization: `Bearer ${token}`,
        ...(source === 'github' ? { 'x-github-api-version': '2022-11-28' } : {}),
      },
      redirect: 'error',
    });
  } catch { throw new AnalysisActionEvidenceVerificationError(unavailableCode(source)); }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new AnalysisActionEvidenceVerificationError(unavailableCode(source));
  }
  if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new AnalysisActionEvidenceVerificationError(invalidCode(source));
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new AnalysisActionEvidenceVerificationError(invalidCode(source));
  }
  const bytes = await readBounded(response);
  if (bytes === null) throw new AnalysisActionEvidenceVerificationError(invalidCode(source));
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new AnalysisActionEvidenceVerificationError(invalidCode(source)); }
}

function decodeSource(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AnalysisActionEvidenceVerificationError('runner_contract_mismatch');
  }
  try {
    const binary = atob(raw.replaceAll(/\s/g, ''));
    if (binary.length > MAX_SOURCE_BYTES) throw new Error('oversize');
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    throw new AnalysisActionEvidenceVerificationError('runner_contract_mismatch');
  }
}

function itemProjection(raw: Record<string, unknown>): unknown | null {
  if (!exactKeys(raw, [
    'id', 'kind', 'title', 'objective', 'required', 'status', 'progressVersion',
    'acceptanceCriteriaIndexes', 'doneWhen', 'dependsOn', 'effects', 'commandRefs',
    'evidenceKinds', 'externalFacts',
  ])) return null;
  const item = {
    id: raw.id,
    kind: raw.kind,
    title: raw.title,
    objective: raw.objective,
    acceptanceCriteriaIndexes: raw.acceptanceCriteriaIndexes,
    doneWhen: raw.doneWhen,
    verification: {
      commandRefs: raw.commandRefs,
      evidenceKinds: raw.evidenceKinds,
      externalFacts: raw.externalFacts,
    },
    effects: raw.effects,
    dependsOn: raw.dependsOn,
    required: raw.required,
  };
  const parsed = PlanItemV1Schema.safeParse(item);
  if (
    !parsed.success || !ITEM_ID_PATTERN.test(parsed.data.id) ||
    !['pending', 'ready'].includes(String(raw.status)) ||
    !Number.isSafeInteger(raw.progressVersion) || Number(raw.progressVersion) < 0
  ) return null;
  return parsed.data;
}

function graphHasCycle(items: Array<ReturnType<typeof PlanItemV1Schema.parse>>): boolean {
  const dependencies = new Map(items.map((item) => [item.id, item.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (dependencies.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return items.some((item) => visit(item.id));
}

async function verifyTaskAndPlan(
  taskRaw: unknown,
  planRaw: unknown,
  manifest: AnalysisActionEvidenceManifestV1,
): Promise<void> {
  const taskRoot = record(taskRaw);
  const task = taskRoot === null ? null : record(taskRoot.task);
  const taskRun = taskRoot === null ? null : record(taskRoot.run);
  const intent = task === null ? null : record(task.intent);
  const target = task === null ? null : record(task.target);
  const dispatch = manifest.dispatchEvidence.dispatch;
  if (
    taskRoot === null || task === null || taskRun === null || intent === null || target === null ||
    task.id !== manifest.task.taskId || task.digest !== dispatch.taskDigest ||
    taskRun.id !== dispatch.runId || target.repository !== manifest.dispatchEvidence.repository.fullName ||
    intent.kind !== manifest.task.intentKind ||
    intent.acceptanceCriteriaCount !== manifest.task.acceptanceCriteriaCount
  ) throw new AnalysisActionEvidenceVerificationError('task_projection_mismatch');

  const planRoot = record(planRaw);
  const run = planRoot === null ? null : record(planRoot.run);
  const plan = planRoot === null ? null : record(planRoot.plan);
  const items = planRoot === null ? null : recordArray(planRoot.items);
  if (
    planRoot === null || run === null || plan === null || items === null ||
    run.id !== dispatch.runId || run.taskId !== manifest.task.taskId ||
    plan.id !== dispatch.planId || plan.version !== dispatch.planVersion ||
    plan.digest !== dispatch.planDigest || plan.status !== 'active' ||
    typeof plan.objective !== 'string' || !/\S/.test(plan.objective) ||
    plan.assumptionCount !== manifest.plan.assumptionCount ||
    plan.evidenceRefCount !== manifest.plan.evidenceRefCount ||
    plan.evidenceRefsDigest !== manifest.plan.evidenceRefsDigest ||
    items.length !== manifest.plan.itemCount ||
    await canonicalSha256(plan.objective) !== manifest.plan.objectiveDigest ||
    await canonicalSha256(items) !== manifest.plan.itemsDigest
  ) throw new AnalysisActionEvidenceVerificationError('plan_projection_mismatch');

  const parsedItems = items.map(itemProjection);
  if (parsedItems.some((item) => item === null)) {
    throw new AnalysisActionEvidenceVerificationError('plan_projection_mismatch');
  }
  const typedItems = parsedItems as Array<ReturnType<typeof PlanItemV1Schema.parse>>;
  const ids = new Set(typedItems.map((item) => item.id));
  const covered = new Set(
    typedItems.filter((item) => item.required).flatMap((item) => item.acceptanceCriteriaIndexes),
  );
  if (
    ids.size !== typedItems.length || graphHasCycle(typedItems) ||
    typedItems.some((item) => item.dependsOn.some((dependency) => !ids.has(dependency))) ||
    typedItems.some((item) => item.acceptanceCriteriaIndexes.some(
      (index) => index >= manifest.task.acceptanceCriteriaCount,
    )) ||
    Array.from({ length: manifest.task.acceptanceCriteriaCount }, (_, index) => index)
      .some((index) => !covered.has(index))
  ) throw new AnalysisActionEvidenceVerificationError('plan_projection_mismatch');
}

async function verifyReadOnlyContext(
  auditRaw: unknown,
  manifest: AnalysisActionEvidenceManifestV1,
): Promise<void> {
  const root = record(auditRaw);
  const answers = root === null ? null : record(root.answers);
  const permissions = answers === null ? null : record(answers.permissions);
  const reads = answers === null ? null : recordArray(answers.contextReads);
  const grants = permissions === null ? null : recordArray(permissions.grants);
  const credentials = permissions === null
    ? null : recordArray(permissions.repositoryWriteCredentials);
  const attemptId = manifest.dispatchEvidence.dispatch.attemptId;
  if (
    root === null || answers === null || permissions === null || reads === null ||
    grants === null || credentials === null || root.schemaVersion !== '1' ||
    root.runId !== manifest.dispatchEvidence.dispatch.runId || reads.length < 1 ||
    credentials.some((credential) => credential.attemptId === attemptId)
  ) throw new AnalysisActionEvidenceVerificationError('context_projection_mismatch');

  const categories: string[] = [];
  let totalCalls = 0;
  let successfulCalls = 0;
  let deniedCalls = 0;
  for (const read of reads) {
    if (!exactKeys(read, [
      'category', 'action', 'effect', 'totalCalls', 'successfulCalls', 'deniedCalls',
      'attemptIds', 'firstObservedAt', 'lastObservedAt',
    ])) throw new AnalysisActionEvidenceVerificationError('context_projection_mismatch');
    const category = read.category;
    const attemptIds = read.attemptIds;
    if (
      typeof category !== 'string' || !(category in CONTEXT_ACTIONS) ||
      read.action !== CONTEXT_ACTIONS[category as keyof typeof CONTEXT_ACTIONS] ||
      read.effect !== 'read' || !Number.isSafeInteger(read.totalCalls) ||
      Number(read.totalCalls) <= 0 || read.successfulCalls !== read.totalCalls ||
      read.deniedCalls !== 0 || !Array.isArray(attemptIds) ||
      attemptIds.length !== 1 || attemptIds[0] !== attemptId ||
      typeof read.firstObservedAt !== 'string' || typeof read.lastObservedAt !== 'string' ||
      !Number.isFinite(Date.parse(read.firstObservedAt)) ||
      !Number.isFinite(Date.parse(read.lastObservedAt)) ||
      Date.parse(read.firstObservedAt) > Date.parse(read.lastObservedAt)
    ) throw new AnalysisActionEvidenceVerificationError('context_projection_mismatch');
    categories.push(category);
    totalCalls += Number(read.totalCalls);
    successfulCalls += Number(read.successfulCalls);
    deniedCalls += Number(read.deniedCalls);
  }
  categories.sort();
  if (
    new Set(categories).size !== categories.length || !categories.includes('repository') ||
    JSON.stringify(categories) !== JSON.stringify(manifest.context.categories) ||
    totalCalls !== manifest.context.totalCalls ||
    successfulCalls !== manifest.context.successfulCalls ||
    deniedCalls !== manifest.context.deniedCalls ||
    await canonicalSha256(reads) !== manifest.context.contextReadsDigest
  ) throw new AnalysisActionEvidenceVerificationError('context_projection_mismatch');

  const attemptGrants = grants.filter((grant) => grant.attemptId === attemptId);
  if (
    attemptGrants.length < 1 || attemptGrants.some((grant) =>
      !Array.isArray(grant.scopes) ||
      JSON.stringify(grant.scopes) !== JSON.stringify(TRIAGE_TOOL_ACTIONS))
  ) throw new AnalysisActionEvidenceVerificationError('context_projection_mismatch');
}

function runnerShapeMatches(sources: ReadonlyMap<string, string>, codexVersion: string): boolean {
  const entrypoint = sources.get('scripts/run-analysis-attempt.ts') ?? '';
  const runner = sources.get('src/runner/analysis-runner.ts') ?? '';
  const adapter = sources.get('src/agent/codex-analysis-adapter.ts') ?? '';
  const schemaSource = sources.get('schemas/analysis-plan-content-v1.schema.json') ?? '';
  const packageSource = sources.get('package.json') ?? '';
  const lockSource = sources.get('pnpm-lock.yaml') ?? '';
  let packageJson: Record<string, unknown>;
  let schema: Record<string, unknown>;
  let lock: Record<string, unknown>;
  try {
    const parsedPackage = record(JSON.parse(packageSource) as unknown);
    const parsedSchema = record(JSON.parse(schemaSource) as unknown);
    const document = parseDocument(lockSource, { uniqueKeys: true });
    const parsedLock = document.errors.length === 0 ? record(document.toJS()) : null;
    if (parsedPackage === null || parsedSchema === null || parsedLock === null) return false;
    packageJson = parsedPackage;
    schema = parsedSchema;
    lock = parsedLock;
  } catch { return false; }
  const devDependencies = record(packageJson.devDependencies);
  const importers = record(lock.importers);
  const rootImporter = importers === null ? null : record(importers['.']);
  const lockDevDependencies = rootImporter === null ? null : record(rootImporter.devDependencies);
  const lockedCodex = lockDevDependencies === null ? null : record(lockDevDependencies['@openai/codex']);
  const required = schema.required;
  const properties = record(schema.properties);
  return devDependencies?.['@openai/codex'] === codexVersion &&
    lockedCodex?.specifier === codexVersion && lockedCodex.version === codexVersion &&
    Array.isArray(required) && ['objective', 'assumptions', 'evidenceRefs', 'items']
      .every((field) => required.includes(field)) && properties?.evidenceRefs !== undefined &&
    entrypoint.includes('AnalysisRunnerError,') &&
    entrypoint.includes('runAnalysisAttempt,') &&
    entrypoint.includes('await runAnalysisAttempt()') &&
    entrypoint.includes('error instanceof AnalysisRunnerError') &&
    entrypoint.includes('classification?.kind') &&
    entrypoint.includes('classification?.stage') &&
    entrypoint.includes('classification?.providerFailureCode') &&
    runner.includes('new CodexAnalysisAdapter({') &&
    runner.includes('error instanceof CodexAnalysisAdapterError') &&
    runner.includes('kind: error.kind') && runner.includes('stage: error.stage') &&
    runner.includes('providerFailureCode: error.providerFailureCode') &&
    runner.includes('/context`') && runner.includes('/plan`') &&
    runner.includes("this.callTool('logs/search'") &&
    runner.includes("this.callTool('traces/get'") &&
    runner.includes('/diagnostic-evidence`') &&
    runner.includes('diagnosticMediation.agentInterface()') &&
    runner.includes('DIAGNOSTIC_EVIDENCE_REF_PATTERN.test(ref)') &&
    runner.includes('const beforeSnapshot = await snapshotWorkspace') &&
    runner.includes('const afterSnapshot = await snapshotWorkspace') &&
    runner.includes('afterSnapshot !== beforeSnapshot') &&
    adapter.includes("'--ephemeral'") && adapter.includes("'--ignore-user-config'") &&
    adapter.includes("'--sandbox'") && adapter.includes("'read-only'") &&
    adapter.includes('approval_policy="never"') &&
    adapter.includes('CODEX_ANALYSIS_FAILURE_KINDS') &&
    adapter.includes('CODEX_ANALYSIS_FAILURE_STAGES') &&
    adapter.includes('classifyAnalysisProviderProcessFailure(result.stderr)') &&
    adapter.includes("this.name = 'CodexAnalysisAdapterError'") &&
    adapter.includes("'--output-schema'") && adapter.includes("'--output-last-message'") &&
    adapter.includes('diagnostic.mediation.searchLogs(logRequest)') &&
    adapter.includes('diagnostic.mediation.getTrace(traceRequest)') &&
    adapter.includes('diagnostic.mediation.finish(diagnosticResult.rootCause)');
}

async function verifyRunnerContract(
  fetcher: typeof fetch,
  githubOrigin: string,
  manifest: AnalysisActionEvidenceManifestV1,
  token: string,
  expectedDigest: string,
): Promise<void> {
  const repository = manifest.dispatchEvidence.repository.fullName;
  const sources = new Map<string, string>();
  for (const file of manifest.runner.files) {
    const contentPath = file.path.split('/').map(encodeURIComponent).join('/');
    const raw = record(await getJson(
      fetcher,
      `${githubOrigin}/repos/${repository}/contents/${contentPath}?` +
        `ref=${encodeURIComponent(manifest.runner.sourceSha)}`,
      token,
      'github',
    ));
    if (
      raw === null || raw.type !== 'file' || raw.path !== file.path ||
      raw.sha !== file.blobSha || raw.encoding !== 'base64'
    ) throw new AnalysisActionEvidenceVerificationError('runner_contract_mismatch');
    const source = decodeSource(raw.content);
    if (await canonicalSha256(source) !== file.contentDigest) {
      throw new AnalysisActionEvidenceVerificationError('runner_contract_mismatch');
    }
    sources.set(file.path, source);
  }
  const contractDigest = await canonicalSha256({
    sourceSha: manifest.runner.sourceSha,
    codexVersion: manifest.runner.codexVersion,
    files: manifest.runner.files,
  });
  if (
    ANALYSIS_RUNNER_CONTRACT_PATHS.some((path) => !sources.has(path)) ||
    contractDigest !== manifest.runner.contractDigest || contractDigest !== expectedDigest ||
    !runnerShapeMatches(sources, manifest.runner.codexVersion)
  ) throw new AnalysisActionEvidenceVerificationError('runner_contract_mismatch');
}

export async function verifyAnalysisActionEvidence(
  input: AnalysisActionEvidenceManifestV1,
  options: AnalysisActionEvidenceVerifierOptions,
): Promise<AnalysisActionEvidenceVerificationSummary> {
  const parsed = AnalysisActionEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new AnalysisActionEvidenceVerificationError('manifest_invalid');
  if (
    !TOKEN_PATTERN.test(options.controlPlaneToken) ||
    !TOKEN_PATTERN.test(options.operationsToken) ||
    !TOKEN_PATTERN.test(options.githubAppJwt) ||
    !TOKEN_PATTERN.test(options.githubInstallationToken) ||
    !DIGEST_PATTERN.test(options.expectedRunnerContractDigest)
  ) throw new AnalysisActionEvidenceVerificationError('configuration_invalid');
  const manifest = parsed.data;
  const controlOrigin = safeOrigin(options.controlPlaneOrigin);
  const githubOrigin = safeOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;

  try {
    await verifyGitHubAppDispatchEvidence(manifest.dispatchEvidence, {
      controlPlaneOrigin: controlOrigin,
      controlPlaneToken: options.controlPlaneToken,
      operationsToken: options.operationsToken,
      githubAppJwt: options.githubAppJwt,
      githubInstallationToken: options.githubInstallationToken,
      githubApiOrigin: githubOrigin,
      fetch: fetcher,
    });
  } catch (error) {
    if (error instanceof GitHubAppDispatchEvidenceVerificationError) {
      throw new AnalysisActionEvidenceVerificationError('dispatch_evidence_mismatch');
    }
    throw error;
  }

  const dispatch = manifest.dispatchEvidence.dispatch;
  const [taskRaw, planRaw, auditRaw] = await Promise.all([
    getJson(
      fetcher,
      `${controlOrigin}/v1/tasks/${manifest.task.taskId}`,
      options.controlPlaneToken,
      'control_plane',
    ),
    getJson(
      fetcher,
      `${controlOrigin}/v1/runs/${dispatch.runId}/plan`,
      options.controlPlaneToken,
      'control_plane',
    ),
    getJson(
      fetcher,
      `${controlOrigin}/v1/runs/${dispatch.runId}/audit`,
      options.operationsToken,
      'control_plane',
    ),
  ]);
  await verifyTaskAndPlan(taskRaw, planRaw, manifest);
  await verifyReadOnlyContext(auditRaw, manifest);
  await verifyRunnerContract(
    fetcher,
    githubOrigin,
    manifest,
    options.githubInstallationToken,
    options.expectedRunnerContractDigest,
  );

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    repository: manifest.dispatchEvidence.repository.fullName,
    runId: dispatch.runId,
    actionRunId: dispatch.actionRunId,
    taskInputClass: manifest.task.inputClass,
    planId: dispatch.planId,
    planVersion: dispatch.planVersion,
    evidenceRefCount: manifest.plan.evidenceRefCount,
    itemCount: manifest.plan.itemCount,
    contextCategories: [...manifest.context.categories],
    contextCallCount: manifest.context.totalCalls,
    codexVersion: manifest.runner.codexVersion,
    runnerContractDigest: manifest.runner.contractDigest,
    immutableHeadVerified: true,
    detachedHeadVerified: true,
    repositoryCleanVerified: true,
    repositoryWriteCredentials: 0,
  };
}
