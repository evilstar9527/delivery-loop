import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MeegleWorkItemEvidenceManifestV1Schema,
  type MeegleWorkItemEvidenceManifestV1,
} from '../src/domain/meegle-work-item-evidence.js';
import {
  MeegleWorkItemEvidenceVerificationError,
  verifyMeegleWorkItemEvidence,
  type MeegleCommandResult,
} from '../src/pilot/meegle-work-item-evidence-verifier.js';

const CONTROL_ORIGIN = 'https://control.example.com';
const TENANT_KEY = 'tenant_delivery_loop_pilot';
const PROJECT_KEY = 'project_delivery';
const TYPE_KEY = 'story';
const PROFILE = {
  version: 7,
  digest: `sha256:${'a'.repeat(64)}`,
  acceptanceCriteriaFieldKey: 'acceptance_criteria',
  acceptanceCriteriaFieldType: 'multi_text',
  ownerRoleKey: 'delivery_owner',
  targetRepositoryFieldKey: 'target_repository',
  targetRepositoryFieldType: 'text',
  allowedRepositories: ['example/delivery-pilot'],
} as const;

type CaseName = 'mapped' | 'missingFields' | 'ownerAmbiguous' |
  'repositoryDisallowed' | 'paginationIncomplete';

const CASES: Record<CaseName, {
  eventId: string;
  workItemId: string;
  revision: string | null;
  gaps: string[];
  pagesMerged: number;
  totalItems: number;
  fieldsComplete: boolean;
  hasNextPageToken: boolean;
}> = {
  mapped: {
    eventId: 'evt_meegle_mapped',
    workItemId: 'wi_1001',
    revision: 'revision-11',
    gaps: [],
    pagesMerged: 2,
    totalItems: 4,
    fieldsComplete: true,
    hasNextPageToken: false,
  },
  missingFields: {
    eventId: 'evt_meegle_missing',
    workItemId: 'wi_1002',
    revision: 'revision-12',
    gaps: [
      'description_missing',
      'acceptance_criteria_missing',
      'owner_missing',
      'target_repository_missing',
    ],
    pagesMerged: 1,
    totalItems: 0,
    fieldsComplete: true,
    hasNextPageToken: false,
  },
  ownerAmbiguous: {
    eventId: 'evt_meegle_owner_ambiguous',
    workItemId: 'wi_1003',
    revision: 'revision-13',
    gaps: ['owner_ambiguous'],
    pagesMerged: 1,
    totalItems: 4,
    fieldsComplete: true,
    hasNextPageToken: false,
  },
  repositoryDisallowed: {
    eventId: 'evt_meegle_repo_disallowed',
    workItemId: 'wi_1004',
    revision: 'revision-14',
    gaps: ['target_repository_invalid'],
    pagesMerged: 1,
    totalItems: 4,
    fieldsComplete: true,
    hasNextPageToken: false,
  },
  paginationIncomplete: {
    eventId: 'evt_meegle_pagination_incomplete',
    workItemId: 'wi_1005',
    revision: 'revision-15',
    gaps: ['source_fields_incomplete'],
    pagesMerged: 3,
    totalItems: 4,
    fieldsComplete: false,
    hasNextPageToken: true,
  },
};

function caseManifest(name: CaseName) {
  const entry = CASES[name];
  return {
    eventId: entry.eventId,
    workItemId: entry.workItemId,
    revision: entry.revision,
    expectedGaps: entry.gaps,
    pagesMerged: entry.pagesMerged,
    totalItems: entry.totalItems,
    exactSnapshotDigest: `sha256:${({
      mapped: '1', missingFields: '2', ownerAmbiguous: '3',
      repositoryDisallowed: '4', paginationIncomplete: '5',
    } as const)[name].repeat(64)}`,
    mappingSnapshotDigest: `sha256:${({
      mapped: '6', missingFields: '7', ownerAmbiguous: '8',
      repositoryDisallowed: '9', paginationIncomplete: 'b',
    } as const)[name].repeat(64)}`,
  };
}

