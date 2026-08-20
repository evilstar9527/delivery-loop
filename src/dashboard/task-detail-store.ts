import type { RunState } from '../domain/run.js';
import { dashboardLane, type DashboardLane } from './overview-store.js';

/**
 * Read model for the dashboard task-detail view. Combines three sources:
 *  - the run/task row in D1 (state, repo, flags),
 *  - the original human request (title / description / acceptance criteria)
 *    stored as a TaskEnvelope JSON in the TASK_OBJECTS R2 bucket at
 *    `tasks.payload_ref`,
 *  - the agent-produced DOD plan (execution_plans + plan_items + done_when +
 *    effects) joined to per-item progress (plan_item_progress).
 *
 * Read-only; never mutates. The R2 payload is best-effort — if it is missing or
 * unparseable the detail still renders from D1 with `origin` null.
 */

export interface TaskDetailOriginItem {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  sourceSystem: string;
  sourceUrl: string | null;
}

export interface TaskDetailPlanItem {
  itemId: string;
  kind: string;
  title: string;
  objective: string;
  required: boolean;
  position: number;
  doneWhen: string[];
  effects: string[];
  /** plan_item_progress.status, or 'pending' when no progress row exists yet. */
  progress: string;
}

export interface TaskDetailPlan {
  planId: string;
  planVersion: number;
  status: string;
  objective: string;
  items: TaskDetailPlanItem[];
  /** items whose progress status is a terminal-pass, over total items. */
  doneCount: number;
  totalCount: number;
}

export interface TaskDetail {
  runId: string;
  taskId: string;
  state: RunState;
  lane: DashboardLane;
  repository: string;
  baseBranch: string;
  intentKind: string;
  priority: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  prNumber: number | null;
  prUrl: string | null;
  requireHumanApproval: boolean;
  allowRepositoryWrite: boolean;
  /** true when the run is parked awaiting the repo_write approval gate. */
  approvable: boolean;
  origin: TaskDetailOriginItem | null;
  plan: TaskDetailPlan | null;
}

interface RunTaskRow {
  run_id: string;
  task_id: string;
  state: RunState;
  target_repository: string;
  target_base_branch: string;
  intent_kind: string;
  priority: string;
  title: string | null;
  payload_ref: string;
  source_system: string;
  source_url: string | null;
  require_human_approval: number;
  allow_repository_write: number;
  active_plan_id: string | null;
  created_at: string;
  updated_at: string;
  github_pr_number: number | null;
  github_pr_url: string | null;
}

interface PlanRow {
  plan_id: string;
  plan_version: number;
  status: string;
  objective: string;
}

interface PlanItemRow {
  item_id: string;
  kind: string;
  title: string;
  objective: string;
  required: number;
  position: number;
  progress: string | null;
}

/** plan_item_progress statuses that count as "done" for the progress bar. */
const DONE_STATUSES = new Set(['passed', 'skipped']);

export class TaskDetailStore {
  constructor(private readonly db: D1Database, private readonly taskObjects: R2Bucket) {}

  async detail(runId: string): Promise<TaskDetail | null> {
    const row = await this.db.prepare(
      `SELECT runs.run_id, runs.task_id, runs.state,
              tasks.target_repository, tasks.target_base_branch, tasks.intent_kind,
              tasks.priority, tasks.title, tasks.payload_ref, tasks.source_system,
              tasks.source_url, tasks.require_human_approval, tasks.allow_repository_write,
              runs.active_plan_id, runs.created_at, runs.updated_at,
              pub.github_pr_number, pub.github_pr_url
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       LEFT JOIN (
         SELECT p.run_id, p.github_pr_number, p.github_pr_url
         FROM pull_request_publications AS p
         JOIN (
           SELECT run_id, MAX(rowid) AS rowid
           FROM pull_request_publications GROUP BY run_id
         ) AS latest ON latest.rowid = p.rowid
       ) AS pub ON pub.run_id = runs.run_id
       WHERE runs.run_id = ?`,
    ).bind(runId).first<RunTaskRow>();
    if (row === null) return null;

    const origin = await this.origin(row);
    const plan = await this.plan(row.active_plan_id);

    return {
      runId: row.run_id,
      taskId: row.task_id,
      state: row.state,
      lane: dashboardLane(row.state),
      repository: row.target_repository,
      baseBranch: row.target_base_branch,
      intentKind: row.intent_kind,
      priority: row.priority,
      title: (row.title ?? '').trim() || '(untitled)',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      prNumber: row.github_pr_number,
      prUrl: row.github_pr_url,
      requireHumanApproval: row.require_human_approval === 1,
      allowRepositoryWrite: row.allow_repository_write === 1,
      approvable: row.state === 'awaiting_approval',
      origin,
      plan,
    };
  }

