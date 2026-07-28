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

describe('provider network preflight workflow', () => {
  it('uses only the base URL Secret for a manual read-only DNS/TCP/TLS probe', () => {
    const workflow = parse(readFileSync(
      new URL('../.github/workflows/provider-network-preflight.yml', import.meta.url),
      'utf8',
    )) as Workflow;

    expect(workflow.name).toBe('Provider network preflight');
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
    const probe = job?.steps.find((step) => step.name === 'Probe provider network');
    expect(probe?.env).toEqual({
      DELIVERY_LOOP_PROVIDER_NETWORK_PREFLIGHT: '1',
      OPENAI_BASE_URL: '${{ secrets.OPENAI_BASE_URL }}',
    });
    expect(probe?.run).toBe('pnpm run e2e:provider-network');
    const serialized = JSON.stringify(workflow);
    expect(serialized).not.toContain('OPENAI_API_KEY');
    expect(serialized).not.toContain('CODEX_API_KEY');
    expect(serialized).not.toContain('id-token');
    expect(serialized).not.toContain('upload-artifact');
    expect(serialized).not.toContain('workflow_call');
    expect(serialized).not.toContain('pull_request');
    expect(serialized.toLowerCase()).not.toContain('codex');
    expect(serialized.toLowerCase()).not.toContain('model');

    const verifier = readFileSync(
      new URL('../scripts/verify-provider-network.ts', import.meta.url),
      'utf8',
    );
    expect(verifier).not.toContain('OPENAI_API_KEY');
    expect(verifier).not.toContain('CODEX_API_KEY');
    expect(verifier).not.toContain('fetch(');
    expect(verifier.toLowerCase()).not.toContain('codex');
  });

  it('registers the fixed non-model verifier entry point', () => {
    const packageJson = JSON.parse(readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8',
    )) as { scripts: Record<string, string> };

    expect(packageJson.scripts['e2e:provider-network'])
      .toBe('tsx scripts/verify-provider-network.ts');
  });
});
