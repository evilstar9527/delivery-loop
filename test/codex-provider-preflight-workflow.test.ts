import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

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
    expect(analysisScript).toContain("message === 'Codex analysis process timed out'");
    expect(analysisScript).toContain("? 'provider_timeout'");
    expect(analysisScript).toContain("? 'context_access_proof_unavailable'");
    expect(analysisScript).not.toContain("const contextFilePath = join(root, 'context.json')");
  });
});