  /** Load the original request envelope from R2 (best-effort). */
  private async origin(row: RunTaskRow): Promise<TaskDetailOriginItem | null> {
    const key = row.payload_ref.startsWith('r2://')
      ? row.payload_ref.slice('r2://'.length)
      : row.payload_ref;
    try {
      const object = await this.taskObjects.get(key);
      if (object === null) return null;
      const envelope = JSON.parse(await object.text()) as {
        intent?: { title?: unknown; description?: unknown; acceptanceCriteria?: unknown };
      };
      const intent = envelope.intent ?? {};
      const criteria = Array.isArray(intent.acceptanceCriteria)
        ? intent.acceptanceCriteria.filter((c): c is string => typeof c === 'string')
        : [];
      return {
        title: typeof intent.title === 'string' ? intent.title : (row.title ?? ''),
        description: typeof intent.description === 'string' ? intent.description : '',
        acceptanceCriteria: criteria,
        sourceSystem: row.source_system,
        sourceUrl: row.source_url,
      };
    } catch {
      // Missing/corrupt payload: fall back to D1-only detail rather than 500.
      return null;
    }
  }

  /** Load the active DOD plan with items, done-when, effects, and progress. */
  private async plan(activePlanId: string | null): Promise<TaskDetailPlan | null> {
    if (activePlanId === null) return null;
    const planRow = await this.db.prepare(
      `SELECT plan_id, plan_version, status, objective
       FROM execution_plans WHERE plan_id = ?`,
    ).bind(activePlanId).first<PlanRow>();
    if (planRow === null) return null;

    const itemRows = await this.db.prepare(
      `SELECT items.item_id, items.kind, items.title, items.objective,
              items.required, items.position, progress.status AS progress
       FROM plan_items AS items
       LEFT JOIN plan_item_progress AS progress
         ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
       WHERE items.plan_id = ?
       ORDER BY items.position`,
    ).bind(activePlanId).all<PlanItemRow>();

    const [doneWhenRows, effectRows] = await Promise.all([
      this.db.prepare(
        `SELECT item_id, condition FROM plan_item_done_when
         WHERE plan_id = ? ORDER BY item_id, position`,
      ).bind(activePlanId).all<{ item_id: string; condition: string }>(),
      this.db.prepare(
        `SELECT item_id, effect FROM plan_item_effects
         WHERE plan_id = ? ORDER BY item_id, effect`,
      ).bind(activePlanId).all<{ item_id: string; effect: string }>(),
    ]);

    const doneWhenByItem = new Map<string, string[]>();
    for (const r of doneWhenRows.results) {
      const list = doneWhenByItem.get(r.item_id) ?? [];
      list.push(r.condition);
      doneWhenByItem.set(r.item_id, list);
    }
    const effectsByItem = new Map<string, string[]>();
    for (const r of effectRows.results) {
      const list = effectsByItem.get(r.item_id) ?? [];
      list.push(r.effect);
      effectsByItem.set(r.item_id, list);
    }

    const items: TaskDetailPlanItem[] = itemRows.results.map((r) => ({
      itemId: r.item_id,
      kind: r.kind,
      title: r.title,
      objective: r.objective,
      required: r.required === 1,
      position: r.position,
      doneWhen: doneWhenByItem.get(r.item_id) ?? [],
      effects: effectsByItem.get(r.item_id) ?? [],
      progress: r.progress ?? 'pending',
    }));
    const doneCount = items.filter((i) => DONE_STATUSES.has(i.progress)).length;

    return {
      planId: planRow.plan_id,
      planVersion: planRow.plan_version,
      status: planRow.status,
      objective: planRow.objective,
      items,
      doneCount,
      totalCount: items.length,
    };
  }
}
