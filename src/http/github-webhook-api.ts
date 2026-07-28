import { Hono } from 'hono';
import { z } from 'zod';
import { canonicalSha256, sha256Bytes } from '../domain/digest.js';
import type { GitHubPullRequestMergeFact } from '../domain/github-merge-status.js';
import type { Bindings } from '../env.js';
import { configuredSecrets } from '../security/runtime-secrets.js';
import type { GitHubPullRequestFact } from '../outbox/github-pull-request.js';
import {
  GitHubReviewFeedbackError,
  GitHubReviewFeedbackStore,
  type GitHubReviewFeedbackFact,
} from '../storage/github-review-feedback-store.js';
import {
  GitHubMergeStatusError,
  GitHubMergeStatusStore,
} from '../storage/github-merge-status-store.js';
import {
  GitHubPullRequestObservationError,
  GitHubPullRequestObservationStore,
} from '../storage/github-pull-request-observation-store.js';
import {
  GitHubRunObservationError,
  GitHubRunObservationStore,
  type GitHubWorkflowRunFact,
  type GitHubWorkflowRunStatus,
} from '../storage/github-run-observation-store.js';
import {
  GitHubTestAcceptanceStatusError,
  GitHubTestAcceptanceStatusStore,
} from '../storage/github-test-acceptance-status-store.js';
import {
  GitHubTestRollbackStatusError,
  GitHubTestRollbackStatusStore,
} from '../storage/github-test-rollback-status-store.js';
import {
  GitHubTestDeploymentStatusError,
  GitHubTestDeploymentStatusStore,
  type GitHubTestDeploymentStatusFact,
} from '../storage/github-test-deployment-status-store.js';
import {
  GitHubProductionDeploymentStatusError,
  GitHubProductionDeploymentStatusStore,
} from '../storage/github-production-deployment-status-store.js';
import type { GitHubProductionDeploymentStatusFact } from '../domain/production-deployment-status.js';
import {
  TEST_ACCEPTANCE_WORKFLOW_PATH,
  TEST_ROLLBACK_WORKFLOW_PATH,
} from '../domain/delivery-policy.js';
import { errorResponse } from './errors.js';

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const DELIVERY_ID_PATTERN = /^[A-Fa-f0-9-]{16,64}$/;
const SIGNATURE_PATTERN = /^sha256=([a-f0-9]{64})$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const WORKFLOW_STATUSES = [
  'requested',
  'queued',
  'waiting',
  'in_progress',
  'completed',
] as const;
const WORKFLOW_CONCLUSIONS = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure',
] as const;

const GitHubRunIdSchema = z.union([
  z.string().regex(/^[0-9]+$/).max(32),
  z.number().int().positive().safe(),
]);

const WorkflowRunWebhookSchema = z.object({
  action: z.enum(['requested', 'in_progress', 'completed']),
  workflow_run: z.object({
    id: GitHubRunIdSchema,
    event: z.literal('workflow_dispatch'),
    status: z.enum(WORKFLOW_STATUSES),
    conclusion: z.enum(WORKFLOW_CONCLUSIONS).nullable(),
    head_sha: z.string().regex(SHA_PATTERN),
    head_branch: z.string().min(1).max(255),
    path: z.string().min(1).max(500),
    display_title: z.string().min(1).max(300),
    run_attempt: z.number().int().positive(),
    updated_at: z.iso.datetime({ offset: true }),
  }),
  repository: z.object({
    full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201),
  }),
});

const PullRequestWebhookSchema = z.object({
  action: z.literal('opened'),
  number: z.number().int().positive().safe(),
  pull_request: z.object({
    html_url: z.url().max(2_000),
    state: z.literal('open'),
    draft: z.literal(true),
    title: z.string().min(1).max(256),
    body: z.string().min(1).max(65_536),
    head: z.object({
      ref: z.string().min(1).max(240),
      sha: z.string().regex(SHA_PATTERN),
      repo: z.object({
        full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201),
      }),
    }),
    base: z.object({
      ref: z.string().min(1).max(240),
      repo: z.object({
        full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201),
      }),
    }),
    updated_at: z.iso.datetime({ offset: true }),
  }),
  repository: z.object({
    full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201),
  }),
});

