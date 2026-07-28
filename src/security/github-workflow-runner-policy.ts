import { Buffer } from 'node:buffer';
import { parseDocument } from 'yaml';

export const PUBLIC_REPOSITORY_GITHUB_HOSTED_RUNNER = 'ubuntu-latest';
export const MAX_GITHUB_WORKFLOW_BYTES = 256 * 1_024;

const WORKFLOW_PATH_PATTERN = /^[.]github\/workflows\/[A-Za-z0-9._-]+[.]ya?ml$/;
const JOB_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;

export interface GitHubWorkflowSource {
  path: string;
  source: string;
}

export interface GitHubWorkflowRunnerPolicySummary {
  workflowCount: number;
  jobCount: number;
}

function rejected(code: string): never {
  throw new Error(`GitHub workflow runner policy rejected: ${code}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fail-closed runner selection policy for this public repository.
 *
 * A future JIT/private execution design must first replace this contract with
 * a separately reviewed policy. Repository variables, matrix values, arrays,
 * reusable jobs, and self-hosted labels cannot silently change the trust
 * boundary of an existing workflow.
 */
export function verifyPublicRepositoryWorkflowRunnerPolicy(
  workflows: readonly GitHubWorkflowSource[],
): GitHubWorkflowRunnerPolicySummary {
  if (workflows.length === 0) rejected('inventory_empty');
  const paths = new Set<string>();
  let jobCount = 0;

  for (const workflow of workflows) {
    if (!WORKFLOW_PATH_PATTERN.test(workflow.path) || paths.has(workflow.path)) {
      rejected('workflow_path_invalid');
    }
    paths.add(workflow.path);
    if (
      workflow.source.length === 0 ||
      Buffer.byteLength(workflow.source, 'utf8') > MAX_GITHUB_WORKFLOW_BYTES
    ) {
      rejected('workflow_source_size_invalid');
    }

    const document = parseDocument(workflow.source, {
      prettyErrors: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      rejected('workflow_yaml_invalid');
    }

    let parsed: unknown;
    try {
      parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
    } catch {
      rejected('workflow_yaml_alias_rejected');
    }
    if (!isRecord(parsed) || !isRecord(parsed.jobs)) {
      rejected('workflow_jobs_invalid');
    }
    const jobs = Object.entries(parsed.jobs);
    if (jobs.length === 0) rejected('workflow_jobs_empty');

    for (const [jobId, candidate] of jobs) {
      if (!JOB_ID_PATTERN.test(jobId) || !isRecord(candidate)) {
        rejected('workflow_job_invalid');
      }
      if ('uses' in candidate) rejected('reusable_job_not_reviewed');
      if (candidate['runs-on'] !== PUBLIC_REPOSITORY_GITHUB_HOSTED_RUNNER) {
        rejected('runner_label_not_reviewed');
      }
      jobCount += 1;
    }
  }

  return { workflowCount: workflows.length, jobCount };
}
