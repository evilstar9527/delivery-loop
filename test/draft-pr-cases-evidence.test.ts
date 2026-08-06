import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  DraftPrCasesEvidenceManifestV1Schema,
  type DraftPrCasesEvidenceManifestV1,
} from '../src/domain/draft-pr-cases-evidence.js';
import {
  verifyDraftPrCasesEvidence,
} from '../src/pilot/draft-pr-cases-evidence-verifier.js';

const CONTROL_ORIGIN = 'https://control.example';
const GITHUB_ORIGIN = 'https://api.github.example';
const CONTROL_TOKEN = 'draft-pr-control-read-purpose';
const GITHUB_TOKEN = 'draft-pr-github-read-purpose';
const CANARY = 'github_pat_DRAFT_PR_CASES_CANARY_1234567890';
const REPOSITORY = 'example/delivery-pilot';

function digest(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(2, '0').repeat(32)}`;
}

interface CaseResponses {
  task: Record<string, unknown>;
  plan: Record<string, unknown>;
  audit: Record<string, unknown>;
  action: Record<string, unknown>;
  jobs: Record<string, unknown>;
  compare: Record<string, unknown>;
  pullRequest: Record<string, unknown>;
}

interface Fixture {
  manifest: DraftPrCasesEvidenceManifestV1;
  responses: Map<string, CaseResponses>;
}

async function buildCase(
  scenario: 'requirement' | 'bug',
  index: number,
): Promise<{ item: Record<string, unknown>; responses: CaseResponses }> {
  const tag = scenario;
  const taskId = `task_${tag}`;
  const runId = `run_${tag}`;
  const planId = `plan_${tag}`;
  const attemptId = `attempt_${tag}`;
  const actionRunId = String(9000 + index);
  const baseSha = String(index).repeat(40);
  const parentSha = baseSha;
  const headSha = String(index + 4).repeat(40);
  const branch = `delivery/${tag}/attempt-${index}`;
  const prNumber = 40 + index;
  const prBody = `Durable ${scenario} delivery with verified evidence.`;
  const files = [{
    filename: `src/${scenario}.ts`, status: 'modified', additions: 8,
    deletions: 2, changes: 10,
  }];
  const filesProjection = files.map((file) => ({
    ...file, previousFilename: null,
  }));
  const requiredItems = [
    {
      itemId: `change_${tag}`, kind: 'change', verificationId: `verify_change_${tag}`,
      headSha, evidenceSetDigest: digest(10 + index),
      evidenceIds: [
        `commit_evidence_${tag}`, `test_targeted_${tag}`, `test_required_${tag}`,
      ],
    },
  ];
  const commands = [
    { position: 0, phase: 'targeted', commandRef: 'test:targeted',
      evidenceId: `test_targeted_${tag}` },
    { position: 1, phase: 'required', commandRef: 'verify:required',
      evidenceId: `test_required_${tag}` },
  ];
  const publication = {
    publicationId: `publication_${tag}`, approvalId: `approval_${tag}`,
    repository: REPOSITORY, baseBranch: 'main', headBranch: branch, headSha,
    bodyDigest: await canonicalSha256(prBody), status: 'verified' as const,
    number: prNumber,
    url: `https://github.com/${REPOSITORY}/pull/${prNumber}`,
    evidenceId: `pr_evidence_${tag}`,
    webhook: {
      deliveryId: `delivery_${tag}`, payloadDigest: digest(50 + index),
      processingState: 'applied' as const,
      externalUpdatedAt: `2026-07-27T1${index}:00:00.000Z`,
      receivedAt: `2026-07-27T1${index}:00:01.000Z`,
    },
    apiObservation: {
      observationId: `api_pr_${tag}`, factDigest: digest(60 + index),
      processingState: 'applied' as const,
      externalUpdatedAt: `2026-07-27T1${index}:00:00.000Z`,
      observedAt: `2026-07-27T1${index}:01:00.000Z`,
    },
  };
  const item = {
    scenario,
    inputClass: scenario === 'requirement' ? 'prd' : 'user_feedback',
    task: {
      taskId, sourceSystem: scenario === 'requirement' ? 'meego' : 'feishu',
      sourceRevision: `revision-${tag}-1`, taskDigest: digest(index),
      acceptanceCriteriaCount: 2,
    },
    runId,
    plan: { planId, version: 1, digest: digest(70 + index), baseSha, requiredItems },
    execution: {
      attemptId, mode: 'implement', actionRunId, actionCheckoutSha: parentSha,
      updateId: `update_${tag}`, commitEvidenceId: `commit_evidence_${tag}`,
      parentSha, headSha, branch,
    },
    testSuite: {
      suiteId: `suite_${tag}`, planItemId: `change_${tag}`,
      deliveryPolicyDigest: digest(80 + index), commands,
    },
    diff: {
      changedFileCount: files.length,
      changedFilesDigest: await canonicalSha256(filesProjection),
    },
    pullRequest: {
      schemaVersion: '1', evidenceId: `pr_case_${tag}`,
      recordedAt: '2026-07-27T14:00:00.000Z', runId, repository: REPOSITORY,
      publication,
    },
  };

  const itemRows = requiredItems.map((required, position) => ({
    id: required.itemId, kind: required.kind, required: true, status: 'passed',
    progressVersion: required.kind === 'change' ? 3 : 2,
    acceptanceCriteriaIndexes: position === 0 ? [0, 1] : [],
    commandRefs: required.kind === 'change'
      ? commands.map((command) => command.commandRef)
      : [],
    evidenceKinds: required.kind === 'change' ? ['test'] : [],
    effects: required.kind === 'change' ? ['repo_write'] : [],
    verificationDecision: {
      id: required.verificationId, headSha: required.headSha,
      evidenceSetDigest: required.evidenceSetDigest,
      evidenceIds: required.evidenceIds,
      doneWhenEvidence: [{ position: 0, evidenceIds: required.evidenceIds }],
      verifiedAt: '2026-07-27T13:00:00.000Z',
    },
  }));
  const evidenceRows = commands.map((command) => ({
    id: command.evidenceId, attemptId, planId, planVersion: 1,
    planItemId: `change_${tag}`, kind: 'test', status: 'passed',
    verificationStatus: 'verified', commandRef: command.commandRef,
    exitCode: 0, durationMs: 100, sha: headSha,
    observedAt: '2026-07-27T13:00:00.000Z',
  }));
  const auditEvidenceRows = evidenceRows.map(({ id, planItemId, ...row }) => ({
    ...row,
    evidenceId: id,
    itemId: planItemId,
  }));
  const commandRows = commands.map((command) => ({
    suiteId: `suite_${tag}`, attemptId, planId, planVersion: 1,
    itemId: `change_${tag}`, headSha,
    deliveryPolicyDigest: digest(80 + index), suiteStatus: 'completed',
    ...command, status: 'passed', observedAt: '2026-07-27T13:00:00.000Z',
  }));
  const verificationRows = requiredItems.map((required) => ({
    verificationId: required.verificationId, planId, planVersion: 1,
    itemId: required.itemId, attemptId, headSha: required.headSha,
    evidenceSetDigest: required.evidenceSetDigest, status: 'passed',
    verifiedAt: '2026-07-27T13:00:00.000Z',
  }));
  const prChange = {
    kind: 'pull_request', publicationId: publication.publicationId,
    approvalId: publication.approvalId, repository: REPOSITORY,
    baseBranch: 'main', headBranch: branch, headSha,
    bodyDigest: publication.bodyDigest, status: 'verified', number: prNumber,
    url: publication.url, evidenceId: publication.evidenceId,
  };
  const prObservations = [
    {
      sourceKind: 'webhook', sourceId: publication.webhook.deliveryId,
      publicationId: publication.publicationId, repository: REPOSITORY,
      githubPrNumber: prNumber, factDigest: publication.webhook.payloadDigest,
      processingState: 'applied', ignoreReason: null,
      externalUpdatedAt: publication.webhook.externalUpdatedAt,
      observedAt: publication.webhook.receivedAt,
      processedAt: publication.webhook.receivedAt,
    },
    {
      sourceKind: 'api', sourceId: publication.apiObservation.observationId,
      publicationId: publication.publicationId, repository: REPOSITORY,
      githubPrNumber: prNumber, factDigest: publication.apiObservation.factDigest,
      processingState: 'applied', ignoreReason: null,
      externalUpdatedAt: publication.apiObservation.externalUpdatedAt,
      observedAt: publication.apiObservation.observedAt,
      processedAt: publication.apiObservation.observedAt,
    },
  ];
  const auditBody = {
    schemaVersion: '1', runId,
    run: {
      state: 'pull_request_open', version: 8, baseSha,
      activePlanId: planId, activePlanVersion: 1, activePlanDigest: digest(70 + index),
      createdAt: '2026-07-27T10:00:00.000Z', updatedAt: '2026-07-27T14:00:00.000Z',
    },
    task: {
      id: taskId, revision: `revision-${tag}-1`, digest: digest(index),
      repository: REPOSITORY, baseBranch: 'main', targetEnvironment: 'none',
    },
    answers: {
      who: {
        attempts: [{
          attemptId, ordinal: 2, mode: 'implement', status: 'completed',
          repository: REPOSITORY, planId, planVersion: 1, itemId: `change_${tag}`,
          claimedProgressVersion: 1, baseSha: parentSha, headSha,
          githubRunId: actionRunId, githubStatus: 'completed', githubConclusion: 'success',
          createdAt: '2026-07-27T12:04:00.000Z', updatedAt: '2026-07-27T13:05:00.000Z',
        }],
      },
      sourceEvents: [],
      permissions: {
        taskPolicy: {
          repositoryWrite: true, testDeploy: false, productionDeploy: false,
          humanApprovalRequired: true,
        },
        planEffects: [{
          planId, planVersion: 1, planDigest: digest(70 + index),
          itemId: `change_${tag}`, effect: 'repo_write',
        }],
        grants: [],
        repositoryWriteCredentials: [{
          credentialId: `credential_${tag}`, attemptId, planId, planVersion: 1,
          itemId: `change_${tag}`, approvalId: publication.approvalId,
          repository: REPOSITORY, leaseGeneration: 1, status: 'revoked',
          authorizationExpiresAt: '2026-07-27T14:30:00.000Z',
          revokedAt: '2026-07-27T13:10:00.000Z',
          createdAt: '2026-07-27T12:05:00.000Z',
        }],
      },
      contextReads: [],
      approvals: [{
        approvalId: publication.approvalId, taskId, taskRevision: `revision-${tag}-1`,
        approver: `user:reviewer-${tag}`, effect: 'repo_write', decision: 'approve',
        planId, planVersion: 1, planDigest: digest(70 + index), baseSha,
        expiresAt: '2026-07-27T15:00:00.000Z', createdAt: '2026-07-27T12:00:00.000Z',
        rolesDigest: digest(90 + index), provider: 'feishu',
        lineageId: `approval_lineage_${tag}`, sourceRecordId: `card_receipt_${tag}`,
        externalEventId: `approval_event_${tag}`,
        sourceOccurredAt: '2026-07-27T11:59:00.000Z',
        decisionRecordedAt: '2026-07-27T12:00:00.000Z', invalidated: false,
      }],
      deployments: [],
      changes: [{
        kind: 'commit', updateId: `update_${tag}`, attemptId, planId, planVersion: 1,
        itemId: `change_${tag}`, parentSha, headSha, branch,
        evidenceId: `commit_evidence_${tag}`, createdAt: '2026-07-27T13:00:00.000Z',
      }, { ...prChange, createdAt: '2026-07-27T13:40:00.000Z' }],
      checks: {
        commands: commandRows, itemVerifications: verificationRows,
        evidence: auditEvidenceRows, pullRequestObservations: prObservations,
      },
    },
    digests: {
      task: digest(index), plans: [{
        planId, version: 1, digest: digest(70 + index), status: 'active', baseSha,
        createdByAttemptId: `analysis_${tag}`, createdAt: '2026-07-27T11:00:00.000Z',
      }], evidenceArtifacts: [],
    },
    links: [{ kind: 'pull_request', url: publication.url }],
  };
  const audit = {
    ...auditBody, generatedAt: '2026-07-27T14:01:00.000Z', queryDurationMs: 20,
    reportDigest: await canonicalSha256(auditBody),
  };
  return {
    item,
    responses: {
      task: {
        task: {
          id: taskId,
          source: { system: item.task.sourceSystem, revision: item.task.sourceRevision },
          digest: item.task.taskDigest,
          target: { repository: REPOSITORY, baseBranch: 'main' },
          intent: { kind: scenario, acceptanceCriteriaCount: 2 },
        },
        run: {
          id: runId, state: 'pull_request_open', version: 8,
          activePlan: { id: planId, version: 1, digest: digest(70 + index) },
        },
      },
      plan: {
        run: { id: runId, state: 'pull_request_open', version: 8 },
        plan: {
          id: planId, version: 1, digest: digest(70 + index), baseSha, status: 'active',
        },
        items: itemRows,
        attempts: [{
          id: attemptId, mode: 'implement', status: 'completed', planId,
          planVersion: 1, planItemId: `change_${tag}`, headBranch: branch, headSha,
          githubRunId: actionRunId, githubStatus: 'completed', githubConclusion: 'success',
        }],
        evidence: evidenceRows,
      },
      audit,
      action: {
        id: Number(actionRunId), name: 'Delivery Agent',
        display_title: `delivery-loop/${attemptId}`, event: 'workflow_dispatch',
        status: 'completed', conclusion: 'success', head_sha: parentSha,
        repository: { full_name: REPOSITORY },
      },
      jobs: {
        total_count: 1,
        jobs: [{
          id: 7000 + index, run_id: Number(actionRunId), head_sha: parentSha,
          status: 'completed', conclusion: 'success',
          steps: [
            { name: 'Checkout trusted execution snapshot', conclusion: 'success' },
            { name: 'Validate attempt mode bindings', conclusion: 'success' },
            { name: 'Run approved execution attempt', conclusion: 'success' },
          ],
        }],
      },
      compare: {
        status: 'ahead', ahead_by: 1, behind_by: 0,
        base_commit: { sha: baseSha }, merge_base_commit: { sha: baseSha },
        commits: [{ sha: headSha }], files,
      },
      pullRequest: {
        number: prNumber, html_url: publication.url, state: 'open', draft: true, body: prBody,
        head: { ref: branch, sha: headSha, repo: { full_name: REPOSITORY } },
        base: { ref: 'main', repo: { full_name: REPOSITORY } },
      },
    },
  };
}

