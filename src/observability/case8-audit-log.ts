import type { Case8AuditReport } from '../storage/case8-audit-report-store.js';
import { secureStructuredLogSink } from './structured-log.js';

export interface Case8AuditLogRecord {
  schemaVersion: '1';
  event: 'case8_audit_report_generated';
  runId: string;
  reportDigest: string;
  queryDurationMs: number;
  sourceEventCount: number;
  contextCategoryCount: number;
  changeCount: number;
  approvalCount: number;
  deploymentCount: number;
  linkCount: number;
  observedAt: string;
}

export type Case8AuditLogSink = (record: Case8AuditLogRecord) => void;

/** Emits only allowlisted IDs, counts, timing and a canonical digest. */
export class Case8AuditLogger {
  constructor(
    private readonly sink: Case8AuditLogSink = secureStructuredLogSink({
      component: 'case8_audit',
    }),
  ) {}

  generated(report: Case8AuditReport): void {
    this.sink({
      schemaVersion: '1',
      event: 'case8_audit_report_generated',
      runId: report.runId,
      reportDigest: report.reportDigest,
      queryDurationMs: report.queryDurationMs,
      sourceEventCount: report.answers.sourceEvents.length,
      contextCategoryCount: report.answers.contextReads.length,
      changeCount: report.answers.changes.length,
      approvalCount: report.answers.approvals.length,
      deploymentCount: report.answers.deployments.length,
      linkCount: report.links.length,
      observedAt: report.generatedAt,
    });
  }
}
