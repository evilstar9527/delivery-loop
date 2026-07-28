import { AttemptStuckDetector } from '../storage/attempt-lifecycle-store.js';
import { secureStructuredLogSink } from '../observability/structured-log.js';

export interface RunStuckThresholdsSeconds {
  queued: number;
  running: number;
  awaitingReview: number;
  deploying: number;
}

export const DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS: RunStuckThresholdsSeconds = {
  queued: 5 * 60,
  running: 90,
  awaitingReview: 24 * 60 * 60,
  deploying: 30 * 60,
};

export type RunStuckStateKind = 'queued' | 'running' | 'awaiting_review' | 'deploying';
export type RunStuckAction =
  | 'requeue_workflow_create'
  | 'fence_lost_attempt'
  | 'escalate_human_review'
  | 'reconcile_external_deployment';
export type RunStuckResolutionCode = 'attempt_fenced' | 'run_progressed';

export interface RunStuckIncidentView {
  incidentId: string;
  runId: string;
  stateKind: RunStuckStateKind;
  observedRunState: string;
  runVersion: number;
  thresholdSeconds: number;
  action: RunStuckAction;
  status: 'open' | 'resolved';
  detectedAt: string;
  attemptId?: string;
  resolvedAt?: string;
  resolutionCode?: RunStuckResolutionCode;
}

export interface RunStuckScanResult {
  detected: RunStuckIncidentView[];
  resolved: RunStuckIncidentView[];
}

export interface RunStuckLogRecord {
  schemaVersion: '1';
  event: 'run_stuck_detected' | 'run_stuck_resolved';
  incidentId: string;
  correlationId: string;
  runId: string;
  stateKind: RunStuckStateKind;
  observedRunState: string;
  runVersion: number;
  thresholdSeconds: number;
  action: RunStuckAction;
  status: 'open' | 'resolved';
  attemptId?: string;
  resolutionCode?: RunStuckResolutionCode;
  observedAt: string;
}

export type RunStuckLogSink = (record: RunStuckLogRecord) => void;

interface RunCandidateRow {
  run_id: string;
  state: 'queued' | 'awaiting_review' | 'deploying';
  version: number;
  updated_at: string;
}

interface IncidentRow {
  incident_id: string;
  run_id: string;
  state_kind: RunStuckStateKind;
  observed_run_state: string;
  run_version: number;
  attempt_id: string | null;
  threshold_seconds: number;
  action: RunStuckAction;
  status: 'open' | 'resolved';
  detected_at: string;
  resolved_at: string | null;
  resolution_code: RunStuckResolutionCode | null;
}

interface OpenIncidentRow extends IncidentRow {
  current_run_state: string;
  current_run_version: number;
  current_attempt_status: string | null;
}

export interface RunStuckDetectorOptions {
  now?: () => Date;
  thresholds?: Partial<RunStuckThresholdsSeconds>;
  sink?: RunStuckLogSink;
}

function validateThresholds(thresholds: RunStuckThresholdsSeconds): void {
  for (const value of Object.values(thresholds)) {
    if (!Number.isSafeInteger(value) || value < 60 || value > 604800) {
      throw new Error('Run stuck thresholds must be between 60 and 604800 seconds');
    }
  }
}

function incidentView(row: IncidentRow): RunStuckIncidentView {
  return {
    incidentId: row.incident_id,
    runId: row.run_id,
    stateKind: row.state_kind,
    observedRunState: row.observed_run_state,
    runVersion: row.run_version,
    thresholdSeconds: row.threshold_seconds,
    action: row.action,
    status: row.status,
    detectedAt: row.detected_at,
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    ...(row.resolution_code === null ? {} : { resolutionCode: row.resolution_code }),
  };
}

function detectedView(row: IncidentRow): RunStuckIncidentView {
  const view = incidentView(row);
  delete view.resolvedAt;
  delete view.resolutionCode;
  return { ...view, status: 'open' };
}

function actionFor(state: RunCandidateRow['state']): RunStuckAction {
  if (state === 'queued') return 'requeue_workflow_create';
  if (state === 'awaiting_review') return 'escalate_human_review';
  return 'reconcile_external_deployment';
}

function stateKindThreshold(
  state: RunCandidateRow['state'],
  thresholds: RunStuckThresholdsSeconds,
): number {
  if (state === 'queued') return thresholds.queued;
  if (state === 'awaiting_review') return thresholds.awaitingReview;
  return thresholds.deploying;
}

function byIncidentId(
  left: RunStuckIncidentView,
  right: RunStuckIncidentView,
): number {
  return left.incidentId.localeCompare(right.incidentId);
}