async function fixture(): Promise<Fixture> {
  const requirement = await buildCase('requirement', 1);
  const bug = await buildCase('bug', 2);
  const parsed = DraftPrCasesEvidenceManifestV1Schema.parse({
    schemaVersion: '1', evidenceId: 'draft_pr_cases_round_114',
    recordedAt: '2026-07-27T15:00:00.000Z', repository: REPOSITORY, baseBranch: 'main',
    cases: [requirement.item, bug.item],
    safety: { canaryDigest: await canonicalSha256(CANARY) },
    review: {
      reviewer: 'delivery_reviewer', reviewedAt: '2026-07-27T14:30:00.000Z',
      requirementSemanticsEvidenceUrl: 'https://evidence.example/draft-pr/requirement-review.json',
      bugRootCauseEvidenceUrl: 'https://evidence.example/draft-pr/bug-root-cause-review.json',
      diffAndTestTraceReviewed: true,
    },
  });
  const responses = new Map<string, CaseResponses>([
    [parsed.cases[0].runId, requirement.responses],
    [parsed.cases[1].runId, bug.responses],
  ]);
  return { manifest: parsed, responses };
}

function response(value: unknown): Response {
  return Response.json(value);
}

async function refreshAuditDigest(audit: Record<string, unknown>): Promise<void> {
  const body = Object.fromEntries(Object.entries(audit).filter(([key]) =>
    key !== 'generatedAt' && key !== 'queryDurationMs' && key !== 'reportDigest'));
  audit.reportDigest = await canonicalSha256(body);
}

