import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;

const ExternalUrlSchema = z.url().max(2_000).refine((raw) => {
  const url = new URL(raw);
  return url.protocol === 'https:' && url.username === '' && url.password === '' &&
    url.search === '' && url.hash === '';
});

export const GitHubProductionDeploymentStatusFactSchema = z.object({
  schemaVersion: z.literal('1'),
  repository: z.string().regex(REPOSITORY_PATTERN),
  githubDeploymentId: z.string().regex(/^[1-9][0-9]{0,31}$/),
  deploymentId: z.string().regex(ID_PATTERN),
  sha: z.string().regex(SHA_PATTERN),
  task: z.literal('delivery-loop:production'),
  environment: z.literal('production'),
  state: z.enum(['in_progress', 'success', 'failure', 'error']),
  environmentUrl: ExternalUrlSchema.nullable(),
  externalUpdatedAt: z.iso.datetime({ offset: true }),
}).strict();

export type GitHubProductionDeploymentStatusFact =
  z.infer<typeof GitHubProductionDeploymentStatusFactSchema>;