const PullRequestMergedWebhookSchema = z.object({
  action: z.literal('closed'),
  number: z.number().int().positive().safe(),
  pull_request: z.object({
    html_url: z.url().max(2_000),
    state: z.literal('closed'),
    merged: z.literal(true),
    merge_commit_sha: z.string().regex(SHA_PATTERN),
    merged_at: z.iso.datetime({ offset: true }),
    merged_by: z.object({
      login: z.string().min(1).max(100),
    }),
    head: z.object({
      ref: z.string().min(1).max(240),
      sha: z.string().regex(SHA_PATTERN),
      repo: z.object({
        full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201),
      }),
    }),
    base: z.object({
      ref: z.string().min(1).max(240),
      repo: z.object({
        full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201),
      }),
    }),
    updated_at: z.iso.datetime({ offset: true }),
  }),
  repository: z.object({
    full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201),
  }),
});

const PullRequestReviewWebhookSchema = z.object({
  action: z.literal('submitted'),
  review: z.object({
    id: GitHubRunIdSchema,
    body: z.string().min(1).max(65_536).refine((body) => body.trim().length > 0),
    state: z.literal('changes_requested'),
    commit_id: z.string().regex(SHA_PATTERN),
    html_url: z.url().max(2_000),
    submitted_at: z.iso.datetime({ offset: true }),
  }),
  pull_request: z.object({
    number: z.number().int().positive().safe(),
    head: z.object({
      ref: z.string().min(1).max(240),
      sha: z.string().regex(SHA_PATTERN),
      repo: z.object({
        full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201),
      }),
    }),
    base: z.object({
      ref: z.string().min(1).max(240),
      repo: z.object({
        full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201),
      }),
    }),
  }),
  repository: z.object({
    full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201),
  }),
});

const DeploymentStatusWebhookSchema = z.object({
  deployment_status: z.object({
    state: z.enum(['in_progress', 'success', 'failure', 'error']),
    environment: z.literal('test'),
    environment_url: z.string().max(2_000).nullable(),
    updated_at: z.iso.datetime({ offset: true }),
  }),
  deployment: z.object({
    id: GitHubRunIdSchema,
    sha: z.string().regex(SHA_PATTERN),
    task: z.literal('delivery-loop:test'),
    environment: z.literal('test'),
    payload: z.object({
      schema_version: z.literal('1'),
      delivery_deployment_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
    }),
  }),
  repository: z.object({
    full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201),
  }),
});

const ProductionDeploymentStatusWebhookSchema = z.object({
  deployment_status: z.object({
    state: z.enum(['in_progress', 'success', 'failure', 'error']),
    environment: z.literal('production'),
    environment_url: z.string().max(2_000).nullable(),
    updated_at: z.iso.datetime({ offset: true }),
  }),
  deployment: z.object({
    id: GitHubRunIdSchema,
    sha: z.string().regex(SHA_PATTERN),
    task: z.literal('delivery-loop:production'),
    environment: z.literal('production'),
    payload: z.object({
      schema_version: z.literal('1'),
      delivery_production_deployment_id:
        z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
    }),
  }),
  repository: z.object({
    full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201),
  }),
});

function signatureBytes(header: string | undefined): ArrayBuffer | null {
  const match = header?.match(SIGNATURE_PATTERN);
  if (match?.[1] === undefined) return null;
  const hex = match[1];
  const buffer = new ArrayBuffer(32);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return buffer;
}

async function validSignature(
  body: ArrayBuffer,
  signatureHeader: string | undefined,
  secret: string | undefined,
): Promise<'valid' | 'invalid' | 'unconfigured'> {
  if (secret === undefined || secret.length < 16 || secret.length > 2_000) {
    return 'unconfigured';
  }
  const signature = signatureBytes(signatureHeader);
  if (signature === null) return 'invalid';
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return (await crypto.subtle.verify('HMAC', key, signature, body)) ? 'valid' : 'invalid';
}