function fakeFetch(fixtureValue: Fixture): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.origin === CONTROL_ORIGIN) {
      const task = url.pathname.match(/^\/v1\/tasks\/(.+)$/)?.[1];
      if (task !== undefined) {
        const item = fixtureValue.manifest.cases.find((entry) => entry.task.taskId === task)!;
        return response(fixtureValue.responses.get(item.runId)!.task);
      }
      const run = url.pathname.match(/^\/v1\/runs\/([^/]+)\/(plan|audit)$/);
      if (run !== null) {
        const values = fixtureValue.responses.get(run[1]!)!;
        return response(run[2] === 'plan' ? values.plan : values.audit);
      }
    }
    for (const item of fixtureValue.manifest.cases) {
      const values = fixtureValue.responses.get(item.runId)!;
      if (url.pathname.endsWith(`/actions/runs/${item.execution.actionRunId}`)) {
        return response(values.action);
      }
      if (url.pathname.endsWith(`/actions/runs/${item.execution.actionRunId}/jobs`)) {
        return response(values.jobs);
      }
      if (url.pathname.endsWith(
        `/compare/${item.plan.baseSha}...${item.execution.headSha}`,
      )) return response(values.compare);
      if (url.pathname.endsWith(`/pulls/${item.pullRequest.publication.number}`)) {
        return response(values.pullRequest);
      }
    }
    return new Response('not found', { status: 404 });
  };
}