function manifest(): MeegleWorkItemEvidenceManifestV1 {
  return MeegleWorkItemEvidenceManifestV1Schema.parse({
    schemaVersion: '1',
    evidenceId: 'meegle-work-item-round-108',
    recordedAt: '2026-07-27T13:30:00.000Z',
    controlPlaneOrigin: CONTROL_ORIGIN,
    cli: {
      version: '1.0.16',
      officialReleaseCommit: '674042f0f58b62962103aff91598c9bc85ccb138',
      profile: 'delivery-loop-evidence',
    },
    source: { tenantKey: TENANT_KEY, projectKey: PROJECT_KEY, workItemTypeKey: TYPE_KEY },
    mappingProfile: PROFILE,
    cases: {
      mapped: caseManifest('mapped'),
      missingFields: caseManifest('missingFields'),
      ownerAmbiguous: caseManifest('ownerAmbiguous'),
      repositoryDisallowed: caseManifest('repositoryDisallowed'),
      paginationIncomplete: caseManifest('paginationIncomplete'),
    },
    mappedResult: {
      sourceTaskKey: `${PROJECT_KEY}/${TYPE_KEY}/${CASES.mapped.workItemId}`,
      taskRevision: CASES.mapped.revision,
      taskDigest: `sha256:${'c'.repeat(64)}`,
      taskId: 'task_meegle_round_108',
      runId: 'run_meegle_round_108',
      workflowInstanceId: 'run_meegle_round_108',
      workflowCreateOutboxId: 'outbox_meegle_round_108',
    },
  });
}

function envelope(data: unknown, meta: Record<string, unknown> = {}): MeegleCommandResult {
  return { exitCode: 0, stdout: JSON.stringify({ data, meta, error: null }), stderr: '' };
}

function liveWorkItem(name: CaseName): MeegleCommandResult {
  const item = CASES[name];
  const common = {
    project_key: PROJECT_KEY,
    work_item_type_key: TYPE_KEY,
    work_item_id: item.workItemId,
    revision: item.revision,
    title: `Title ${name}`,
    description: name === 'missingFields' ? null : `Description ${name}`,
    fields: name === 'missingFields' ? [] : [
      { field_key: PROFILE.acceptanceCriteriaFieldKey, value: ['Criterion one'] },
      {
        field_key: PROFILE.targetRepositoryFieldKey,
        value: name === 'repositoryDisallowed'
          ? 'attacker/not-allowed'
          : PROFILE.allowedRepositories[0],
      },
      { field_key: 'priority', value: 'P2' },
      { field_key: 'status', value: 'open' },
    ],
    roles: name === 'missingFields' ? [] : [{
      role_key: PROFILE.ownerRoleKey,
      owners: name === 'ownerAmbiguous'
        ? [{ user_key: 'owner-a' }, { user_key: 'owner-b' }]
        : [{ user_key: 'owner-a' }],
    }],
  };
  return envelope(common, {
    auto_paginated: item.pagesMerged > 1,
    pages_merged: item.pagesMerged,
    total_items: item.totalItems,
  });
}

function projection(input: MeegleWorkItemEvidenceManifestV1, name: CaseName) {
  const expected = input.cases[name];
  const item = CASES[name];
  const mapped = name === 'mapped';
  return {
    schemaVersion: '1',
    tenantKey: TENANT_KEY,
    eventId: expected.eventId,
    outcome: mapped ? 'mapped' : 'triaging',
    counts: {
      mappingLineages: 1,
      mappedLineages: mapped ? 1 : 0,
      triageLineages: mapped ? 0 : 1,
      tasks: mapped ? 1 : 0,
      runs: mapped ? 1 : 0,
      workflowCreateOutboxes: mapped ? 1 : 0,
    },
    lineage: {
      ingressOutboxId: `ingress_${name}`,
      projectKey: PROJECT_KEY,
      workItemTypeKey: TYPE_KEY,
      workItemId: expected.workItemId,
      revision: expected.revision,
      exactSnapshotDigest: expected.exactSnapshotDigest,
      mappingSnapshotDigest: expected.mappingSnapshotDigest,
      mappingProfileVersion: PROFILE.version,
      mappingProfileDigest: PROFILE.digest,
      acceptanceCriteriaFieldKey: PROFILE.acceptanceCriteriaFieldKey,
      ownerRoleKey: PROFILE.ownerRoleKey,
      targetRepositoryFieldKey: PROFILE.targetRepositoryFieldKey,
      fieldsComplete: item.fieldsComplete,
      hasNextPageToken: item.hasNextPageToken,
      fieldCount: name === 'missingFields' ? 0 : 4,
      roleCount: name === 'missingFields' ? 0 : 1,
      ownerCount: name === 'missingFields' ? 0 : name === 'ownerAmbiguous' ? 2 : 1,
      targetRepositoryStatus: name === 'missingFields'
        ? 'missing'
        : name === 'repositoryDisallowed' ? 'invalid' : 'allowed',
      snapshotObjectPresent: true,
      snapshotDigestVerified: true,
    },
    mapped: mapped ? {
      sourceTaskKey: input.mappedResult.sourceTaskKey,
      taskRevision: input.mappedResult.taskRevision,
      taskDigest: input.mappedResult.taskDigest,
      taskId: input.mappedResult.taskId,
      runId: input.mappedResult.runId,
      workflowInstanceId: input.mappedResult.workflowInstanceId,
      workflowCreateOutboxId: input.mappedResult.workflowCreateOutboxId,
      workflowCreateState: 'settled',
    } : null,
    triage: mapped ? null : {
      candidateId: `candidate_${name}`,
      gaps: expected.expectedGaps,
      lineageCount: 1,
    },
  };
}

