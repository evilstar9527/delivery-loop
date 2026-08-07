import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { DiagnosticRootCauseV1Schema } from '../src/domain/diagnostic-evidence.js';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}

interface Workflow {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, {
    permissions?: Record<string, string>;
    environment?: string;
    steps: WorkflowStep[];
  }>;
}

describe('Codex provider preflight workflow', () => {
  it('uses a manual, read-only, exact-model provider probe without task or dispatch inputs', () => {
    const workflow = parse(readFileSync(
      new URL('../.github/workflows/codex-provider-preflight.yml', import.meta.url),
      'utf8',
    )) as Workflow;

    expect(workflow.name).toBe('Codex provider preflight');
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const job = workflow.jobs.verify;
    expect(job).toBeDefined();
    expect(job?.permissions).toBeUndefined();
    expect(job?.environment).toBeUndefined();
    expect(job?.steps.filter((step) => step.uses !== undefined).map((step) => step.uses))
      .toEqual([
        'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
        'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1',
        'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      ]);
    const probe = job?.steps.find((step) => step.name === 'Verify exact provider route');
    expect(probe?.env).toEqual({
      DELIVERY_LOOP_CODEX_ADAPTER_E2E: '1',
      DELIVERY_LOOP_CODEX_ADAPTER_MODEL: 'gpt-5.6-terra',
      CODEX_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
      OPENAI_BASE_URL: '${{ secrets.OPENAI_BASE_URL }}',
    });
    expect(probe?.run).toBe(
      'pnpm run e2e:codex-adapter > "$RUNNER_TEMP/codex-provider-preflight.json"',
    );
    const analysis = job?.steps.find((step) => step.name === 'Verify exact analysis schema');
    expect(analysis?.env).toEqual({
      DELIVERY_LOOP_CODEX_ANALYSIS_E2E: '1',
      DELIVERY_LOOP_CODEX_ADAPTER_MODEL: 'gpt-5.6-terra',
      DELIVERY_LOOP_CODEX_ANALYSIS_REASONING_EFFORT: 'medium',
      CODEX_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
      OPENAI_BASE_URL: '${{ secrets.OPENAI_BASE_URL }}',
    });
    expect(analysis?.run).toBe(
      'pnpm run e2e:codex-analysis > "$RUNNER_TEMP/codex-analysis-preflight.json"',
    );
    expect(JSON.stringify(workflow)).not.toContain('workflow_call');
    expect(JSON.stringify(workflow)).not.toContain('id-token');
    expect(JSON.stringify(workflow)).not.toContain('pull_request');
    expect(JSON.stringify(workflow)).not.toContain('vars.OPENAI_BASE_URL');

    const analysisScript = readFileSync(
      new URL('../scripts/verify-real-codex-analysis.ts', import.meta.url),
      'utf8',
    );
    expect(analysisScript).toContain(
      "const contextRoot = join(workspacePath, '.delivery-loop-analysis-context-preflight')",
    );
    expect(analysisScript).toContain("const contextFilePath = join(contextRoot, 'context.json')");
    expect(analysisScript).toContain('await rm(contextRoot, { recursive: true, force: true })');
    expect(analysisScript).toContain('error instanceof CodexAnalysisAdapterError');
    expect(analysisScript).toContain("error.kind === 'process_nonzero_exit'");
    expect(analysisScript).toContain("error.providerFailureCode ?? 'provider_process_failed'");
    expect(analysisScript).toContain('classifyAnalysisProviderProcessFailure(result.stderr)');
    expect(analysisScript).toContain('DIAGNOSTIC_ROOT_CAUSE_RESULT_V1_JSON_SCHEMA');
    expect(analysisScript).toContain("const diagnosticRootCauseSchemaPath = join(root, 'diagnostic-root-cause-schema.json')");
    expect(analysisScript).toContain('diagnostic: {');
    expect(analysisScript).toContain('async searchLogs(');
    expect(analysisScript).toContain('async getTrace(');
    const sourceBackedCodeRef = {
      path: 'src/request.ts',
      symbol: 'handleRequest',
    };
    expect(DiagnosticRootCauseV1Schema.safeParse({
      summary: 'The synthetic trace identifies the diagnostic prompt boundary.',
      confidence: 'high',
      codeRefs: [sourceBackedCodeRef],
    }).success).toBe(true);
    expect(analysisScript).toContain("join(workspacePath, 'src/request.ts')");
    expect(analysisScript).toContain(
      "codeRef: { path: 'src/request.ts', symbol: 'handleRequest' }",
    );
    const adapterSource = readFileSync(
      new URL('../src/agent/codex-analysis-adapter.ts', import.meta.url),
      'utf8',
    );
    expect(adapterSource).toContain(
      'The embedded sourceSnapshot was selected from the exact tracked checkout by the trusted Runner. Every codeRef must use an exact sourceSnapshot path and either its exact positive line or a symbol that appears in that same excerpt; use both when known.',
    );
    expect(adapterSource).toContain(
      'Never use an HTTP request path, an absolute path, a parent traversal path, or a repository location absent from sourceSnapshot.',
    );
    expect(analysisScript).toContain('diagnosticUsages.length !== 4');
    expect(analysisScript).toContain('failureKind: error.kind');
    expect(analysisScript).toContain('failureStage: error.stage');
    expect(analysisScript).toContain(
      "providerFailureCode: error.providerFailureCode ?? 'provider_process_failed'",
    );
    expect(analysisScript).toContain(
      'real-codex-analysis: FAIL ${JSON.stringify(failure)}',
    );
    expect(analysisScript).not.toContain('real-codex-analysis: FAIL ${code}');
    expect(analysisScript).toContain("? 'structured_output_invalid'");
    expect(analysisScript).not.toContain('parsed.error.issues.map');
    expect(analysisScript).not.toContain('context_access_proof_unavailable');
    expect(analysisScript).not.toContain("const contextFilePath = join(root, 'context.json')");
  });
});
