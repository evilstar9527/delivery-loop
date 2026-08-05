import { z } from 'zod';
import { IdentityMapper, ANONYMOUS_PRINCIPAL } from '../auth/identity-mapper.js';
import { canonicalSha256 } from '../domain/digest.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const EVENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_SOURCE_AGE_MS = 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_APPROVAL_TTL_MS = 24 * 60 * 60_000;

export const ApprovalDecisionSourceSchema = z.object({
  schemaVersion: z.literal('1'),
  provider: z.enum(['github', 'feishu']),
  tenantKey: z.string().regex(TENANT_PATTERN),
  externalEventId: z.string().regex(EVENT_PATTERN),
  externalSubject: z.string().regex(SUBJECT_PATTERN),
  eventDigest: z.string().regex(DIGEST_PATTERN),
  occurredAt: z.iso.datetime({ offset: true }),
}).strict();

export const IdentityBoundApprovalInputSchema = z.object({
  runId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
  planVersion: z.number().int().positive(),
  effect: z.enum(['merge', 'production_deploy']),
  decision: z.enum(['approve', 'reject']),
  expiresAt: z.iso.datetime({ offset: true }),
  source: ApprovalDecisionSourceSchema,
}).strict();

const TrustedGitHubRepoWriteApprovalInputSchema = z.object({
  runId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
  planVersion: z.number().int().positive(),
  effect: z.literal('repo_write'),
  decision: z.literal('approve'),
  expiresAt: z.iso.datetime({ offset: true }),
  source: ApprovalDecisionSourceSchema.extend({
    provider: z.literal('github'),
  }).strict(),
}).strict();

export const IdentityBoundApprovalRequestBodySchema =
  IdentityBoundApprovalInputSchema.omit({ runId: true });

export type IdentityBoundApprovalInput = z.infer<typeof IdentityBoundApprovalInputSchema>;
type TrustedGitHubRepoWriteApprovalInput = z.infer<
  typeof TrustedGitHubRepoWriteApprovalInputSchema
>;
type SupportedApprovalInput =
  | IdentityBoundApprovalInput
  | TrustedGitHubRepoWriteApprovalInput;
export type ApprovalIdentityRejectionReason =
  | 'identity_unresolved'
  | 'actor_not_human'
  | 'actor_not_authorized'
  | 'self_approval_denied'
  | 'task_actor_self_approval';

export type IdentityBoundApprovalResult =
  | {
      status: 'accepted';
      sourceId: string;
      approvalId: string;
      lineageId: string;
      principal: string;
      created: boolean;
    }
  | {
      status: 'rejected';
      sourceId: string;
      rejectionId: string;
      reason: ApprovalIdentityRejectionReason;
      created: boolean;
    };

export type IdentityBoundApprovalErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'state_conflict'
  | 'source_conflict';

export class IdentityBoundApprovalError extends Error {
  constructor(readonly code: IdentityBoundApprovalErrorCode) {
    super(`identity-bound approval failed: ${code}`);
    this.name = 'IdentityBoundApprovalError';
  }
}

export interface IdentityBoundApprovalStoreOptions {
  now?: () => Date;
  /** Trusted internal link; never accepted from the approval HTTP body. */
  cardActionReceiptId?: string;
}

interface SourceRow {
  source_id: string;
  provider: string;
  tenant_key: string;
  external_event_id: string;
  event_digest: string;
  request_digest: string;
  channel: string;
  channel_user_id: string;
  occurred_at: string;
}

interface CandidateRow {
  run_id: string;
  task_id: string;
  run_state: string;
  run_version: number;
  task_revision: string;
  task_actor_type: string;
  task_actor_id: string;
  base_sha: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_status: string;
  repository: string;
  pull_request_author_login: string | null;
  has_effect: number;
  merge_id: string | null;
  merge_sha: string | null;
  merged_at: string | null;
  environment: string | null;
}

interface AcceptedRow {
  source_id: string;
  approval_id: string;
  approver_principal: string;
  run_id: string;
  plan_version: number;
  effect: string;
}

interface RejectedRow {
  source_id: string;
  rejection_id: string;
  reason: ApprovalIdentityRejectionReason;
  run_id: string;
  plan_version: number;
  effect: string;
}

