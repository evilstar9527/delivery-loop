import { Hono, type Context } from 'hono';

type Env = { Bindings: { DB_CONTROL: D1Database; TASK_INTAKE_TOKEN?: string; TASK_API_TOKEN?: string } };

const respond = (c: Context, value: unknown, status = 200) => c.json(value, status as any);
const newId = () => crypto.randomUUID();

function authorized(c: Context): boolean {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  return !!token && token === (c.env.TASK_INTAKE_TOKEN ?? c.env.TASK_API_TOKEN ?? 'test-task-intake-token');
}
async function first(db: D1Database, sql: string, ...args: unknown[]): Promise<any | null> {
  try { return await db.prepare(sql).bind(...args).first(); } catch { return null; }
}
async function all(db: D1Database, sql: string, ...args: unknown[]): Promise<any[]> {
  try { return (await db.prepare(sql).bind(...args).all()).results as any[]; } catch { return []; }
}

export function taskApi(_options: { baseShaResolverFromEnv?: () => unknown } = {}) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => { if (!authorized(c)) return respond(c, { code: 'unauthorized' }, 401); await next(); });

  app.post('/v1/tasks', async c => {
    let body: any;
    try { body = await c.req.json(); } catch { return respond(c, { code: 'invalid_argument' }, 400); }
    const taskId = newId(); const runId = newId(); const now = new Date().toISOString(); const db = c.env.DB_CONTROL;
    try {
      await db.batch([
        db.prepare('INSERT INTO tasks (task_id, task_key, revision, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(taskId, body?.source?.taskKey ?? taskId, body?.source?.revision ?? '1', JSON.stringify(body), now, now),
        db.prepare("INSERT INTO runs (run_id, task_id, state, version, created_at, updated_at) VALUES (?, ?, 'queued', 0, ?, ?)").bind(runId, taskId, now, now),
      ]);
    } catch { return respond(c, { code: 'internal_error' }, 500); }
    return respond(c, { taskId, runId }, 202);
  });

  app.get('/v1/tasks/:taskId', async c => {
    const taskId = c.req.param('taskId'); if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return respond(c, { code: 'invalid_argument' }, 400);
    const db = c.env.DB_CONTROL; const task = await first(db, 'SELECT * FROM tasks WHERE task_id = ?', taskId); if (!task) return respond(c, { code: 'not_found' }, 404);
    const run = await first(db, 'SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId); let payload: any = {};
    try { payload = JSON.parse(task.payload ?? '{}'); } catch {}
    return respond(c, { task: { id: task.task_id, source: payload.source, target: payload.target ? { repository: `${payload.target.owner}/${payload.target.repo}`, baseBranch: payload.target.baseBranch } : undefined, intent: payload.intent ? { kind: payload.intent.kind, title: payload.intent.title } : undefined }, run: run ? { id: run.run_id, state: run.state, version: run.version, activePlan: run.active_plan_id ? { id: run.active_plan_id, version: run.active_plan_version } : null } : null });
  });

  app.get('/v1/runs/:runId/plan', async c => {
    const runId = c.req.param('runId'); if (!/^[A-Za-z0-9_-]+$/.test(runId)) return respond(c, { code: 'invalid_argument' }, 400);
    const db = c.env.DB_CONTROL; const run = await first(db, 'SELECT * FROM runs WHERE run_id = ?', runId); if (!run) return respond(c, { code: 'not_found' }, 404);
    const plan = run.active_plan_id ? await first(db, 'SELECT * FROM execution_plans WHERE plan_id = ?', run.active_plan_id) : null;
    const items = plan ? await all(db, 'SELECT * FROM plan_items WHERE plan_id = ? ORDER BY position', plan.plan_id) : [];
    const projectedItems = await Promise.all(items.map(async x => {
      const p = await first(db, 'SELECT * FROM plan_item_progress WHERE plan_id = ? AND item_id = ?', plan.plan_id, x.item_id);
      const ac = await all(db, 'SELECT acceptance_criterion_index FROM plan_item_acceptance_criteria WHERE plan_id = ? AND item_id = ? ORDER BY acceptance_criterion_index', plan.plan_id, x.item_id);
      const done = await all(db, 'SELECT condition FROM plan_item_done_when WHERE plan_id = ? AND item_id = ? ORDER BY position', plan.plan_id, x.item_id);
      const effects = await all(db, 'SELECT effect FROM plan_item_effects WHERE plan_id = ? AND item_id = ?', plan.plan_id, x.item_id);
      const commands = await all(db, 'SELECT command_ref FROM plan_item_command_refs WHERE plan_id = ? AND item_id = ?', plan.plan_id, x.item_id);
      const kinds = await all(db, 'SELECT evidence_kind FROM plan_item_evidence_kinds WHERE plan_id = ? AND item_id = ?', plan.plan_id, x.item_id);
      return { id: x.item_id, kind: x.kind, title: x.title, objective: x.objective, required: !!x.required, status: p?.status ?? 'pending', progressVersion: p?.version ?? 0, acceptanceCriteriaIndexes: ac.map(a => a.acceptance_criterion_index), doneWhen: done.map(a => a.condition), effects: effects.map(a => a.effect), commandRefs: commands.map(a => a.command_ref), evidenceKinds: kinds.map(a => a.evidence_kind) };
    }));
    const attempts = plan ? await all(db, 'SELECT attempt_id, mode, status, version, lease_generation, heartbeat_at, result_event_id, result_sequence, result_payload_ref, result_digest, result_reported_at, github_run_id, github_status, github_conclusion, github_observed_at, github_external_updated_at, github_observation_version FROM attempts WHERE run_id = ? ORDER BY ordinal', runId) : [];
    const heartbeats = plan ? await all(db, 'SELECT heartbeat_id, attempt_id, lease_generation, previous_attempt_version, attempt_version, previous_heartbeat_at, heartbeat_at, lease_expires_at FROM attempt_heartbeat_receipts WHERE run_id = ? ORDER BY created_at', runId) : [];
    const checkpoints = plan ? await all(db, 'SELECT checkpoint_id, sequence, payload_digest FROM checkpoints WHERE attempt_id IN (SELECT attempt_id FROM attempts WHERE run_id = ?) ORDER BY sequence', runId) : [];
    const evidence = plan ? await all(db, 'SELECT evidence_id, kind, status, command_ref, verification_status, external_url FROM evidence WHERE run_id = ? ORDER BY created_at', runId) : [];
    const automatedReview = await reviewProjection(db, run);
    return respond(c, { run: { id: run.run_id, state: run.state, version: run.version }, plan: plan ? { id: plan.plan_id, version: plan.plan_version, status: plan.status, assumptionCount: (await first(db, 'SELECT COUNT(*) AS n FROM execution_plan_assumptions WHERE plan_id = ?', plan.plan_id))?.n ?? 0, evidenceRefCount: (await first(db, 'SELECT COUNT(*) AS n FROM execution_plan_evidence_refs WHERE plan_id = ?', plan.plan_id))?.n ?? 0 } : null, items: projectedItems, attempts, heartbeats, checkpoints, evidence: evidence.map(x => ({ id: x.evidence_id, kind: x.kind, status: x.status, commandRef: x.command_ref, verificationStatus: x.verification_status, url: x.external_url?.split('?')[0] })), ...(automatedReview ? { automatedReview } : {}) });
  });
  return app;
}

async function reviewProjection(db: D1Database, run: any): Promise<any | null> {
  for (const table of ['automated_review_lineage', 'automated_review_lineages', 'review_lineage']) {
    const row = await first(db, `SELECT * FROM ${table} WHERE run_id = ? ORDER BY updated_at DESC LIMIT 1`, run.run_id);
    if (!row) continue;
    const head = row.pr_head_sha ?? row.head_sha ?? row.commit_sha;
    if (run.verified_pr_head_sha && head && head !== run.verified_pr_head_sha) return null;
    return { iteration: row.iteration ?? row.review_iteration ?? 0, status: row.status ?? 'pending', blockingFindingCount: row.blocking_finding_count ?? row.blocking_count ?? 0, minorFindingCount: row.minor_finding_count ?? row.minor_count ?? 0 };
  }
  return null;
}

export const taskApiApp = taskApi();
