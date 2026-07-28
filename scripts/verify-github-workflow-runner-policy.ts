import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  verifyPublicRepositoryWorkflowRunnerPolicy,
  type GitHubWorkflowSource,
} from '../src/security/github-workflow-runner-policy.js';

const root = resolve('.github/workflows');
const entries = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => /[.]ya?ml$/.test(entry.name))
  .sort((left, right) => left.name.localeCompare(right.name));
const workflows: GitHubWorkflowSource[] = [];

for (const entry of entries) {
  if (!entry.isFile()) {
    throw new Error('GitHub workflow runner policy rejected: workflow_entry_not_file');
  }
  workflows.push({
    path: `.github/workflows/${entry.name}`,
    source: await readFile(resolve(root, entry.name), 'utf8'),
  });
}

const summary = verifyPublicRepositoryWorkflowRunnerPolicy(workflows);
process.stdout.write(
  `GitHub workflow runner policy verified ${summary.workflowCount} workflows and ${summary.jobCount} jobs.\n`,
);