function actionMatchesStatus(action: string, status: GitHubWorkflowRunStatus): boolean {
  if (action === 'completed') return status === 'completed';
  if (action === 'requested') return status === 'requested';
  return status === 'queued' || status === 'waiting' || status === 'in_progress';
}

function factFromPayload(
  payload: z.infer<typeof WorkflowRunWebhookSchema>,
): GitHubWorkflowRunFact | null {
  const status = payload.workflow_run.status;
  const conclusion = payload.workflow_run.conclusion;
  if (
    !actionMatchesStatus(payload.action, status) ||
    (status === 'completed' && conclusion === null) ||
    (status !== 'completed' && conclusion !== null)
  ) {
    return null;
  }
  return {
    repository: payload.repository.full_name,
    githubRunId: String(payload.workflow_run.id),
    event: 'workflow_dispatch',
    status,
    conclusion,
    headSha: payload.workflow_run.head_sha,
    headBranch: payload.workflow_run.head_branch,
    workflowPath: payload.workflow_run.path,
    displayTitle: payload.workflow_run.display_title,
    runAttempt: payload.workflow_run.run_attempt,
    externalUpdatedAt: new Date(payload.workflow_run.updated_at).toISOString(),
  };
}

function isTestAcceptanceWorkflow(fact: GitHubWorkflowRunFact): boolean {
  return fact.workflowPath === TEST_ACCEPTANCE_WORKFLOW_PATH ||
    fact.workflowPath.startsWith(`${TEST_ACCEPTANCE_WORKFLOW_PATH}@`);
}

function isTestRollbackWorkflow(fact: GitHubWorkflowRunFact): boolean {
  return fact.workflowPath === TEST_ROLLBACK_WORKFLOW_PATH ||
    fact.workflowPath.startsWith(`${TEST_ROLLBACK_WORKFLOW_PATH}@`);
}

async function pullRequestFactFromPayload(
  payload: z.infer<typeof PullRequestWebhookSchema>,
): Promise<GitHubPullRequestFact | null> {
  if (
    payload.repository.full_name !== payload.pull_request.head.repo.full_name ||
    payload.repository.full_name !== payload.pull_request.base.repo.full_name
  ) return null;
  let url: URL;
  try {
    url = new URL(payload.pull_request.html_url);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) return null;
  return {
    repository: payload.repository.full_name,
    number: payload.number,
    url: url.toString(),
    state: 'open',
    draft: true,
    title: payload.pull_request.title,
    bodyDigest: await canonicalSha256(payload.pull_request.body),
    headBranch: payload.pull_request.head.ref,
    headSha: payload.pull_request.head.sha,
    baseBranch: payload.pull_request.base.ref,
    externalUpdatedAt: new Date(payload.pull_request.updated_at).toISOString(),
  };
}

