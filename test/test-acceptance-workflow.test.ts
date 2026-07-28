import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('fixed post-deployment acceptance workflow', () => {
  it('runs separately from deployment in the test Environment with no deployment permission', async () => {
    const source = await readFile(
      resolve('.github/workflows/delivery-test-acceptance.yml'),
      'utf8',
    );
    const workflow = parse(source) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
      permissions: Record<string, string>;
      jobs: { acceptance: { environment: string; if: string } };
    };
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).sort()).toEqual([
      'acceptance_id',
      'control_plane_url',
      'ref_sha',
      'schema_version',
    ]);
    expect(workflow.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(workflow.jobs.acceptance.environment).toBe('test');
    expect(workflow.jobs.acceptance.if).toContain("inputs.schema_version == '1'");
    expect(source).toContain('pnpm exec tsx scripts/run-test-acceptance.ts');
    expect(source).not.toMatch(/deployments:\s*write|secrets\.(?:PROD|PRODUCTION)/i);
    expect(source).not.toContain('persist-credentials: true');
  });
});
