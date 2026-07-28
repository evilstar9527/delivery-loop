import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('fixed automatic test rollback workflow', () => {
  it('uses the test Environment and an independent least-privilege OIDC identity', async () => {
    const source = await readFile(
      resolve('.github/workflows/delivery-test-rollback.yml'),
      'utf8',
    );
    const workflow = parse(source) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
      permissions: Record<string, string>;
      jobs: { rollback: { environment: string; if: string } };
    };
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).sort()).toEqual([
      'control_plane_url',
      'ref_sha',
      'rollback_id',
      'schema_version',
      'source_kind',
    ]);
    expect(workflow.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(workflow.jobs.rollback.environment).toBe('test');
    expect(workflow.jobs.rollback.if).toContain("inputs.schema_version == '1'");
    expect(source).toContain('pnpm exec tsx scripts/run-test-rollback.ts');
    expect(source).not.toMatch(/deployments:\s*write|secrets\.(?:PROD|PRODUCTION)/i);
    expect(source).not.toContain('persist-credentials: true');
  });
});