function pullRequestMergeFactFromPayload(
  payload: z.infer<typeof PullRequestMergedWebhookSchema>,
): GitHubPullRequestMergeFact | null {
  if (
    payload.repository.full_name !== payload.pull_request.head.repo.full_name ||
    payload.repository.full_name !== payload.pull_request.base.repo.full_name
  ) return null;
  let url: URL;
  try {
    url = new URL(payload.pull_request.html_url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  url.search = '';
  url.hash = '';
  return {
    schemaVersion: '1',
    repository: payload.repository.full_name,
    number: payload.number,
    url: url.toString(),
    state: 'closed',
    merged: true,
    headBranch: payload.pull_request.head.ref,
    headSha: payload.pull_request.head.sha,
    baseBranch: payload.pull_request.base.ref,
    mergeSha: payload.pull_request.merge_commit_sha,
    mergedByLogin: payload.pull_request.merged_by.login,
    mergedAt: new Date(payload.pull_request.merged_at).toISOString(),
    externalUpdatedAt: new Date(payload.pull_request.updated_at).toISOString(),
  };
}

async function reviewFactFromPayload(
  payload: z.infer<typeof PullRequestReviewWebhookSchema>,
): Promise<GitHubReviewFeedbackFact | null> {
  if (
    payload.repository.full_name !== payload.pull_request.head.repo.full_name ||
    payload.repository.full_name !== payload.pull_request.base.repo.full_name ||
    payload.review.commit_id !== payload.pull_request.head.sha
  ) return null;
  let url: URL;
  try {
    url = new URL(payload.review.html_url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  url.search = '';
  url.hash = '';
  const bodyDigest = await canonicalSha256(payload.review.body);
  return {
    repository: payload.repository.full_name,
    number: payload.pull_request.number,
    reviewId: String(payload.review.id),
    body: payload.review.body,
    bodyDigest,
    sourceHeadSha: payload.review.commit_id,
    branch: payload.pull_request.head.ref,
    baseBranch: payload.pull_request.base.ref,
    url: url.toString(),
    submittedAt: new Date(payload.review.submitted_at).toISOString(),
  };
}

function sanitizedEnvironmentUrl(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function deploymentStatusFact(
  payload: z.infer<typeof DeploymentStatusWebhookSchema>,
): GitHubTestDeploymentStatusFact | null {
  if (payload.deployment_status.environment !== payload.deployment.environment) return null;
  const externalUrl = sanitizedEnvironmentUrl(payload.deployment_status.environment_url);
  if (payload.deployment_status.environment_url !== null && externalUrl === null) return null;
  return {
    repository: payload.repository.full_name,
    githubDeploymentId: String(payload.deployment.id),
    deploymentId: payload.deployment.payload.delivery_deployment_id,
    sha: payload.deployment.sha,
    task: 'delivery-loop:test',
    environment: 'test',
    state: payload.deployment_status.state,
    environmentUrl: externalUrl,
    externalUpdatedAt: new Date(payload.deployment_status.updated_at).toISOString(),
  };
}

function productionDeploymentStatusFact(
  payload: z.infer<typeof ProductionDeploymentStatusWebhookSchema>,
): GitHubProductionDeploymentStatusFact | null {
  if (payload.deployment_status.environment !== payload.deployment.environment) return null;
  const externalUrl = sanitizedEnvironmentUrl(payload.deployment_status.environment_url);
  if (payload.deployment_status.environment_url !== null && externalUrl === null) return null;
  return {
    schemaVersion: '1',
    repository: payload.repository.full_name,
    githubDeploymentId: String(payload.deployment.id),
    deploymentId: payload.deployment.payload.delivery_production_deployment_id,
    sha: payload.deployment.sha,
    task: 'delivery-loop:production',
    environment: 'production',
    state: payload.deployment_status.state,
    environmentUrl: externalUrl,
    externalUpdatedAt: new Date(payload.deployment_status.updated_at).toISOString(),
  };
}

export function githubWebhookApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  app.post('/v1/webhooks/github', async (c) => {
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub webhook', false);
    }
    const deliveryId = c.req.header('x-github-delivery');
    if (deliveryId === undefined || !DELIVERY_ID_PATTERN.test(deliveryId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub webhook', false);
    }
    let body: ArrayBuffer;
    try {
      body = await c.req.arrayBuffer();
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub webhook', false);
    }
    if (body.byteLength === 0 || body.byteLength > MAX_WEBHOOK_BYTES) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub webhook', false);
    }
    const signature = await validSignature(
      body,
      c.req.header('x-hub-signature-256'),
      c.env.GITHUB_WEBHOOK_SECRET,
    );
    if (signature === 'unconfigured') {
      return errorResponse(c, 503, 'unavailable', 'GitHub webhook unavailable', true);
    }
    if (signature === 'invalid') {
      return errorResponse(c, 401, 'unauthenticated', 'GitHub webhook signature invalid', false);
    }
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder().decode(body)) as unknown;
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub webhook', false);
    }
    const event = c.req.header('x-github-event');
    const payloadDigest = await sha256Bytes(body);
    const receivedAt = new Date().toISOString();
    if (event === 'deployment_status') {
      const deployment = typeof input === 'object' && input !== null &&
        typeof (input as Record<string, unknown>).deployment === 'object' &&
        (input as Record<string, unknown>).deployment !== null
        ? (input as Record<string, unknown>).deployment as Record<string, unknown>
        : null;
      if (deployment?.task === 'delivery-loop:production') {
        const parsed = ProductionDeploymentStatusWebhookSchema.safeParse(input);
        const fact = parsed.success ? productionDeploymentStatusFact(parsed.data) : null;
        if (fact === null) {
          return errorResponse(
            c,
            400,
            'invalid_argument',
            'invalid GitHub production deployment status',
            false,
          );
        }
        try {
          const disposition = await new GitHubProductionDeploymentStatusStore(
            c.env.DB_CONTROL,
          ).applyWebhook({ deliveryId, payloadDigest, fact, receivedAt });
          return c.json({ accepted: true, disposition }, 202);
        } catch (error) {
          if (error instanceof GitHubProductionDeploymentStatusError) {
            if (error.code === 'observation_conflict') {
              return errorResponse(c, 409, 'conflict', 'GitHub delivery conflict', false);
            }
            if (error.code === 'attestation_required') {
              return errorResponse(
                c,
                503,
                'unavailable',
                'production deployment attestation pending',
                true,
              );
            }
            return errorResponse(
              c,
              409,
              'conflict',
              'production deployment state changed',
              false,
            );
          }
          throw error;
        }
      }
      const parsed = DeploymentStatusWebhookSchema.safeParse(input);
      const fact = parsed.success ? deploymentStatusFact(parsed.data) : null;
      if (fact === null) {
        return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub deployment status', false);
      }
      try {
        const disposition = await new GitHubTestDeploymentStatusStore(
          c.env.DB_CONTROL,
        ).apply({ deliveryId, payloadDigest, fact, receivedAt });
        return c.json({ accepted: true, disposition }, 202);
      } catch (error) {
        if (error instanceof GitHubTestDeploymentStatusError) {
          if (error.code === 'delivery_conflict') {
            return errorResponse(c, 409, 'conflict', 'GitHub delivery conflict', false);
          }
          if (error.code === 'attestation_required') {
            return errorResponse(c, 503, 'unavailable', 'deployment attestation pending', true);
          }
          return errorResponse(c, 409, 'conflict', 'deployment state changed', false);
        }
        throw error;
      }
    }
    if (event === 'workflow_run') {
      const parsed = WorkflowRunWebhookSchema.safeParse(input);
      const fact = parsed.success ? factFromPayload(parsed.data) : null;
      if (fact === null) {
        return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub workflow run', false);
      }
      try {
        if (isTestRollbackWorkflow(fact)) {
          const disposition = await new GitHubTestRollbackStatusStore(
            c.env.DB_CONTROL,
          ).applyWebhook({ deliveryId, payloadDigest, fact, receivedAt });
          return c.json({ accepted: true, disposition }, 202);
        }
        if (isTestAcceptanceWorkflow(fact)) {
          const disposition = await new GitHubTestAcceptanceStatusStore(
            c.env.DB_CONTROL,
          ).applyWebhook({ deliveryId, payloadDigest, fact, receivedAt });
          return c.json({ accepted: true, disposition }, 202);
        }
        const disposition = await new GitHubRunObservationStore(c.env.DB_CONTROL).apply({
          deliveryId,
          payloadDigest,
          fact,
          receivedAt,
        });
        return c.json({ accepted: true, disposition }, 202);
      } catch (error) {
        if (error instanceof GitHubTestRollbackStatusError) {
          if (error.code === 'observation_conflict') {
            return errorResponse(c, 409, 'conflict', 'GitHub delivery conflict', false);
          }
          if (error.code === 'runner_result_required') {
            return errorResponse(c, 503, 'unavailable', 'rollback result pending', true);
          }
          return errorResponse(c, 409, 'conflict', 'rollback state changed', false);
        }
        if (error instanceof GitHubTestAcceptanceStatusError) {
          if (error.code === 'observation_conflict') {
            return errorResponse(c, 409, 'conflict', 'GitHub delivery conflict', false);
          }
          if (error.code === 'runner_result_required') {
            return errorResponse(c, 503, 'unavailable', 'acceptance result pending', true);
          }
          return errorResponse(c, 409, 'conflict', 'acceptance state changed', false);
        }
        if (error instanceof GitHubRunObservationError && error.code === 'delivery_conflict') {
          return errorResponse(c, 409, 'conflict', 'GitHub delivery conflict', false);
        }
        throw error;
      }
    }
    if (event === 'pull_request') {
      const action = typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>).action
        : null;
      if (action === 'closed') {
        const pullRequest = typeof input === 'object' && input !== null &&
          typeof (input as Record<string, unknown>).pull_request === 'object' &&
          (input as Record<string, unknown>).pull_request !== null
          ? (input as Record<string, unknown>).pull_request as Record<string, unknown>
          : null;
        if (pullRequest?.merged !== true) {
          return c.json({ accepted: true, disposition: 'ignored' }, 202);
        }
        const parsed = PullRequestMergedWebhookSchema.safeParse(input);
        const fact = parsed.success ? pullRequestMergeFactFromPayload(parsed.data) : null;
        if (fact === null) {
          return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub merge fact', false);
        }
        try {
          const disposition = await new GitHubMergeStatusStore(
            c.env.DB_CONTROL,
          ).applyWebhook({ deliveryId, payloadDigest, fact, receivedAt });
          return c.json({ accepted: true, disposition }, 202);
        } catch (error) {
          if (error instanceof GitHubMergeStatusError) {
            if (error.code === 'observation_conflict' || error.code === 'merge_conflict') {
              return errorResponse(c, 409, 'conflict', 'GitHub merge conflict', false);
            }
            return errorResponse(c, 409, 'conflict', 'merge state changed', false);
          }
          throw error;
        }
      }
      if (action !== 'opened') return c.json({ accepted: true, disposition: 'ignored' }, 202);
      const parsed = PullRequestWebhookSchema.safeParse(input);
      const fact = parsed.success ? await pullRequestFactFromPayload(parsed.data) : null;
      if (fact === null) {
        return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub pull request', false);
      }
      try {
        const disposition = await new GitHubPullRequestObservationStore(
          c.env.DB_CONTROL,
        ).applyWebhook({ deliveryId, payloadDigest, fact, receivedAt });
        return c.json({ accepted: true, disposition }, 202);
      } catch (error) {
        if (
          error instanceof GitHubPullRequestObservationError &&
          error.code === 'delivery_conflict'
        ) {
          return errorResponse(c, 409, 'conflict', 'GitHub delivery conflict', false);
        }
        throw error;
      }
    }
    if (event === 'pull_request_review') {
      const object = typeof input === 'object' && input !== null
        ? input as Record<string, unknown>
        : null;
      const review = typeof object?.review === 'object' && object.review !== null
        ? object.review as Record<string, unknown>
        : null;
      if (object?.action !== 'submitted' || review?.state !== 'changes_requested') {
        return c.json({ accepted: true, disposition: 'ignored' }, 202);
      }
      const parsed = PullRequestReviewWebhookSchema.safeParse(input);
      const fact = parsed.success ? await reviewFactFromPayload(parsed.data) : null;
      if (fact === null) {
        return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub pull request review', false);
      }
      try {
        const result = await new GitHubReviewFeedbackStore(
          c.env.DB_CONTROL,
          c.env.TASK_OBJECTS,
          { secrets: configuredSecrets(c.env) },
        ).apply({ deliveryId, payloadDigest, fact, receivedAt });
        return c.json({ accepted: true, ...result }, 202);
      } catch (error) {
        if (error instanceof GitHubReviewFeedbackError) {
          if (error.code === 'secret_detected') {
            return errorResponse(
              c,
              403,
              'policy_denied',
              'GitHub review contains sensitive material',
              false,
            );
          }
          if (error.code === 'delivery_conflict' || error.code === 'review_conflict') {
            return errorResponse(c, 409, 'conflict', 'GitHub review delivery conflict', false);
          }
          return errorResponse(c, 503, 'unavailable', 'GitHub review storage unavailable', true);
        }
        throw error;
      }
    }
    return errorResponse(c, 400, 'invalid_argument', 'unsupported GitHub webhook event', false);
  });

  return app;
}
