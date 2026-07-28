import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('fixed test deployment workflow', () => {
  it('uses only the test Environment, a dedicated OIDC identity, and minimal permissions', async () => {
    const source = await readFile(
      resolve('.github/workflows/delivery-test-deploy.yml'),
      'utf8',
    );
    const workflow = parse(source) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: { deploy: { environment: string; if: string } };
    };
    expect(workflow.on).toHaveProperty('deployment');
    expect(workflow.permissions).toEqual({
      contents: 'read',
      deployments: 'write',
      'id-token': 'write',
    });
    expect(workflow.jobs.deploy.environment).toBe('test');
    expect(workflow.jobs.deploy.if).toContain("github.event.deployment.environment == 'test'");
    expect(workflow.jobs.deploy.if).toContain("github.event.deployment.task == 'delivery-loop:test'");
    expect(source).toContain('pnpm exec tsx scripts/run-test-deployment.ts');
    expect(source).not.toMatch(/secrets\.(?:PROD|PRODUCTION)|environment:\s*production/i);
    expect(source).not.toContain('persist-credentials: true');
  });
});
