import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('fixed production deployment workflow', () => {
  it('uses the protected production Environment and the exact merged SHA', async () => {
    const source = await readFile(
      resolve('.github/workflows/delivery-production-deploy.yml'),
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
    expect(workflow.jobs.deploy.environment).toBe('production');
    expect(workflow.jobs.deploy.if).toContain(
      "github.event.deployment.environment == 'production'",
    );
    expect(workflow.jobs.deploy.if).toContain(
      "github.event.deployment.task == 'delivery-loop:production'",
    );
    expect(source).toContain('ref: ${{ github.event.deployment.sha }}');
    expect(source).toContain('pnpm exec tsx scripts/run-production-deployment.ts');
    expect(source).toContain('pnpm install --frozen-lockfile --ignore-scripts');
    expect(source).not.toMatch(/environment:\s*test|DELIVERY_TEST_|delivery-loop:test/i);
    expect(source).not.toContain('persist-credentials: true');
  });
});
