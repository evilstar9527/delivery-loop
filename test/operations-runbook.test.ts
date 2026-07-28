import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const runbook = readFileSync(
  new URL('../docs/OperationsRunbook.md', import.meta.url),
  'utf8',
);

const INCIDENTS = [
  'IR-GITHUB',
  'IR-FEISHU',
  'IR-TOOL-BRIDGE',
  'IR-DATABASE',
  'IR-SECRET',
  'IR-WRONG-PRODUCTION-DEPLOYMENT',
] as const;

const REQUIRED_PHASES = [
  '触发与分级',
  '只读诊断',
  '止损与授权',
  '恢复',
  '验证与结案',
  '证据',
  '禁止项',
] as const;

function incidentSection(id: string): string {
  const start = runbook.indexOf(`## ${id} —`);
  if (start < 0) return '';
  const end = runbook.indexOf('\n## ', start + 4);
  return runbook.slice(start, end < 0 ? undefined : end);
}

describe('operations runbook contract', () => {
  it('covers all six required incident classes with a complete operational lifecycle', () => {
    for (const incidentId of INCIDENTS) {
      const section = incidentSection(incidentId);
      expect(section, incidentId).toContain(`## ${incidentId} —`);
      expect(section.length, incidentId).toBeGreaterThan(1_000);
      for (const phase of REQUIRED_PHASES) {
        expect(section, `${incidentId}/${phase}`).toContain(`### ${phase}`);
      }
      expect(section, incidentId).toMatch(/SEV-[012]/);
      expect(section, incidentId).toContain('结案');
    }
    expect(runbook).not.toMatch(/\b(?:TODO|TBD|FIXME)\b/i);
  });

  it('documents only control-plane routes that are present with the stated methods', () => {
    const routes = [
      ['GET', '/v1/dead-letters', '../src/http/dead-letter-api.ts', "app.get('/v1/dead-letters'"],
      ['POST', '/v1/dead-letters/:deadLetterId/replay', '../src/http/dead-letter-api.ts', "app.post('/v1/dead-letters/:deadLetterId/replay'"],
      ['GET', '/v1/runs/:runId/feishu-card', '../src/http/feishu-delivery-card-refresh-api.ts', "app.get('/v1/runs/:runId/feishu-card'"],
      ['POST', '/v1/runs/:runId/feishu-card/refresh', '../src/http/feishu-delivery-card-refresh-api.ts', "app.post('/v1/runs/:runId/feishu-card/refresh'"],
      ['GET', '/v1/correlations', '../src/http/correlation-api.ts', "app.get('/v1/correlations'"],
      ['GET', '/v1/runs/:runId/plan', '../src/http/task-api.ts', "app.get('/v1/runs/:runId/plan'"],
      ['POST', '/v1/runs/:runId/cancel', '../src/http/task-api.ts', "app.post('/v1/runs/:runId/cancel'"],
      ['POST', '/v1/runs/:runId/retry', '../src/http/task-api.ts', "app.post('/v1/runs/:runId/retry'"],
      ['GET', '/v1/runs/:runId/audit', '../src/http/case8-audit-api.ts', "app.get('/v1/runs/:runId/audit'"],
      ['GET', '/v1/backups', '../src/http/backup-api.ts', "app.get('/v1/backups'"],
      ['POST', '/v1/restores/:restoreId/fence', '../src/http/backup-api.ts', "app.post('/v1/restores/:restoreId/fence'"],
      ['GET', '/v1/restores/:restoreId', '../src/http/backup-api.ts', "app.get('/v1/restores/:restoreId'"],
      ['POST', '/v1/restores/:restoreId/complete', '../src/http/backup-api.ts', "app.post('/v1/restores/:restoreId/complete'"],
    ] as const;

    for (const [method, route, sourcePath, sourceLiteral] of routes) {
      expect(runbook).toContain(`| \`${method}\` | \`${route}\``);
      const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8');
      expect(source).toContain(sourceLiteral);
    }
  });

  it('states unsupported emergency boundaries instead of inventing authority', () => {
    expect(runbook).toContain('当前没有全局 provider pause API');
    expect(runbook).toContain('当前没有 production rollback API');
    expect(runbook).toContain('restore fence 不是常规 outage pause');
    expect(runbook).toContain('test rollback 不能用于 production');
    expect(runbook).toContain('`/healthz` 只证明 Worker isolate 存活');
    expect(runbook).toContain('外部平台人工处置');
    expect(runbook).toContain('双人复核');
  });

  it('keeps credentials out of argv/history and forbids arbitrary storage mutation', () => {
    expect(runbook).toContain("read -rsp 'Operations token: ' OPERATIONS_TOKEN");
    expect(runbook).toContain("read -rsp 'Task service token: ' TASK_INTAKE_TOKEN");
    expect(runbook).not.toMatch(/Authorization:\s*Bearer\s+[A-Za-z0-9._-]{8}/);
    expect(runbook).not.toContain('export OPERATIONS_TOKEN=');
    expect(runbook).not.toContain('export TASK_INTAKE_TOKEN=');
    expect(runbook).not.toMatch(/wrangler\s+d1\s+execute/i);
    expect(runbook).not.toMatch(/wrangler\s+r2\s+object\s+delete/i);
    expect(runbook).not.toMatch(/\b(?:DELETE|UPDATE|DROP|TRUNCATE)\s+(?:FROM|TABLE|raw_agent|runs|attempts|outbox)/i);
    expect(runbook).not.toContain('wrangler secret put OPERATIONS_TOKEN --');

    const shellBlocks = [...runbook.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
    const curlBlocks = shellBlocks.filter((block) => block.includes('curl '));
    expect(curlBlocks.length).toBeGreaterThan(5);
    for (const block of curlBlocks) {
      expect(block).toContain('--fail-with-body');
      if (block.includes('authorization: Bearer')) {
        expect(block).toMatch(/\$\{(?:OPERATIONS_TOKEN|TASK_INTAKE_TOKEN):\?\}/);
      }
    }
    for (const block of shellBlocks) {
      const parsed = spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' });
      expect(parsed.status, parsed.stderr).toBe(0);
    }
  });

  it('records the Watt-derived credential rotation discipline without copying its product model', () => {
    expect(runbook).toContain('Watt 476e3cdd2490d725fde174e7c697ebf00899edc6');
    expect(runbook).toContain('重签依赖凭据 → 通过 stdin 更新 Secret → 分段探测');
    expect(runbook).toContain('不得等待自然流量');
    expect(runbook).toContain('不运行会覆盖完整配置的 setup');
  });
});
