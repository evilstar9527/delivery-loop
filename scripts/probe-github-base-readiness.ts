import {
  createGitHubBaseReadinessProbe,
  GitHubBaseReadinessProbeError,
} from '../src/pilot/github-base-readiness-probe.js';

function rawEnv(name: string): string {
  return process.env[name] ?? '';
}

async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_GITHUB_BASE_READINESS !== '1') {
    console.error('github-base-readiness: opt-in missing');
    process.exitCode = 2;
    return;
  }
  const configuration = {
    controlPlaneOrigin: rawEnv('GITHUB_BASE_READINESS_CONTROL_PLANE_URL'),
    repository: rawEnv('GITHUB_BASE_READINESS_REPOSITORY'),
    baseBranch: rawEnv('GITHUB_BASE_READINESS_BASE_BRANCH'),
  };
  if (Object.values(configuration).some((value) => value === '')) {
    console.error('github-base-readiness: required configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  const operationsToken = rawEnv('GITHUB_BASE_READINESS_OPERATIONS_TOKEN');
  if (operationsToken === '') {
    console.error('github-base-readiness: required configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  try {
    const summary = await createGitHubBaseReadinessProbe({
      ...configuration,
      operationsToken,
    }).run();
    const output = JSON.stringify(summary);
    if (summary.ready) console.log(output);
    else {
      console.error(output);
      process.exitCode = 1;
    }
  } catch (error) {
    const code = error instanceof GitHubBaseReadinessProbeError
      ? error.code : 'execution_failed';
    const attempts = error instanceof GitHubBaseReadinessProbeError
      ? error.requestAttempts : 0;
    console.error(`github-base-readiness: FAIL ${code} requestAttempts=${attempts}`);
    process.exitCode = code === 'configuration_invalid' ? 2 : 1;
  }
}

await main();