function runner(
  input: MeegleWorkItemEvidenceManifestV1,
  overrides: Partial<Record<CaseName, MeegleCommandResult>> = {},
) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: readonly string[]): Promise<MeegleCommandResult> => {
      calls.push([...args]);
      if (args.length === 1 && args[0] === '--version') {
        return { exitCode: 0, stdout: 'meegle version 1.0.16\n', stderr: '' };
      }
      if (args[0] === 'workitem' && args[1] === 'meta-fields') {
        return envelope({ list: [
          { field_key: PROFILE.acceptanceCriteriaFieldKey, field_type: 'multi_text' },
          { field_key: PROFILE.targetRepositoryFieldKey, field_type: 'text' },
        ] });
      }
      if (args[0] === 'workitem' && args[1] === 'meta-roles') {
        return envelope({ list: [{ role_key: PROFILE.ownerRoleKey }] });
      }
      const workItemId = args[args.indexOf('--work-item-id') + 1];
      const name = (Object.entries(input.cases) as Array<[
        CaseName, MeegleWorkItemEvidenceManifestV1['cases'][CaseName]
      ]>).find(([, value]) => value.workItemId === workItemId)?.[0];
      if (name === undefined) return { exitCode: 1, stdout: '', stderr: 'raw failure' };
      return overrides[name] ?? liveWorkItem(name);
    },
  };
}

function fetcher(
  input: MeegleWorkItemEvidenceManifestV1,
  overrides: Partial<Record<CaseName, unknown>> = {},
): typeof fetch {
  return (async (raw, init) => {
    const url = new URL(String(raw));
    expect(url.origin).toBe(CONTROL_ORIGIN);
    expect(init?.headers).toMatchObject({ authorization: 'Bearer CANARY_OPERATIONS_TOKEN' });
    const eventId = url.searchParams.get('eventId');
    const name = (Object.entries(input.cases) as Array<[
      CaseName, MeegleWorkItemEvidenceManifestV1['cases'][CaseName]
    ]>).find(([, value]) => value.eventId === eventId)?.[0];
    return name === undefined
      ? Response.json({}, { status: 404 })
      : Response.json(overrides[name] ?? projection(input, name));
  }) as typeof fetch;
}

function verify(
  input: MeegleWorkItemEvidenceManifestV1,
  commandRunner = runner(input),
  fetchImpl = fetcher(input),
) {
  return verifyMeegleWorkItemEvidence(input, {
    controlPlaneOrigin: CONTROL_ORIGIN,
    operationsToken: 'CANARY_OPERATIONS_TOKEN',
    meegleProfile: input.cli.profile,
    tenantKey: TENANT_KEY,
    projectKey: PROJECT_KEY,
    workItemTypeKey: TYPE_KEY,
    commandRunner,
    fetch: fetchImpl,
  });
}