/**
 * Cron-facing watchdog. D1 incidents are the durable alert source; structured
 * logs are a bounded secondary projection and never contain free-form input.
 */
export class RunStuckDetector {
  private readonly now: () => Date;
  private readonly thresholds: RunStuckThresholdsSeconds;
  private readonly sink: RunStuckLogSink;

  constructor(
    private readonly db: D1Database,
    options: RunStuckDetectorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.thresholds = {
      ...DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS,
      ...options.thresholds,
    };
    validateThresholds(this.thresholds);
    this.sink = options.sink ?? secureStructuredLogSink({ component: 'run_stuck' });
  }

  async scan(limit = 25): Promise<RunStuckScanResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('Run stuck scan limit must be between 1 and 100');
    }
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new Error('Run stuck scan time is invalid');
    const nowIso = now.toISOString();

    const resolved = await this.resolveOpenIncidents(limit, nowIso);
    const runningDetected = await this.detectRunning(limit, now, nowIso);
    const stateDetected = await this.detectRunStates(limit, now, nowIso);
    const newlyResolved = await this.resolveOpenIncidents(limit, nowIso);
    const resolvedById = new Map(
      [...resolved, ...newlyResolved].map((incident) => [incident.incidentId, incident]),
    );
    return {
      detected: [...runningDetected, ...stateDetected].sort(byIncidentId),
      resolved: [...resolvedById.values()].sort(byIncidentId),
    };
  }

  private async detectRunning(
    limit: number,
    now: Date,
    nowIso: string,
  ): Promise<RunStuckIncidentView[]> {
    const lost = await new AttemptStuckDetector(this.db, {
      now: () => now,
      runningThresholdSeconds: this.thresholds.running,
    }).scan(limit);
    const detected: RunStuckIncidentView[] = [];
    for (const result of lost) {
      const row = await this.db.prepare(
        `SELECT incident_id, run_id, state_kind, observed_run_state, run_version,
                attempt_id, threshold_seconds, action, status, detected_at,
                resolved_at, resolution_code
         FROM run_stuck_incidents
         WHERE attempt_id = ? AND state_kind = 'running'
         ORDER BY detected_at DESC, incident_id DESC LIMIT 1`,
      ).bind(result.attemptId).first<IncidentRow>();
      if (row === null) throw new Error('Running stuck incident projection is incomplete');
      const view = detectedView(row);
      detected.push(view);
      this.emit(view, 'run_stuck_detected', nowIso);
    }
    return detected;
  }

  private async detectRunStates(
    limit: number,
    now: Date,
    nowIso: string,
  ): Promise<RunStuckIncidentView[]> {
    const queuedCutoff = new Date(
      now.getTime() - this.thresholds.queued * 1_000,
    ).toISOString();
    const reviewCutoff = new Date(
      now.getTime() - this.thresholds.awaitingReview * 1_000,
    ).toISOString();
    const deployCutoff = new Date(
      now.getTime() - this.thresholds.deploying * 1_000,
    ).toISOString();
    const rows = await this.db.prepare(
      `SELECT run_id, state, version, updated_at FROM runs
       WHERE (state = 'queued' AND updated_at <= ?)
          OR (state = 'awaiting_review' AND updated_at <= ?)
          OR (state = 'deploying' AND updated_at <= ?)
       ORDER BY updated_at, run_id LIMIT ?`,
    ).bind(queuedCutoff, reviewCutoff, deployCutoff, limit).all<RunCandidateRow>();
    const detected: RunStuckIncidentView[] = [];
    for (const row of rows.results) {
      const thresholdSeconds = stateKindThreshold(row.state, this.thresholds);
      const cutoff = new Date(now.getTime() - thresholdSeconds * 1_000).toISOString();
      const incident = await this.openRunIncident(row, thresholdSeconds, cutoff, nowIso);
      if (incident !== null) {
        detected.push(incident);
        this.emit(incident, 'run_stuck_detected', nowIso);
      }
    }
    return detected;
  }

  private async openRunIncident(
    row: RunCandidateRow,
    thresholdSeconds: number,
    cutoff: string,
    nowIso: string,
  ): Promise<RunStuckIncidentView | null> {
    const incidentId = `run-stuck-${row.state}-${row.run_id}-${row.version}`;
    const insert = this.db.prepare(
      `INSERT INTO run_stuck_incidents (
         incident_id, run_id, state_kind, observed_run_state, run_version,
         attempt_id, threshold_seconds, action, status, detected_at,
         recovery_requested_at
       )
       SELECT ?, run_id, ?, state, version, NULL, ?, ?, 'open', ?, ?
       FROM runs
       WHERE run_id = ? AND state = ? AND version = ? AND updated_at <= ?
       ON CONFLICT DO NOTHING`,
    ).bind(
      incidentId,
      row.state,
      thresholdSeconds,
      actionFor(row.state),
      nowIso,
      nowIso,
      row.run_id,
      row.state,
      row.version,
      cutoff,
    );
    let inserted: D1Result;
    if (row.state === 'queued') {
      const results = await this.db.batch([
        insert,
        this.db.prepare(
          `UPDATE outbox
           SET delivery_state = 'pending', lease_token = NULL, lease_expires_at = NULL,
               last_error_code = 'stuck_requeued', updated_at = ?
           WHERE run_id = ? AND kind = 'workflow_create'
             AND destination = 'cloudflare_workflows'
             AND delivery_state = 'delivering'
             AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
             AND EXISTS (
               SELECT 1 FROM run_stuck_incidents
               WHERE incident_id = ? AND status = 'open'
             )`,
        ).bind(nowIso, row.run_id, nowIso, incidentId),
      ]);
      const insertResult = results[0];
      if (insertResult === undefined) {
        throw new Error('Queued stuck incident batch result is incomplete');
      }
      inserted = insertResult;
    } else {
      inserted = await insert.run();
    }
    if (inserted.meta.changes !== 1) return null;
    return {
      incidentId,
      runId: row.run_id,
      stateKind: row.state,
      observedRunState: row.state,
      runVersion: row.version,
      thresholdSeconds,
      action: actionFor(row.state),
      status: 'open',
      detectedAt: nowIso,
    };
  }

  private async resolveOpenIncidents(
    limit: number,
    nowIso: string,
  ): Promise<RunStuckIncidentView[]> {
    const rows = await this.db.prepare(
      `SELECT incidents.incident_id, incidents.run_id, incidents.state_kind,
              incidents.observed_run_state, incidents.run_version,
              incidents.attempt_id, incidents.threshold_seconds, incidents.action,
              incidents.status, incidents.detected_at, incidents.resolved_at,
              incidents.resolution_code, runs.state AS current_run_state,
              runs.version AS current_run_version,
              attempts.status AS current_attempt_status
       FROM run_stuck_incidents AS incidents
       JOIN runs ON runs.run_id = incidents.run_id
       LEFT JOIN attempts ON attempts.attempt_id = incidents.attempt_id
       WHERE incidents.status = 'open'
       ORDER BY incidents.detected_at, incidents.incident_id LIMIT ?`,
    ).bind(limit).all<OpenIncidentRow>();
    const resolved: RunStuckIncidentView[] = [];
    for (const row of rows.results) {
      const resolutionCode = this.resolutionCode(row);
      if (resolutionCode === null) continue;
      const result = await this.db.prepare(
        `UPDATE run_stuck_incidents
         SET status = 'resolved', resolved_at = ?, resolution_code = ?
         WHERE incident_id = ? AND status = 'open'`,
      ).bind(nowIso, resolutionCode, row.incident_id).run();
      if (result.meta.changes !== 1) continue;
      const view: RunStuckIncidentView = {
        ...incidentView(row),
        status: 'resolved',
        resolvedAt: nowIso,
        resolutionCode,
      };
      resolved.push(view);
      this.emit(view, 'run_stuck_resolved', nowIso);
    }
    return resolved;
  }

  private resolutionCode(row: OpenIncidentRow): RunStuckResolutionCode | null {
    if (row.state_kind === 'running') {
      if (row.current_attempt_status === 'lost') return 'attempt_fenced';
      if (
        row.current_attempt_status !== 'starting' &&
        row.current_attempt_status !== 'running'
      ) return 'run_progressed';
    }
    return row.current_run_state !== row.observed_run_state ||
      row.current_run_version !== row.run_version
      ? 'run_progressed'
      : null;
  }

  private emit(
    incident: RunStuckIncidentView,
    event: RunStuckLogRecord['event'],
    observedAt: string,
  ): void {
    try {
      this.sink({
        schemaVersion: '1',
        event,
        incidentId: incident.incidentId,
        correlationId: incident.runId,
        runId: incident.runId,
        stateKind: incident.stateKind,
        observedRunState: incident.observedRunState,
        runVersion: incident.runVersion,
        thresholdSeconds: incident.thresholdSeconds,
        action: incident.action,
        status: incident.status,
        ...(incident.attemptId === undefined ? {} : { attemptId: incident.attemptId }),
        ...(incident.resolutionCode === undefined
          ? {}
          : { resolutionCode: incident.resolutionCode }),
        observedAt,
      });
    } catch {
      // A log sink failure cannot roll back a durable incident or recovery action.
    }
  }
}