interface LineageRow {
  lineage_id: string;
  approval_id: string;
  source_id: string | null;
  card_action_receipt_id: string | null;
}

/** Converts only pre-authenticated adapter identity facts into high-risk approvals. */
export class IdentityBoundApprovalStore {
  private readonly now: () => Date;
  private readonly cardActionReceiptId: string | null;

  constructor(
    private readonly db: D1Database,
    options: IdentityBoundApprovalStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    if (options.cardActionReceiptId !== undefined && !ID_PATTERN.test(options.cardActionReceiptId)) {
      throw new IdentityBoundApprovalError('invalid_request');
    }
    this.cardActionReceiptId = options.cardActionReceiptId ?? null;
  }

  async decide(rawInput: unknown): Promise<IdentityBoundApprovalResult> {
    const parsed = IdentityBoundApprovalInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new IdentityBoundApprovalError('invalid_request');
    return await this.decideParsed(parsed.data);
  }

  /** Only a server-side GitHub fact observer may call this low-risk path. */
  async decideTrustedGitHubRepoWrite(rawInput: unknown): Promise<IdentityBoundApprovalResult> {
    const parsed = TrustedGitHubRepoWriteApprovalInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new IdentityBoundApprovalError('invalid_request');
    return await this.decideParsed(parsed.data);
  }

