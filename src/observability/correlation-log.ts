import type { CorrelationView } from '../storage/correlation-query-store.js';
import { secureStructuredLogSink } from './structured-log.js';

const LOG_ID_LIMIT = 50;

export interface CorrelationLogRecord {
  schemaVersion: '1';
  event: 'correlation_lookup';
  correlationId: string;
  taskId: string;
  runId: string;
  attemptIds: string[];
  githubRunIds: string[];
  pullRequestNumbers: number[];
  deploymentIds: string[];
  githubDeploymentIds: string[];
  traceIds: string[];
  matchedByKind: CorrelationView['matchedBy']['kind'];
  matchedById: string;
  matchedByRepository?: string;
  observedAt: string;
}

export type CorrelationLogSink = (record: CorrelationLogRecord) => void;

function strings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))]
    .sort()
    .slice(0, LOG_ID_LIMIT);
}

function numbers(values: unknown[]): number[] {
  return [...new Set(values.filter(
    (value): value is number => typeof value === 'number' && Number.isSafeInteger(value),
  ))].sort((left, right) => left - right).slice(0, LOG_ID_LIMIT);
}

/** Emits one allowlisted structured log record; it has no free-form field. */
export class CorrelationLogger {
  private readonly now: () => Date;

  constructor(
    private readonly sink: CorrelationLogSink = secureStructuredLogSink({
      component: 'correlation',
    }),
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  lookup(view: CorrelationView): void {
    this.sink({
      schemaVersion: '1',
      event: 'correlation_lookup',
      correlationId: view.correlationId,
      taskId: view.task.id,
      runId: view.run.id,
      attemptIds: strings(view.attempts.map((attempt) => attempt.id)),
      githubRunIds: strings(view.githubRuns.map((run) => run.id)),
      pullRequestNumbers: numbers(view.pullRequests.map((pullRequest) => pullRequest.number)),
      deploymentIds: strings(view.deployments.map((deployment) => deployment.id)),
      githubDeploymentIds: strings(
        view.deployments.map((deployment) => deployment.githubDeploymentId),
      ),
      traceIds: strings(view.traces.map((trace) => trace.id)),
      matchedByKind: view.matchedBy.kind,
      matchedById: view.matchedBy.id,
      ...(view.matchedBy.repository === undefined
        ? {}
        : { matchedByRepository: view.matchedBy.repository }),
      observedAt: this.now().toISOString(),
    });
  }
}
