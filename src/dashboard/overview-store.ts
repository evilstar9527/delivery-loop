import type { RunState } from '../domain/run.js';

/**
 * How each run state rolls up into the board's lanes.
 * - running: the machine is actively progressing the run on its own.
 * - pending: the run is parked waiting on a human/gate (approval, review, merge).
 * - blocked: the run cannot progress on its own (blocked/failed/cancelled).
 * - completed: succeeded.
 */
export type DashboardLane = 'running' | 'pending' | 'blocked' | 'completed';

const LANE_BY_STATE: Record<RunState, DashboardLane> = {
  received: 'running',
  triaging: 'running',
  queued: 'running',
  planning: 'running',
  executing: 'running',
  verifying: 'running',
  merging: 'running',
  deploying: 'running',
  awaiting_approval: 'pending',
  pull_request_open: 'pending',
  awaiting_review: 'pending',
  ready_to_merge: 'pending',
  succeeded: 'completed',
  blocked: 'blocked',
  failed: 'blocked',
  cancelled: 'blocked',
};

/** Unknown/未来状态默认归为 running(机器仍在推进)。 */
export function dashboardLane(state: RunState): DashboardLane {
  return LANE_BY_STATE[state] ?? 'running';
}

export interface DashboardTask {
  runId: string;
  taskId: string;
  state: RunState;
  lane: DashboardLane;
  repository: string;
  title: string;
  intentKind: string;
  createdAt: string;
  updatedAt: string;
  prNumber: number | null;
  prUrl: string | null;
}

export interface DashboardActiveSandbox {
  sandboxId: string;
  executionId: string;
  role: 'work' | 'publisher';
  status: string;
  repository: string;
  runId: string;
  taskTitle: string;
  startedAt: string | null;
  updatedAt: string;
}

export interface DashboardOverview {
  generatedAt: string;
  laneCounts: Record<DashboardLane, number>;
  tasks: DashboardTask[];
  activeSandboxes: DashboardActiveSandbox[];
}

interface RunRow {
  run_id: string;
  task_id: string;
  state: RunState;
  target_repository: string;
  title: string | null;
  intent_kind: string;
  created_at: string;
  updated_at: string;
  github_pr_number: number | null;
  github_pr_url: string | null;
}

interface SandboxRow {
  provider_external_id: string;
  execution_id: string;
  execution_role: 'work' | 'publisher';
  status: string;
  repository: string;
  run_id: string;
  title: string | null;
  started_at: string | null;
  updated_at: string;
}

const MAX_LIMIT = 500;

export class DashboardOverviewStore {
  constructor(private readonly db: D1Database) {}

  async overview(now: Date, limit = 200): Promise<DashboardOverview> {
    const bounded = Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_LIMIT
      ? limit
      : 200;
    // A run has at most one non-superseded PR publication; pick the newest by
    // rowid so a re-published PR still resolves to a single link.
    const runs = await this.db.prepare(
      `SELECT runs.run_id, runs.task_id, runs.state,
              tasks.target_repository, tasks.title, tasks.intent_kind,
              runs.created_at, runs.updated_at,
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
       WHERE NOT EXISTS (
         SELECT 1 FROM dashboard_dismissals AS dismissed
         WHERE dismissed.run_id = runs.run_id
       )
       ORDER BY runs.updated_at DESC, runs.run_id
       LIMIT ?`,
    ).bind(bounded).all<RunRow>();

    const tasks: DashboardTask[] = runs.results.map((row) => ({
      runId: row.run_id,
      taskId: row.task_id,
      state: row.state,
      lane: dashboardLane(row.state),
      repository: row.target_repository,
      title: (row.title ?? '').trim() || '(untitled)',
      intentKind: row.intent_kind,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      prNumber: row.github_pr_number,
      prUrl: row.github_pr_url,
    }));

    const laneCounts: Record<DashboardLane, number> = {
      running: 0,
      pending: 0,
      blocked: 0,
      completed: 0,
    };
    for (const task of tasks) laneCounts[task.lane] += 1;

    // A sandbox is "actively modifying a repo" only while its execution is
    // starting/running and it has a provider handle (the sandbox id).
    //
    // Deliberately NOT filtered by dashboard_dismissals: if a hidden run still
    // has a container, it must stay visible and reapable here, otherwise the
    // container becomes an unreachable orphan holding an instance slot.
    const sandboxes = await this.db.prepare(
      `SELECT execution.provider_external_id, execution.execution_id,
              execution.execution_role, execution.status,
              attempts.repository, attempts.run_id,
              tasks.title, execution.started_at, execution.updated_at
       FROM attempt_execution_instances AS execution
       JOIN attempts ON attempts.attempt_id = execution.attempt_id
       JOIN runs ON runs.run_id = attempts.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       WHERE execution.status IN ('starting', 'running')
         AND execution.provider_external_id IS NOT NULL
       ORDER BY execution.updated_at DESC, execution.execution_id
       LIMIT ?`,
    ).bind(bounded).all<SandboxRow>();

    const activeSandboxes: DashboardActiveSandbox[] = sandboxes.results.map((row) => ({
      sandboxId: row.provider_external_id,
      executionId: row.execution_id,
      role: row.execution_role,
      status: row.status,
      repository: row.repository,
      runId: row.run_id,
      taskTitle: (row.title ?? '').trim() || '(untitled)',
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    }));

    return {
      generatedAt: now.toISOString(),
      laneCounts,
      tasks,
      activeSandboxes,
    };
  }
}
