import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  verifyPublicRepositoryWorkflowRunnerPolicy,
  type GitHubWorkflowSource,
} from '../src/security/github-workflow-runner-policy.js';

function workflow(runsOn: string): GitHubWorkflowSource {
  return {
    path: '.github/workflows/example.yml',
    source: `name: example
on: workflow_dispatch
jobs:
  verify:
    runs-on: ${runsOn}
    steps:
      - run: true
`,
  };
}

describe('public repository GitHub workflow runner policy', () => {
  it('accepts only the reviewed GitHub-hosted runner label', () => {
    expect(verifyPublicRepositoryWorkflowRunnerPolicy([
      workflow('ubuntu-latest'),
    ])).toEqual({ workflowCount: 1, jobCount: 1 });
  });

  it.each([
    ['a persistent self-hosted label', 'self-hosted'],
    ['a self-hosted label set', '[self-hosted, linux, x64]'],
    ['a dynamic repository variable', "${{ fromJSON(vars.RUNNER_LABELS) }}"],
    ['an unreviewed hosted label', 'ubuntu-24.04'],
  ])('rejects %s', (_label, runsOn) => {
    expect(() => verifyPublicRepositoryWorkflowRunnerPolicy([
      workflow(runsOn),
    ])).toThrow('GitHub workflow runner policy rejected');
  });

  it('rejects aliases, malformed jobs, and workflow bodies over the bound', () => {
    const aliased = workflow('&runner ubuntu-latest').source.replace(
      'steps:',
      'other-runs-on: *runner\n    steps:',
    );
    expect(() => verifyPublicRepositoryWorkflowRunnerPolicy([{
      path: '.github/workflows/alias.yml',
      source: aliased,
    }])).toThrow('GitHub workflow runner policy rejected');
    expect(() => verifyPublicRepositoryWorkflowRunnerPolicy([{
      path: '.github/workflows/malformed.yml',
      source: 'name: malformed\njobs: []\n',
    }])).toThrow('GitHub workflow runner policy rejected');
    expect(() => verifyPublicRepositoryWorkflowRunnerPolicy([{
      path: '.github/workflows/oversized.yml',
      source: ' '.repeat(256 * 1_024 + 1),
    }])).toThrow('GitHub workflow runner policy rejected');
  });

  it('accepts the complete current workflow inventory', async () => {
    const directory = resolve('.github/workflows');
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /[.]ya?ml$/.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    const sources = await Promise.all(entries.map(async (entry) => ({
      path: `.github/workflows/${entry.name}`,
      source: await readFile(resolve(directory, entry.name), 'utf8'),
    })));
    expect(verifyPublicRepositoryWorkflowRunnerPolicy(sources)).toEqual({
      workflowCount: 15,
      jobCount: 17,
    });
  });
});
