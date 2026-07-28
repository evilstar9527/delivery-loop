import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MonitorAlertEvidenceManifestV1Schema } from
  '../src/domain/monitor-alert-evidence.js';
import {
  MonitorAlertEvidenceVerificationError,
  verifyMonitorAlertEvidence,
} from '../src/pilot/monitor-alert-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function prerequisite(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Reuses Watt scripts/e2e/lib.ts@476e3cd's explicit 0/1/2 exit discipline.
  if (process.env.DELIVERY_LOOP_MONITOR_ALERT_E2E !== '1') {
    console.error(
      'monitor-alert-e2e: opt-in missing (set DELIVERY_LOOP_MONITOR_ALERT_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = prerequisite('MONITOR_ALERT_EVIDENCE_FILE');
  const cloudflareApiUrl = prerequisite('MONITOR_ALERT_CLOUDFLARE_API_URL');
  const cloudflareApiToken = prerequisite('MONITOR_ALERT_CLOUDFLARE_API_TOKEN');
  const canary = prerequisite('MONITOR_ALERT_CANARY_SECRET');
  if (
    manifestFile === '' || cloudflareApiUrl === '' ||
    cloudflareApiToken === '' || canary === ''
  ) {
    console.error('monitor-alert-e2e: required evidence configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try { source = await readFile(resolve(manifestFile), 'utf8'); }
  catch {
    console.error('monitor-alert-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('monitor-alert-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try { input = JSON.parse(source) as unknown; }
  catch {
    console.error('monitor-alert-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = MonitorAlertEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('monitor-alert-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const enabled = parsed.data.mode === 'enabled' ? {
    controlPlaneOrigin: prerequisite('MONITOR_ALERT_CONTROL_PLANE_URL'),
    operationsToken: prerequisite('MONITOR_ALERT_OPERATIONS_TOKEN'),
    observabilityReportUrl: prerequisite('MONITOR_ALERT_OBSERVABILITY_URL'),
    observabilityToken: prerequisite('MONITOR_ALERT_OBSERVABILITY_TOKEN'),
    sentryApiOrigin: prerequisite('MONITOR_ALERT_SENTRY_API_URL'),
    sentryReadToken: prerequisite('MONITOR_ALERT_SENTRY_READ_TOKEN'),
  } : {};
  if (
    parsed.data.mode === 'enabled' && Object.values(enabled).some((value) => value === '')
  ) {
    console.error('monitor-alert-e2e: required enabled evidence configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  try {
    const summary = await verifyMonitorAlertEvidence(parsed.data, {
      cloudflareApiUrl,
      cloudflareApiToken,
      canary,
      ...enabled,
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof MonitorAlertEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`monitor-alert-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