function options(fixtureValue: Fixture) {
  return {
    controlPlaneOrigin: CONTROL_ORIGIN, controlPlaneToken: CONTROL_TOKEN,
    githubToken: GITHUB_TOKEN, canary: CANARY, githubApiOrigin: GITHUB_ORIGIN,
    fetcher: fakeFetch(fixtureValue),
  };
}

describe('requirement and bug Draft PR external evidence', () => {
  it('keeps an exact requirement+bug inventory and checked-in schema example', async () => {
    const value = await fixture();
    expect(DraftPrCasesEvidenceManifestV1Schema.parse(value.manifest).cases.map(
      (item) => item.scenario,
    )).toEqual(['requirement', 'bug']);
    const example = JSON.parse(readFileSync(
      resolve('schemas/draft-pr-cases-evidence-v1.example.json'), 'utf8',
    )) as unknown;
    expect(DraftPrCasesEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(DraftPrCasesEvidenceManifestV1Schema.safeParse({
      ...value.manifest, cases: [value.manifest.cases[1], value.manifest.cases[0]],
    }).success).toBe(false);
    expect(DraftPrCasesEvidenceManifestV1Schema.safeParse({
      ...value.manifest, rawTaskBody: CANARY,
    }).success).toBe(false);
    expect(DraftPrCasesEvidenceManifestV1Schema.safeParse({
      ...value.manifest,
      cases: [
        {
          ...value.manifest.cases[0],
          execution: { ...value.manifest.cases[0].execution, mode: 'review_fix' },
        },
        value.manifest.cases[1],
      ],
    }).success).toBe(false);
    expect(DraftPrCasesEvidenceManifestV1Schema.safeParse({
      ...value.manifest,
      cases: [
        {
          ...value.manifest.cases[0],
          plan: { ...value.manifest.cases[0].plan, requiredItems: [] },
        },
        value.manifest.cases[1],
      ],
    }).success).toBe(false);
    expect(DraftPrCasesEvidenceManifestV1Schema.safeParse({
      ...value.manifest,
      cases: [
        {
          ...value.manifest.cases[0],
          plan: {
            ...value.manifest.cases[0].plan,
            requiredItems: [
              ...value.manifest.cases[0].plan.requiredItems,
              {
                ...value.manifest.cases[0].plan.requiredItems[0],
                itemId: 'change_requirement_second',
              },
            ],
          },
        },
        value.manifest.cases[1],
      ],
    }).success).toBe(false);
  });

  it('cross-checks both Tasks, Plans, commits, tests, Actions, diffs and current Draft PRs',
    async () => {
      const value = await fixture();
      await expect(verifyDraftPrCasesEvidence(value.manifest, options(value)))
        .resolves.toMatchObject({
          verifiedCases: 2, requirementDraftPullRequests: 1, bugDraftPullRequests: 1,
          tracedCommits: 2, tracedTestSuites: 2, changedFiles: 2,
          repoWriteApprovals: 2, readyItemClaims: 2,
          repositoryWriteCredentials: 2, singleCommitDiffs: 2,
          externalActions: 2, plaintextLeaks: 0,
        });
    });

  it('rejects missing required coverage and commit/test lineage drift', async () => {
    const value = await fixture();
    const plan = value.responses.get(value.manifest.cases[0].runId)!.plan;
    (plan.items as Array<Record<string, unknown>>)[0]!.acceptanceCriteriaIndexes = [];
    await expect(verifyDraftPrCasesEvidence(value.manifest, options(value)))
      .rejects.toMatchObject({ code: 'plan_projection_mismatch' });
    (plan.items as Array<Record<string, unknown>>)[0]!.acceptanceCriteriaIndexes = [0, 1];
    const audit = value.responses.get(value.manifest.cases[0].runId)!.audit;
    const answers = audit.answers as Record<string, unknown>;
    const changes = answers.changes as Array<Record<string, unknown>>;
    changes[0]!.headSha = 'f'.repeat(40);
    await expect(verifyDraftPrCasesEvidence(value.manifest, options(value)))
      .rejects.toMatchObject({ code: 'lineage_projection_mismatch' });
  });

  it('rejects approval, ready-claim and repository credential lineage drift', async () => {
    const approvalDrift = await fixture();
    const approvalAudit = approvalDrift.responses
      .get(approvalDrift.manifest.cases[0].runId)!.audit;
    const approvalAnswers = approvalAudit.answers as Record<string, unknown>;
    (approvalAnswers.approvals as Array<Record<string, unknown>>)[0]!.planDigest = digest(255);
    await refreshAuditDigest(approvalAudit);
    await expect(verifyDraftPrCasesEvidence(approvalDrift.manifest, options(approvalDrift)))
      .rejects.toMatchObject({ code: 'lineage_projection_mismatch' });

    const readyDrift = await fixture();
    const readyAudit = readyDrift.responses.get(readyDrift.manifest.cases[0].runId)!.audit;
    const readyAnswers = readyAudit.answers as Record<string, unknown>;
    const who = readyAnswers.who as Record<string, unknown>;
    (who.attempts as Array<Record<string, unknown>>)[0]!.claimedProgressVersion = null;
    await refreshAuditDigest(readyAudit);
    await expect(verifyDraftPrCasesEvidence(readyDrift.manifest, options(readyDrift)))
      .rejects.toMatchObject({ code: 'lineage_projection_mismatch' });

    const credentialDrift = await fixture();
    const credentialAudit = credentialDrift.responses
      .get(credentialDrift.manifest.cases[0].runId)!.audit;
    const credentialAnswers = credentialAudit.answers as Record<string, unknown>;
    const permissions = credentialAnswers.permissions as Record<string, unknown>;
    (permissions.repositoryWriteCredentials as Array<Record<string, unknown>>)[0]!.repository =
      'example/another-repository';
    await refreshAuditDigest(credentialAudit);
    await expect(verifyDraftPrCasesEvidence(credentialDrift.manifest, options(credentialDrift)))
      .rejects.toMatchObject({ code: 'lineage_projection_mismatch' });

    const newerReject = await fixture();
    const rejectAudit = newerReject.responses.get(newerReject.manifest.cases[0].runId)!.audit;
    const rejectAnswers = rejectAudit.answers as Record<string, unknown>;
    const accepted = (rejectAnswers.approvals as Array<Record<string, unknown>>)[0]!;
    (rejectAnswers.approvals as Array<Record<string, unknown>>).push({
      ...accepted, approvalId: 'approval_requirement_rejected', decision: 'reject',
      createdAt: '2026-07-27T12:01:00.000Z',
    });
    await refreshAuditDigest(rejectAudit);
    await expect(verifyDraftPrCasesEvidence(newerReject.manifest, options(newerReject)))
      .rejects.toMatchObject({ code: 'lineage_projection_mismatch' });

    const secondCommit = await fixture();
    const commitAudit = secondCommit.responses.get(secondCommit.manifest.cases[0].runId)!.audit;
    const commitAnswers = commitAudit.answers as Record<string, unknown>;
    const changes = commitAnswers.changes as Array<Record<string, unknown>>;
    changes.splice(1, 0, {
      ...changes[0], updateId: 'update_requirement_extra',
      evidenceId: 'commit_evidence_requirement_extra',
    });
    await refreshAuditDigest(commitAudit);
    await expect(verifyDraftPrCasesEvidence(secondCommit.manifest, options(secondCommit)))
      .rejects.toMatchObject({ code: 'lineage_projection_mismatch' });
  });

  it('rejects live Action, compare, PR and credential-response drift', async () => {
    const value = await fixture();
    const requirement = value.responses.get(value.manifest.cases[0].runId)!;
    requirement.action.conclusion = 'failure';
    await expect(verifyDraftPrCasesEvidence(value.manifest, options(value)))
      .rejects.toMatchObject({ code: 'github_action_mismatch' });
    requirement.action.conclusion = 'success';
    requirement.compare.files = [];
    await expect(verifyDraftPrCasesEvidence(value.manifest, options(value)))
      .rejects.toMatchObject({ code: 'github_diff_mismatch' });
    requirement.compare.files = [{
      filename: 'src/requirement.ts', status: 'modified', additions: 8, deletions: 2, changes: 10,
    }];
    requirement.compare.ahead_by = 2;
    await expect(verifyDraftPrCasesEvidence(value.manifest, options(value)))
      .rejects.toMatchObject({ code: 'github_diff_mismatch' });
    requirement.compare.ahead_by = 1;
    requirement.pullRequest.draft = false;
    await expect(verifyDraftPrCasesEvidence(value.manifest, options(value)))
      .rejects.toMatchObject({ code: 'github_pull_request_mismatch' });
    requirement.pullRequest.draft = true;
    await expect(verifyDraftPrCasesEvidence(value.manifest, {
      ...options(value),
      fetcher: async (input, init) => String(input).includes('/compare/')
        ? response({ leaked: CANARY }) : await fakeFetch(value)(input, init),
    })).rejects.toMatchObject({ code: 'secret_leak_detected' });
  });

  it('keeps CLI opt-in and incomplete prerequisites distinct from fact failure', () => {
    const run = (environment: NodeJS.ProcessEnv) => spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/verify-draft-pr-cases-evidence.ts'],
      { cwd: resolve('.'), env: { ...process.env, ...environment }, encoding: 'utf8' },
    );
    const disabled = run({ DELIVERY_LOOP_DRAFT_PR_CASES_E2E: '' });
    expect(disabled.status).toBe(2);
    expect(disabled.stderr).toContain('draft-pr-cases-e2e: opt-in missing');
    const incomplete = run({ DELIVERY_LOOP_DRAFT_PR_CASES_E2E: '1' });
    expect(incomplete.status).toBe(2);
    expect(incomplete.stderr).toContain('required evidence configuration is incomplete');
    expect(incomplete.stderr).not.toContain(CANARY);
  });
});
