import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ControlledReplayEvidenceManifestV1Schema } from '../src/domain/controlled-replay-evidence.js';
import {
  ControlledReplayEvidenceVerificationError,
  verifyControlledReplayEvidence,
} from '../src/pilot/controlled-replay-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function prerequisite(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Directly reuses the Watt-derived E2E discipline used by Pilot/Runner recovery:
  // 0=verified, 1=fact/assertion failure, 2=explicit prerequisite missing.
  if (process.env.DELIVERY_LOOP_CONTROLLED_REPLAY_E2E !== '1') {
    console.error(
      'controlled-replay-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_CONTROLLED_REPLAY_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = prerequisite('CONTROLLED_REPLAY_EVIDENCE_FILE');
  const controlPlaneOrigin = prerequisite('CONTROLLED_REPLAY_CONTROL_PLANE_URL');
  const operationsToken = prerequisite('CONTROLLED_REPLAY_OPERATIONS_TOKEN');
  const queryToken = prerequisite('CONTROLLED_REPLAY_QUERY_TOKEN');
  const githubToken = prerequisite('CONTROLLED_REPLAY_GITHUB_TOKEN');
  if (
    manifestFile === '' || controlPlaneOrigin === '' || operationsToken === '' ||
    queryToken === '' || githubToken === ''
  ) {
    console.error('controlled-replay-e2e: required replay configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('controlled-replay-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('controlled-replay-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('controlled-replay-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = ControlledReplayEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('controlled-replay-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyControlledReplayEvidence(parsed.data, {
      controlPlaneOrigin,
      operationsToken,
      queryToken,
      githubToken,
      ...(prerequisite('CONTROLLED_REPLAY_GITHUB_API_URL') === ''
        ? {}
        : { githubApiOrigin: prerequisite('CONTROLLED_REPLAY_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof ControlledReplayEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`controlled-replay-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
