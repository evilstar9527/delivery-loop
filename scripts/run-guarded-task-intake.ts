import { readFileSync, statSync } from 'node:fs';
import {
  GuardedTaskIntakeError,
  runGuardedTaskIntake,
} from '../src/pilot/guarded-task-intake.js';

function env(name: string): string {
  return process.env[name] ?? '';
}

function taskFromEventFile(path: string): unknown {
  const size = statSync(path).size;
  if (!Number.isSafeInteger(size) || size <= 0 || size > 256 * 1_024) throw new Error();
  const event = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof event !== 'object' || event === null || Array.isArray(event)) throw new Error();
  const inputs = (event as { inputs?: unknown }).inputs;
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) throw new Error();
  const taskJson = (inputs as { task_json?: unknown }).task_json;
  if (typeof taskJson !== 'string') throw new Error();
  return JSON.parse(taskJson) as unknown;
}

async function main(): Promise<void> {
  if (env('DELIVERY_LOOP_GUARDED_TASK_INTAKE') !== '1') {
    console.error('guarded-task-intake: opt-in missing');
    process.exitCode = 2;
    return;
  }
  const eventPath = env('GITHUB_EVENT_PATH');
  const configuration = {
    controlPlaneOrigin: env('GUARDED_TASK_INTAKE_CONTROL_PLANE_URL'),
    githubApiOrigin: env('GITHUB_API_URL'),
    repository: env('GITHUB_REPOSITORY'),
    taskToken: env('GUARDED_TASK_INTAKE_TASK_TOKEN'),
    githubToken: env('GUARDED_TASK_INTAKE_GITHUB_TOKEN'),
  };
  if (eventPath === '' || Object.values(configuration).some((value) => value === '')) {
    console.error('guarded-task-intake: required configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let task: unknown;
  try { task = taskFromEventFile(eventPath); } catch {
    console.error('guarded-task-intake: FAIL task_input_invalid taskCreateRequests=0');
    process.exitCode = 1;
    return;
  }
  try {
    console.log(JSON.stringify(await runGuardedTaskIntake({ ...configuration, task })));
  } catch (error) {
    const code = error instanceof GuardedTaskIntakeError ? error.code : 'execution_failed';
    const requests = error instanceof GuardedTaskIntakeError ? error.taskCreateRequests : 0;
    console.error(`guarded-task-intake: FAIL ${code} taskCreateRequests=${requests}`);
    process.exitCode = code === 'configuration_invalid' ? 2 : 1;
  }
}

await main();
