export const DELIVERY_AGENT_WORKFLOW_FILE = '.github/workflows/delivery-agent.yml';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_REF_PATTERN = /^refs\/heads\/([^\s]{1,255})$/;

export interface GitHubAgentExecutorBinding {
  repository: string;
  ref: string;
  branch: string;
  workflowRef: string;
}

export function githubAgentExecutorBinding(
  repository: string,
  ref: string,
): GitHubAgentExecutorBinding {
  const branch = BRANCH_REF_PATTERN.exec(ref)?.[1];
  if (!REPOSITORY_PATTERN.test(repository) || branch === undefined || branch.includes('..')) {
    throw new Error('GitHub Agent executor configuration is invalid');
  }
  return {
    repository,
    ref,
    branch,
    workflowRef: `${repository}/${DELIVERY_AGENT_WORKFLOW_FILE}@${ref}`,
  };
}

export function parseGitHubAgentWorkflowRef(
  workflowRef: string | null,
): GitHubAgentExecutorBinding | null {
  if (workflowRef === null) return null;
  const marker = `/${DELIVERY_AGENT_WORKFLOW_FILE}@`;
  const markerIndex = workflowRef.indexOf(marker);
  if (markerIndex <= 0) return null;
  try {
    const repository = workflowRef.slice(0, markerIndex);
    const ref = workflowRef.slice(markerIndex + marker.length);
    const binding = githubAgentExecutorBinding(repository, ref);
    return binding.workflowRef === workflowRef ? binding : null;
  } catch {
    return null;
  }
}
