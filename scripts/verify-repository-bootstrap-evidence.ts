import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RepositoryBootstrapEvidenceManifestV1Schema } from '../src/domain/repository-bootstrap-evidence.js';
import {
  RepositoryBootstrapEvidenceVerificationError,
  verifyRepositoryBootstrapEvidence,
} from '../src/pilot/repository-bootstrap-evidence-verifier.js';
import { executeGitCommand } from '../src/runner/git-repository-writer.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_REPOSITORY_BOOTSTRAP_E2E !== '1') {
    console.error(
      'repository-bootstrap-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_REPOSITORY_BOOTSTRAP_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('REPOSITORY_BOOTSTRAP_EVIDENCE_FILE');
  const githubToken = env('REPOSITORY_BOOTSTRAP_GITHUB_TOKEN');
  if (manifestFile === '' || githubToken === '') {
    console.error('repository-bootstrap-e2e: required repository configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('repository-bootstrap-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('repository-bootstrap-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try { input = JSON.parse(source) as unknown; }
  catch {
    console.error('repository-bootstrap-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = RepositoryBootstrapEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('repository-bootstrap-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let localOriginUrl: string;
  try {
    const result = await executeGitCommand({
      repositoryPath: resolve('.'),
      args: ['remote', 'get-url', 'origin'],
    });
    localOriginUrl = result.stdout.trim();
    if (result.exitCode !== 0 || localOriginUrl === '') throw new Error('origin');
  } catch {
    console.error('repository-bootstrap-e2e: local origin is unavailable');
    process.exitCode = 2;
    return;
  }
  try {
    const summary = await verifyRepositoryBootstrapEvidence(parsed.data, {
      githubToken,
      localOriginUrl,
      ...(env('REPOSITORY_BOOTSTRAP_GITHUB_API_URL') === ''
        ? {} : { githubApiOrigin: env('REPOSITORY_BOOTSTRAP_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof RepositoryBootstrapEvidenceVerificationError
      ? error.code : 'verification_failed';
    console.error(`repository-bootstrap-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
