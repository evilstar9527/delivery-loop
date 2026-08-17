#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import process from 'node:process';

const SPEC_MAX_BYTES = 64 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const SECRET_KEY_PATTERN = /secret|token|password|credential|private.?key|api.?key|authorization/i;

function fail(code) {
  process.stderr.write(`delivery-agent bootstrap failed: ${code}\n`);
  process.exit(1);
}

const specPath = process.argv[2];
if (typeof specPath !== 'string' || !specPath.startsWith('/workspace/.delivery-loop/')) {
  fail('invalid_spec_path');
}

let raw;
try {
  const metadata = await stat(specPath);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > SPEC_MAX_BYTES) {
    fail('invalid_spec_file');
  }
  raw = await readFile(specPath, 'utf8');
} catch {
  fail('spec_unavailable');
}

let spec;
try {
  spec = JSON.parse(raw);
} catch {
  fail('invalid_spec_json');
}
if (
  typeof spec !== 'object' || spec === null || Array.isArray(spec) ||
  Object.keys(spec).some((key) => SECRET_KEY_PATTERN.test(key)) ||
  spec.schemaVersion !== '1' || !ID_PATTERN.test(spec.executionId) ||
  !ID_PATTERN.test(spec.attemptId) || !['work', 'publisher'].includes(spec.role) ||
  !['analysis', 'implement', 'review_fix'].includes(spec.mode) ||
  (spec.role === 'publisher'
    ? !ID_PATTERN.test(spec.patchArtifactId)
    : spec.patchArtifactId !== undefined)
) {
  fail('invalid_execution_spec');
}

const grantPath = '/workspace/.delivery-loop/execution-grant.json';
let grantRaw;
try {
  const grant = await stat(grantPath);
  if (!grant.isFile() || grant.size < 2 || grant.size > SPEC_MAX_BYTES) {
    fail('execution_grant_unavailable');
  }
  grantRaw = await readFile(grantPath, 'utf8');
} catch {
  fail('execution_grant_unavailable');
}

let grant;
try {
  grant = JSON.parse(grantRaw);
} catch {
  fail('invalid_execution_grant');
}
if (
  typeof grant !== 'object' || grant === null || Array.isArray(grant) ||
  Object.keys(grant).sort().join(',') !==
    'attemptId,controlPlaneUrl,executionId,identityKind,schemaVersion' ||
  grant.schemaVersion !== '1' || grant.identityKind !== 'cloudflare_sandbox_proxy' ||
  grant.executionId !== spec.executionId || grant.attemptId !== spec.attemptId ||
  grant.controlPlaneUrl !== 'http://control.delivery-loop.internal'
) {
  fail('invalid_execution_grant');
}

const script = spec.role === 'publisher'
  ? 'scripts/run-publisher-attempt.ts'
  : spec.mode === 'analysis'
    ? 'scripts/run-analysis-attempt.ts'
    : 'scripts/run-execution-attempt.ts';
const child = spawn('pnpm', ['exec', 'tsx', script], {
  cwd: '/opt/delivery-agent',
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH,
    DELIVERY_EXECUTION_SPEC_PATH: specPath,
    DELIVERY_EXECUTION_GRANT_PATH: grantPath,
    DELIVERY_EXECUTOR_IDENTITY_KIND: grant.identityKind,
    DELIVERY_EXECUTION_ID: grant.executionId,
    ...(spec.patchArtifactId === undefined
      ? {}
      : { DELIVERY_PATCH_ARTIFACT_ID: spec.patchArtifactId }),
    DELIVERY_SCHEMA_VERSION: spec.schemaVersion,
    DELIVERY_RUN_ID: spec.runId,
    DELIVERY_ATTEMPT_ID: spec.attemptId,
    DELIVERY_TASK_DIGEST: spec.taskDigest,
    DELIVERY_BASE_SHA: spec.baseSha,
    DELIVERY_CHECKOUT_SHA: spec.checkoutSha,
    DELIVERY_ATTEMPT_MODE: spec.mode,
    DELIVERY_TARGET_REPOSITORY: spec.repository,
    DELIVERY_CONTROL_PLANE_URL: grant.controlPlaneUrl,
    DELIVERY_REPOSITORY_PATH: '/workspace/repository',
    RUNNER_TEMP: '/workspace/.delivery-loop/tmp',
    ...(spec.planVersion === undefined ? {} : { DELIVERY_PLAN_VERSION: String(spec.planVersion) }),
    ...(spec.planItemId === undefined ? {} : { DELIVERY_PLAN_ITEM_ID: spec.planItemId }),
    ...(spec.modelProfileId === undefined
      ? {}
      : { DELIVERY_MODEL_PROFILE_ID: spec.modelProfileId }),
  },
});
child.once('error', () => fail('runner_start_failed'));
child.once('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