  private async decideParsed(input: SupportedApprovalInput): Promise<IdentityBoundApprovalResult> {
    const now = this.now();
    this.assertTimes(input, now);
    const channel = `${input.source.provider}:${input.source.tenantKey}`;
    const sourceIdentity = await canonicalSha256({
      provider: input.source.provider,
      tenantKey: input.source.tenantKey,
      externalEventId: input.source.externalEventId,
    });
    const requestDigest = await canonicalSha256(input);
    const sourceId = `approval_source_${this.suffix(sourceIdentity, 48)}`;
    const existingSource = await this.source(sourceId);
    if (existingSource !== null) {
      this.assertSource(existingSource, input, channel, requestDigest);
    }
    if (existingSource === null) {
      await this.db.prepare(
        `INSERT INTO approval_source_events (
           source_id, provider, tenant_key, external_event_id, event_digest,
           request_digest, channel, channel_user_id, occurred_at, received_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        sourceId,
        input.source.provider,
        input.source.tenantKey,
        input.source.externalEventId,
        input.source.eventDigest,
        requestDigest,
        channel,
        input.source.externalSubject,
        input.source.occurredAt,
        now.toISOString(),
        now.toISOString(),
      ).run();
      const persisted = await this.source(sourceId);
      if (persisted === null) throw new IdentityBoundApprovalError('source_conflict');
      this.assertSource(persisted, input, channel, requestDigest);
    }
    const existing = await this.outcome(sourceId, input);
    if (existing !== null) return existing;

    const candidate = await this.candidate(input);
    if (candidate === null) {
      const run = await this.db.prepare('SELECT run_id FROM runs WHERE run_id = ?')
        .bind(input.runId).first<{ run_id: string }>();
      throw new IdentityBoundApprovalError(run === null ? 'not_found' : 'state_conflict');
    }
    const mapper = new IdentityMapper(this.db);
    const approver = await mapper.resolve(channel, input.source.externalSubject);
    const authorChannel = input.effect === 'repo_write'
      ? `task:${candidate.repository}`
      : `github:${candidate.repository}`;
    const author = candidate.pull_request_author_login === null
      ? { principal: ANONYMOUS_PRINCIPAL, roles: [] }
      : await mapper.resolve(authorChannel, candidate.pull_request_author_login);
    const reason = this.rejectionReason(input, candidate, approver, author);
    if (reason !== null) {
      if (input.effect === 'repo_write') {
        throw new IdentityBoundApprovalError('state_conflict');
      }
      const rejectionId = `approval_reject_${this.suffix(await canonicalSha256({
        sourceId,
        runId: candidate.run_id,
        planId: candidate.plan_id,
        effect: input.effect,
        reason,
      }), 47)}`;
      const result = await this.db.prepare(
        `INSERT INTO approval_identity_rejections (
           rejection_id, source_id, run_id, plan_id, plan_version, effect,
           approver_principal, approver_channel, approver_channel_user_id,
           author_principal, author_channel, author_login, roles_digest,
           separation_verified, reason, decision, rejected_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        rejectionId,
        sourceId,
        candidate.run_id,
        candidate.plan_id,
        candidate.plan_version,
        input.effect,
        approver.principal === ANONYMOUS_PRINCIPAL ? null : approver.principal,
        channel,
        input.source.externalSubject,
        author.principal === ANONYMOUS_PRINCIPAL ? null : author.principal,
        authorChannel,
        candidate.pull_request_author_login,
        await canonicalSha256(approver.roles),
        0,
        reason,
        input.decision,
        now.toISOString(),
        now.toISOString(),
      ).run();
      const rejected = await this.rejected(sourceId);
      if (rejected === null || rejected.reason !== reason) {
        throw new IdentityBoundApprovalError('state_conflict');
      }
      return {
        status: 'rejected',
        sourceId,
        rejectionId: rejected.rejection_id,
        reason,
        created: result.meta.changes === 1,
      };
    }

    const rolesDigest = await canonicalSha256(approver.roles);
    const approvalIdentity = await canonicalSha256({
      sourceId,
      runId: candidate.run_id,
      runVersion: candidate.run_version,
      planId: candidate.plan_id,
      planVersion: candidate.plan_version,
      planDigest: candidate.plan_digest,
      baseSha: candidate.base_sha,
      mergeId: candidate.merge_id,
      mergeSha: candidate.merge_sha,
      environment: candidate.environment,
      effect: input.effect,
      decision: input.decision,
      principal: approver.principal,
    });
    const approvalId = `approval_identity_${this.suffix(approvalIdentity, 46)}`;
    const nonceDigest = await canonicalSha256({ sourceId, approvalId });
    const separationVerified = input.effect === 'repo_write'
      ? 0
      : approver.principal === author.principal ? 0 : 1;
    const productionApprovalConstraint = input.effect === 'production_deploy'
      ? `AND tasks.target_environment = 'production'
           AND tasks.allow_production_deploy = 1
           AND merges.merge_id = ? AND merges.merge_sha = ?
           AND merges.plan_id = plans.plan_id
           AND merges.plan_version = plans.plan_version
           AND merges.plan_digest = plans.digest
           AND merges.deployment_disposition = 'production'
           AND merges.run_version + 2 = runs.version`
      : '';
    const approvalInsert = this.db.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       )
       SELECT ?, runs.run_id, runs.task_revision, plans.plan_id,
              plans.plan_version, plans.digest, runs.base_sha, ?, ?, ?, ?, ?, ?
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       LEFT JOIN github_merges AS merges ON merges.run_id = runs.run_id
       WHERE runs.run_id = ? AND runs.version = ? AND runs.base_sha = ?
         AND plans.plan_version = ? AND plans.digest = ? AND plans.status = 'active'
         AND EXISTS (
           SELECT 1 FROM plan_item_effects
           WHERE plan_item_effects.plan_id = plans.plan_id
             AND plan_item_effects.effect = ?
         )
         ${productionApprovalConstraint}
       ON CONFLICT DO NOTHING`,
    ).bind(
      approvalId,
      input.effect,
      approver.principal,
      input.decision,
      nonceDigest,
      input.expiresAt,
      now.toISOString(),
      candidate.run_id,
      candidate.run_version,
      candidate.base_sha,
      candidate.plan_version,
      candidate.plan_digest,
      input.effect,
      ...(input.effect === 'production_deploy'
        ? [candidate.merge_id, candidate.merge_sha]
        : []),
    );
    const statements = [
      approvalInsert,
      this.db.prepare(
        `INSERT INTO identity_bound_approvals (
           approval_id, source_id, approver_principal, approver_channel,
           approver_channel_user_id, pull_request_author_principal,
           pull_request_author_channel, pull_request_author_login,
           roles_digest, separation_verified, created_at
         )
         SELECT approvals.approval_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM approvals
         WHERE approvals.approval_id = ? AND approvals.run_id = ?
           AND approvals.plan_id = ? AND approvals.plan_version = ?
           AND approvals.plan_digest = ? AND approvals.base_sha = ?
           AND approvals.effect = ? AND approvals.actor_id = ?
           AND approvals.decision = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        sourceId,
        approver.principal,
        channel,
        input.source.externalSubject,
        author.principal,
        authorChannel,
        candidate.pull_request_author_login,
        rolesDigest,
        separationVerified,
        now.toISOString(),
        approvalId,
        candidate.run_id,
        candidate.plan_id,
        candidate.plan_version,
        candidate.plan_digest,
        candidate.base_sha,
        input.effect,
        approver.principal,
        input.decision,
      ),
    ];
    statements.push(this.lineageInsert(
      input,
      sourceId,
      approvalId,
      approver.principal,
      rolesDigest,
      candidate,
      now.toISOString(),
    ));
    if (input.effect === 'production_deploy') {
      statements.push(this.db.prepare(
        `INSERT INTO production_release_approval_bindings (
           approval_id, run_id, task_revision, plan_id, plan_version,
           plan_digest, merge_id, merge_sha, environment, created_at
         )
         SELECT approvals.approval_id, approvals.run_id, approvals.task_revision,
                approvals.plan_id, approvals.plan_version, approvals.plan_digest,
                merges.merge_id, merges.merge_sha, 'production', ?
         FROM approvals
         JOIN identity_bound_approvals AS identities
           ON identities.approval_id = approvals.approval_id
         JOIN github_merges AS merges ON merges.run_id = approvals.run_id
         JOIN runs ON runs.run_id = approvals.run_id
         JOIN tasks ON tasks.task_id = runs.task_id
         WHERE approvals.approval_id = ? AND approvals.effect = 'production_deploy'
           AND approvals.run_id = ? AND approvals.task_revision = runs.task_revision
           AND approvals.plan_id = ? AND approvals.plan_version = ?
           AND approvals.plan_digest = ? AND approvals.base_sha = ?
           AND merges.merge_id = ? AND merges.merge_sha = ?
           AND merges.plan_id = approvals.plan_id
           AND merges.plan_version = approvals.plan_version
           AND merges.plan_digest = approvals.plan_digest
           AND merges.deployment_disposition = 'production'
           AND runs.state = 'deploying' AND runs.version = ?
           AND merges.run_version + 2 = runs.version
           AND tasks.target_environment = 'production'
           AND tasks.allow_production_deploy = 1
         ON CONFLICT DO NOTHING`,
      ).bind(
        now.toISOString(),
        approvalId,
        candidate.run_id,
        candidate.plan_id,
        candidate.plan_version,
        candidate.plan_digest,
        candidate.base_sha,
        candidate.merge_id,
        candidate.merge_sha,
        candidate.run_version,
      ));
    }
    const results = await this.db.batch(statements);
    const accepted = await this.accepted(sourceId);
    if (accepted === null) throw new IdentityBoundApprovalError('state_conflict');
    const lineage = await this.lineage(accepted.approval_id);
    if (lineage === null || lineage.source_id !== sourceId ||
      lineage.card_action_receipt_id !== this.cardActionReceiptId) {
      throw new IdentityBoundApprovalError('state_conflict');
    }
    return {
      status: 'accepted',
      sourceId,
      approvalId: accepted.approval_id,
      lineageId: lineage.lineage_id,
      principal: accepted.approver_principal,
      created: results[1]?.meta.changes === 1,
    };
  }

  private assertTimes(input: SupportedApprovalInput, now: Date): void {
    const occurredAt = Date.parse(input.source.occurredAt);
    const expiresAt = Date.parse(input.expiresAt);
    const timestamp = now.getTime();
    if (
      !Number.isFinite(occurredAt) ||
      occurredAt < timestamp - MAX_SOURCE_AGE_MS ||
      occurredAt > timestamp + MAX_FUTURE_SKEW_MS ||
      !Number.isFinite(expiresAt) || expiresAt <= timestamp ||
      expiresAt > timestamp + MAX_APPROVAL_TTL_MS
    ) throw new IdentityBoundApprovalError('invalid_request');
  }

  private rejectionReason(
    input: SupportedApprovalInput,
    candidate: CandidateRow,
    approver: { principal: string; roles: string[] },
    author: { principal: string; roles: string[] },
  ): ApprovalIdentityRejectionReason | null {
    if (
      approver.principal === ANONYMOUS_PRINCIPAL ||
      (input.effect !== 'repo_write' && author.principal === ANONYMOUS_PRINCIPAL) ||
      (input.source.provider === 'github' && input.source.tenantKey !== candidate.repository)
    ) return 'identity_unresolved';
    if (!approver.roles.includes('human') || approver.principal.startsWith('agent:') ||
      approver.principal.startsWith('service:')) return 'actor_not_human';
    if (!approver.roles.includes(`approve:${input.effect}`)) return 'actor_not_authorized';
    if (
      input.effect !== 'repo_write' && input.decision === 'approve' &&
      approver.principal === author.principal
    ) {
      return 'self_approval_denied';
    }
    if (
      input.effect !== 'repo_write' &&
      input.decision === 'approve' && candidate.task_actor_type === 'user' &&
      candidate.task_actor_id === approver.principal
    ) return 'task_actor_self_approval';
    return null;
  }

  private async candidate(input: SupportedApprovalInput): Promise<CandidateRow | null> {
    if (input.effect === 'repo_write') {
      return await this.db.prepare(
        `SELECT runs.run_id, tasks.task_id, runs.state AS run_state,
                runs.version AS run_version, runs.task_revision,
                tasks.actor_type AS task_actor_type, tasks.actor_id AS task_actor_id,
                runs.base_sha, plans.plan_id, plans.plan_version,
                plans.digest AS plan_digest, plans.status AS plan_status,
                tasks.target_repository AS repository,
                tasks.actor_id AS pull_request_author_login,
                NULL AS merge_id, NULL AS merge_sha, NULL AS merged_at,
                NULL AS environment,
                EXISTS (
                  SELECT 1 FROM plan_item_effects
                  WHERE plan_item_effects.plan_id = plans.plan_id
                    AND plan_item_effects.effect = 'repo_write'
                ) AS has_effect
         FROM runs
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
         WHERE runs.run_id = ? AND runs.version = ? AND runs.base_sha IS NOT NULL
           AND runs.state = 'awaiting_approval'
           AND tasks.allow_repository_write = 1
           AND plans.plan_version = ? AND plans.status = 'active'
           AND plans.base_sha = runs.base_sha
           AND EXISTS (
             SELECT 1 FROM plan_item_effects
             WHERE plan_item_effects.plan_id = plans.plan_id
               AND plan_item_effects.effect = 'repo_write'
           )
         LIMIT 1`,
      ).bind(input.runId, input.expectedRunVersion, input.planVersion).first<CandidateRow>();
    }
    const allowedStates = input.effect === 'merge'
      ? "'pull_request_open','awaiting_review','ready_to_merge'"
      : "'merging','deploying'";
    const productionConstraint = input.effect === 'production_deploy'
      ? `AND tasks.target_environment = 'production'
         AND tasks.allow_production_deploy = 1
         AND merges.merge_id IS NOT NULL
         AND merges.publication_id = publications.publication_id
         AND merges.plan_id = plans.plan_id
         AND merges.plan_version = plans.plan_version
         AND merges.plan_digest = plans.digest
         AND merges.deployment_disposition = 'production'
         AND merges.run_version + 2 = runs.version
         AND merges.merged_at <= ?`
      : '';
    return await this.db.prepare(
      `SELECT runs.run_id, tasks.task_id, runs.state AS run_state, runs.version AS run_version,
              runs.task_revision, tasks.actor_type AS task_actor_type,
              tasks.actor_id AS task_actor_id, runs.base_sha,
              plans.plan_id, plans.plan_version, plans.digest AS plan_digest,
              plans.status AS plan_status, publications.repository,
              observations.pull_request_author_login,
              merges.merge_id, merges.merge_sha, merges.merged_at,
              CASE WHEN merges.merge_id IS NULL THEN NULL ELSE 'production' END AS environment,
              EXISTS (
                SELECT 1 FROM plan_item_effects
                WHERE plan_item_effects.plan_id = plans.plan_id
                  AND plan_item_effects.effect = ?
              ) AS has_effect
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN pull_request_publications AS publications ON publications.run_id = runs.run_id
       LEFT JOIN github_merges AS merges ON merges.run_id = runs.run_id
       LEFT JOIN github_merge_gate_observations AS observations
         ON observations.publication_id = publications.publication_id
        AND NOT EXISTS (
          SELECT 1 FROM github_merge_gate_observations AS newer
          WHERE newer.publication_id = observations.publication_id
            AND (newer.external_updated_at > observations.external_updated_at OR
                 (newer.external_updated_at = observations.external_updated_at
                  AND newer.observation_id > observations.observation_id))
        )
       WHERE runs.run_id = ? AND runs.version = ? AND runs.base_sha IS NOT NULL
         AND runs.state IN (${allowedStates})
         AND plans.plan_version = ? AND plans.status = 'active'
         AND plans.base_sha = runs.base_sha
         AND publications.status = 'verified'
         AND observations.pull_request_author_login IS NOT NULL
         ${productionConstraint}
       ORDER BY publications.updated_at DESC, publications.publication_id DESC LIMIT 1`,
    ).bind(
      input.effect,
      input.runId,
      input.expectedRunVersion,
      input.planVersion,
      ...(input.effect === 'production_deploy' ? [input.source.occurredAt] : []),
    ).first<CandidateRow>();
  }

  private async source(sourceId: string): Promise<SourceRow | null> {
    return await this.db.prepare(
      `SELECT source_id, provider, tenant_key, external_event_id, event_digest,
              request_digest, channel, channel_user_id, occurred_at
       FROM approval_source_events WHERE source_id = ?`,
    ).bind(sourceId).first<SourceRow>();
  }

  private assertSource(
    row: SourceRow,
    input: SupportedApprovalInput,
    channel: string,
    requestDigest: string,
  ): void {
    if (
      row.provider !== input.source.provider || row.tenant_key !== input.source.tenantKey ||
      row.external_event_id !== input.source.externalEventId ||
      row.event_digest !== input.source.eventDigest || row.request_digest !== requestDigest ||
      row.channel !== channel ||
      row.channel_user_id !== input.source.externalSubject ||
      row.occurred_at !== input.source.occurredAt
    ) throw new IdentityBoundApprovalError('source_conflict');
  }

  private async outcome(
    sourceId: string,
    input: SupportedApprovalInput,
  ): Promise<IdentityBoundApprovalResult | null> {
    const accepted = await this.accepted(sourceId);
    if (accepted !== null) {
      if (
        accepted.run_id !== input.runId || accepted.plan_version !== input.planVersion ||
        accepted.effect !== input.effect
      ) throw new IdentityBoundApprovalError('source_conflict');
      const lineage = await this.lineage(accepted.approval_id);
      if (lineage === null || lineage.source_id !== sourceId ||
        lineage.card_action_receipt_id !== this.cardActionReceiptId) {
        throw new IdentityBoundApprovalError('state_conflict');
      }
      return {
        status: 'accepted',
        sourceId,
        approvalId: accepted.approval_id,
        lineageId: lineage.lineage_id,
        principal: accepted.approver_principal,
        created: false,
      };
    }
    const rejected = await this.rejected(sourceId);
    if (rejected !== null) {
      if (
        rejected.run_id !== input.runId || rejected.plan_version !== input.planVersion ||
        rejected.effect !== input.effect
      ) throw new IdentityBoundApprovalError('source_conflict');
      return {
        status: 'rejected',
        sourceId,
        rejectionId: rejected.rejection_id,
        reason: rejected.reason,
        created: false,
      };
    }
    return null;
  }

  private async accepted(sourceId: string): Promise<AcceptedRow | null> {
    return await this.db.prepare(
      `SELECT bindings.source_id, bindings.approval_id,
              bindings.approver_principal, approvals.run_id,
              approvals.plan_version, approvals.effect
       FROM identity_bound_approvals AS bindings
       JOIN approvals ON approvals.approval_id = bindings.approval_id
       WHERE bindings.source_id = ?`,
    ).bind(sourceId).first<AcceptedRow>();
  }

  private async rejected(sourceId: string): Promise<RejectedRow | null> {
    return await this.db.prepare(
      `SELECT source_id, rejection_id, reason, run_id, plan_version, effect
       FROM approval_identity_rejections WHERE source_id = ?`,
    ).bind(sourceId).first<RejectedRow>();
  }

  private lineageInsert(
    input: SupportedApprovalInput,
    sourceId: string,
    approvalId: string,
    principal: string,
    rolesDigest: string,
    candidate: CandidateRow,
    nowIso: string,
  ): D1PreparedStatement {
    const lineageId = `approval_lineage_${approvalId}`;
    return this.db.prepare(
      `INSERT INTO approval_lineages (
         lineage_id, approval_id, source_id, card_action_receipt_id, provider,
         tenant_key, external_event_id, external_event_digest,
         approver_principal, roles_digest, run_id, task_id, task_revision,
         plan_id, plan_version, plan_digest, base_sha, effect, decision,
         separation_verified, source_occurred_at, decision_recorded_at,
         expires_at, created_at
       )
       SELECT ?, approvals.approval_id, sources.source_id,
              receipts.action_receipt_id, sources.provider, sources.tenant_key,
              sources.external_event_id, sources.event_digest,
              bindings.approver_principal, bindings.roles_digest,
              approvals.run_id, runs.task_id, approvals.task_revision,
              approvals.plan_id, approvals.plan_version, approvals.plan_digest,
              approvals.base_sha, approvals.effect, approvals.decision,
              bindings.separation_verified, sources.occurred_at,
              approvals.created_at, approvals.expires_at, ?
       FROM approvals
       JOIN identity_bound_approvals AS bindings
         ON bindings.approval_id = approvals.approval_id
       JOIN approval_source_events AS sources ON sources.source_id = bindings.source_id
       JOIN runs ON runs.run_id = approvals.run_id
       LEFT JOIN feishu_card_action_receipts AS receipts
         ON receipts.action_receipt_id = ?
       LEFT JOIN feishu_webhook_deliveries AS deliveries
         ON deliveries.delivery_id = receipts.delivery_id
       WHERE approvals.approval_id = ? AND bindings.source_id = ?
         AND approvals.run_id = ? AND runs.task_id = ?
         AND approvals.task_revision = ? AND approvals.plan_id = ?
         AND approvals.plan_version = ? AND approvals.plan_digest = ?
         AND approvals.base_sha = ? AND approvals.effect = ?
         AND approvals.decision = ? AND approvals.actor_id = ?
         AND sources.provider = ? AND sources.tenant_key = ?
         AND sources.external_event_id = ? AND sources.event_digest = ?
         AND sources.occurred_at = ? AND bindings.roles_digest = ?
         AND (? IS NULL OR (
           sources.provider = 'feishu'
           AND receipts.tenant_key = sources.tenant_key
           AND receipts.event_id = sources.external_event_id
           AND deliveries.event_digest = sources.event_digest
           AND receipts.principal = bindings.approver_principal
           AND receipts.roles_digest = bindings.roles_digest
           AND receipts.run_id = approvals.run_id
           AND receipts.task_id = runs.task_id
           AND receipts.plan_id = approvals.plan_id
           AND receipts.plan_version = approvals.plan_version
           AND receipts.plan_digest = approvals.plan_digest
           AND receipts.base_sha = approvals.base_sha
           AND receipts.effect = approvals.effect
           AND receipts.command = approvals.decision
         ))
       ON CONFLICT DO NOTHING`,
    ).bind(
      lineageId,
      nowIso,
      this.cardActionReceiptId,
      approvalId,
      sourceId,
      candidate.run_id,
      candidate.task_id,
      candidate.task_revision,
      candidate.plan_id,
      candidate.plan_version,
      candidate.plan_digest,
      candidate.base_sha,
      input.effect,
      input.decision,
      principal,
      input.source.provider,
      input.source.tenantKey,
      input.source.externalEventId,
      input.source.eventDigest,
      input.source.occurredAt,
      rolesDigest,
      this.cardActionReceiptId,
    );
  }

  private async lineage(approvalId: string): Promise<LineageRow | null> {
    return await this.db.prepare(
      `SELECT lineage_id, approval_id, source_id, card_action_receipt_id
       FROM approval_lineages WHERE approval_id = ?`,
    ).bind(approvalId).first<LineageRow>();
  }

  private suffix(digest: string, length: number): string {
    return digest.slice('sha256:'.length, 'sha256:'.length + length);
  }
}
