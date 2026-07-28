import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SevenDayTrialEvidenceManifestV1Schema } from '../src/domain/seven-day-trial-evidence.js';
import {
  SevenDayTrialVerificationError,
  verifySevenDayTrialEvidence,
} from '../src/pilot/seven-day-trial-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function prerequisite(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Copied from the Watt-derived Pilot E2E command discipline:
  // 0=verified, 1=fact/assertion failure, 2=explicit prerequisite missing.
  if (process.env.DELIVERY_LOOP_SEVEN_DAY_TRIAL_E2E !== '1') {
    console.error(
      'seven-day-trial: opt-in missing (set DELIVERY_LOOP_SEVEN_DAY_TRIAL_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = prerequisite('SEVEN_DAY_TRIAL_EVIDENCE_FILE');
  const controlPlaneOrigin = prerequisite('SEVEN_DAY_TRIAL_CONTROL_PLANE_URL');
  const observabilityReportUrl = prerequisite('SEVEN_DAY_TRIAL_OBSERVABILITY_URL');
  const operationsToken = prerequisite('SEVEN_DAY_TRIAL_OPERATIONS_TOKEN');
  const githubToken = prerequisite('SEVEN_DAY_TRIAL_GITHUB_TOKEN');
  const observabilityToken = prerequisite('SEVEN_DAY_TRIAL_OBSERVABILITY_TOKEN');
  if (
    manifestFile === '' || controlPlaneOrigin === '' || observabilityReportUrl === '' ||
    operationsToken === '' ||
    githubToken === '' || observabilityToken === ''
  ) {
    console.error('seven-day-trial: required configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('seven-day-trial: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('seven-day-trial: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('seven-day-trial: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = SevenDayTrialEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('seven-day-trial: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifySevenDayTrialEvidence(parsed.data, {
      controlPlaneOrigin,
      observabilityReportUrl,
      operationsToken,
      githubToken,
      observabilityToken,
      ...(prerequisite('SEVEN_DAY_TRIAL_GITHUB_API_URL') === ''
        ? {}
        : { githubApiOrigin: prerequisite('SEVEN_DAY_TRIAL_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof SevenDayTrialVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`seven-day-trial: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
