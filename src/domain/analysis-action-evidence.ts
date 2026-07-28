import { z } from 'zod';
import { GitHubAppDispatchEvidenceManifestV1Schema } from
  './github-app-dispatch-evidence.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;

export const ANALYSIS_RUNNER_CONTRACT_PATHS = [
  'scripts/run-analysis-attempt.ts',
  'src/runner/analysis-runner.ts',
  'src/agent/codex-analysis-adapter.ts',
  'src/domain/analysis-plan.ts',
  'src/domain/plan.ts',
  'schemas/analysis-plan-content-v1.schema.json',
  'package.json',
  'pnpm-lock.yaml',
] as const;

const RunnerFileSchema = (path: typeof ANALYSIS_RUNNER_CONTRACT_PATHS[number]) => z.object({
  path: z.literal(path),
  blobSha: z.string().regex(SHA_PATTERN),
  contentDigest: z.string().regex(DIGEST_PATTERN),
}).strict();

const ContextCategorySchema = z.enum(['repository', 'logs', 'traces', 'k8s', 'database']);

export const AnalysisActionEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: z.iso.datetime({ offset: true }),
  dispatchEvidence: GitHubAppDispatchEvidenceManifestV1Schema,
  task: z.object({
    taskId: z.string().regex(ID_PATTERN),
    inputClass: z.enum(['user_feedback', 'prd']),
    intentKind: z.enum(['bug', 'requirement']),
    acceptanceCriteriaCount: z.number().int().positive().max(10_000),
  }).strict(),
  plan: z.object({
    objectiveDigest: z.string().regex(DIGEST_PATTERN),
    assumptionCount: z.number().int().nonnegative().max(100),
    evidenceRefCount: z.number().int().positive().max(200),
    evidenceRefsDigest: z.string().regex(DIGEST_PATTERN),
    itemCount: z.number().int().positive().max(200),
    itemsDigest: z.string().regex(DIGEST_PATTERN),
  }).strict(),
  context: z.object({
    categories: z.array(ContextCategorySchema).min(1).max(5),
    totalCalls: z.number().int().positive(),
    successfulCalls: z.number().int().positive(),
    deniedCalls: z.literal(0),
    contextReadsDigest: z.string().regex(DIGEST_PATTERN),
  }).strict(),
  runner: z.object({
    sourceSha: z.string().regex(SHA_PATTERN),
    codexVersion: z.string().regex(VERSION_PATTERN),
    contractDigest: z.string().regex(DIGEST_PATTERN),
    files: z.tuple([
      RunnerFileSchema('scripts/run-analysis-attempt.ts'),
      RunnerFileSchema('src/runner/analysis-runner.ts'),
      RunnerFileSchema('src/agent/codex-analysis-adapter.ts'),
      RunnerFileSchema('src/domain/analysis-plan.ts'),
      RunnerFileSchema('src/domain/plan.ts'),
      RunnerFileSchema('schemas/analysis-plan-content-v1.schema.json'),
      RunnerFileSchema('package.json'),
      RunnerFileSchema('pnpm-lock.yaml'),
    ]),
  }).strict(),
  workspace: z.object({
    checkoutSha: z.string().regex(SHA_PATTERN),
    finalHeadSha: z.string().regex(SHA_PATTERN),
    detachedHead: z.literal(true),
    repositoryClean: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const dispatch = manifest.dispatchEvidence.dispatch;
  const expectedIntent = manifest.task.inputClass === 'user_feedback' ? 'bug' : 'requirement';
  const categories = [...manifest.context.categories].sort();
  if (
    manifest.task.intentKind !== expectedIntent ||
    Date.parse(manifest.recordedAt) < Date.parse(manifest.dispatchEvidence.recordedAt) ||
    manifest.runner.sourceSha !== dispatch.baseSha ||
    manifest.workspace.checkoutSha !== dispatch.baseSha ||
    manifest.workspace.finalHeadSha !== dispatch.baseSha ||
    !manifest.context.categories.includes('repository') ||
    (manifest.task.intentKind === 'bug' &&
      (!manifest.context.categories.includes('logs') ||
        !manifest.context.categories.includes('traces'))) ||
    new Set(manifest.context.categories).size !== manifest.context.categories.length ||
    categories.some((category, index) => category !== manifest.context.categories[index]) ||
    manifest.context.totalCalls !== manifest.context.successfulCalls
  ) context.addIssue({ code: 'custom', message: 'analysis Action evidence is inconsistent' });
});

export type AnalysisActionEvidenceManifestV1 = z.infer<
  typeof AnalysisActionEvidenceManifestV1Schema
>;