describe('real Meegle work-item mapping evidence', () => {
  it('defines a strict five-case manifest and canonical example', async () => {
    const input = manifest();
    expect(MeegleWorkItemEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    expect(MeegleWorkItemEvidenceManifestV1Schema.safeParse({
      ...input,
      rawWorkItem: 'PRIVATE_MEEGLE_BODY',
    }).success).toBe(false);
    expect(MeegleWorkItemEvidenceManifestV1Schema.safeParse({
      ...input,
      cli: { ...input.cli, version: 'latest' },
    }).success).toBe(false);
    const example = JSON.parse(await readFile(
      new URL('../schemas/meegle-work-item-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(MeegleWorkItemEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
  });

  it('uses fixed CLI argv and cross-checks metadata, five work items, D1/R2, and one Task/Run', async () => {
    const input = manifest();
    const commandRunner = runner(input);
    const summary = await verify(input, commandRunner);
    expect(summary).toEqual({
      schemaVersion: '1',
      evidenceId: input.evidenceId,
      tenantKey: TENANT_KEY,
      projectKey: PROJECT_KEY,
      workItemTypeKey: TYPE_KEY,
      checkedWorkItemCount: 5,
      mappedWorkItemCount: 1,
      triagingWorkItemCount: 4,
      mappedTaskId: input.mappedResult.taskId,
      mappedRunId: input.mappedResult.runId,
      zeroEffectTriageCount: 4,
    });
    expect(commandRunner.calls).toHaveLength(8);
    expect(commandRunner.calls[0]).toEqual(['--version']);
    expect(commandRunner.calls[1]).toContain('meta-fields');
    expect(commandRunner.calls[2]).toContain('meta-roles');
    for (const call of commandRunner.calls.slice(3)) {
      expect(call).toContain('--auto-paginate');
      expect(call).toContain('--envelope');
      expect(call).toContain('["_all"]');
      expect(call).toContain('{"page_size":200}');
    }
    expect(JSON.stringify(summary)).not.toContain('CANARY_');
  });

  it('rejects metadata drift and incomplete live pagination', async () => {
    const input = manifest();
    const wrongMetadata = runner(input);
    const original = wrongMetadata.run;
    wrongMetadata.run = async (args) => args.includes('meta-fields')
      ? envelope({ list: [{ field_key: 'wrong', field_type: 'text' }] })
      : await original(args);
    await expect(verify(input, wrongMetadata)).rejects.toMatchObject({
      code: 'metadata_mismatch',
    });

    const truncated = runner(input, {
      mapped: envelope({ project_key: PROJECT_KEY }, {
        auto_paginated: true,
        pages_merged: 200,
        total_items: 200,
        truncated: true,
        next_page_token: 'PRIVATE_CURSOR',
      }),
    });
    await expect(verify(input, truncated)).rejects.toMatchObject({
      code: 'pagination_incomplete',
    });
  });

  it('rejects lineage, gaps, R2 verification, and zero-effect drift', async () => {
    const input = manifest();
    const mapped = projection(input, 'mapped');
    await expect(verify(input, runner(input), fetcher(input, {
      mapped: {
        ...mapped,
        lineage: { ...mapped.lineage, exactSnapshotDigest: `sha256:${'f'.repeat(64)}` },
      },
    }))).rejects.toMatchObject({ code: 'lineage_mismatch' });

    const owner = projection(input, 'ownerAmbiguous');
    await expect(verify(input, runner(input), fetcher(input, {
      ownerAmbiguous: {
        ...owner,
        triage: { ...owner.triage!, gaps: ['owner_missing'] },
      },
    }))).rejects.toMatchObject({ code: 'triage_mismatch' });

    const missing = projection(input, 'missingFields');
    await expect(verify(input, runner(input), fetcher(input, {
      missingFields: {
        ...missing,
        lineage: { ...missing.lineage, snapshotDigestVerified: false },
      },
    }))).rejects.toMatchObject({ code: 'lineage_mismatch' });

    const repository = projection(input, 'repositoryDisallowed');
    await expect(verify(input, runner(input), fetcher(input, {
      repositoryDisallowed: {
        ...repository,
        counts: { ...repository.counts, tasks: 1 },
      },
    }))).rejects.toMatchObject({ code: 'triage_effect_mismatch' });
  });

  it('bounds failures, binds authorities, and keeps the live command opt-in', async () => {
    const input = manifest();
    let calls = 0;
    await expect(verifyMeegleWorkItemEvidence(input, {
      controlPlaneOrigin: 'https://attacker.example.com',
      operationsToken: 'CANARY_OPERATIONS_TOKEN',
      meegleProfile: input.cli.profile,
      tenantKey: TENANT_KEY,
      projectKey: PROJECT_KEY,
      workItemTypeKey: TYPE_KEY,
      commandRunner: runner(input),
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    })).rejects.toBeInstanceOf(MeegleWorkItemEvidenceVerificationError);
    expect(calls).toBe(0);

    const unboundProfileRunner = runner(input);
    await expect(verifyMeegleWorkItemEvidence(input, {
      controlPlaneOrigin: CONTROL_ORIGIN,
      operationsToken: 'CANARY_OPERATIONS_TOKEN',
      meegleProfile: 'another-local-profile',
      tenantKey: TENANT_KEY,
      projectKey: PROJECT_KEY,
      workItemTypeKey: TYPE_KEY,
      commandRunner: unboundProfileRunner,
      fetch: fetcher(input),
    })).rejects.toMatchObject({ code: 'configuration_invalid' });
    expect(unboundProfileRunner.calls).toHaveLength(0);

    const raw = 'CANARY_PRIVATE_MEEGLE_UPSTREAM';
    const failedRunner = runner(input);
    failedRunner.run = async () => ({ exitCode: 1, stdout: raw, stderr: raw });
    const failure = await verify(input, failedRunner).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MeegleWorkItemEvidenceVerificationError);
    expect(String(failure)).not.toContain(raw);

    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_MEEGLE_WORK_ITEM_E2E;
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/verify-meegle-work-item-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('meegle-work-item-e2e: opt-in missing');
  });
});
