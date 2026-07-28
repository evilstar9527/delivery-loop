import { describe, expect, it } from 'vitest';
import {
  MeegleTaskMappingProfileV1Schema,
  MeegleWorkItemSnapshotV1Schema,
  mapMeegleWorkItem,
  type MeegleTaskMappingProfileV1,
  type MeegleWorkItemSnapshotV1,
} from '../src/domain/meegle-work-item.js';

const NOW = '2026-07-26T08:00:00.000Z';

function profile(
  overrides: Partial<MeegleTaskMappingProfileV1> = {},
): MeegleTaskMappingProfileV1 {
  return {
    schemaVersion: '1',
    profileVersion: 3,
    tenantKey: 'tenant-a',
    projectKey: 'project-a',
    workItemTypeKey: 'story',
    ownerRoleKey: 'delivery_owner',
    acceptanceCriteriaFieldKey: 'acceptance_criteria',
    targetRepositoryFieldKey: 'target_repository',
    kind: 'requirement',
    baseBranch: 'main',
    environment: 'test',
    defaultPriority: 'p2',
    allowedRepositories: ['example/delivery-pilot'],
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<MeegleWorkItemSnapshotV1> = {},
): MeegleWorkItemSnapshotV1 {
  return {
    schemaVersion: '1',
    eventId: 'event-meegle-1',
    eventOccurredAt: NOW,
    tenantKey: 'tenant-a',
    projectKey: 'project-a',
    workItemTypeKey: 'story',
    workItemId: '4242',
    revision: 'revision-9',
    updatedAt: NOW,
    url: 'https://example.feishu.cn/project/work-item/4242',
    title: 'Add resumable delivery',
    description: 'The control plane must resume without repeating effects.',
    actor: { type: 'user', id: 'source-reporter', displayName: 'Reporter' },
    fieldsComplete: true,
    nextPageToken: null,
    fields: [
      {
        fieldKey: 'acceptance_criteria',
        value: '- [ ] resumes from the last checkpoint\n- [x] does not repeat dispatch',
      },
      { fieldKey: 'target_repository', value: 'example/delivery-pilot' },
      // A normal field with the role key must never be treated as role ownership.
      { fieldKey: 'delivery_owner', value: 'field-owner-is-untrusted' },
    ],
    roles: [
      {
        roleKey: 'delivery_owner',
        owners: [{ userKey: 'owner-user-key', displayName: 'Delivery Owner' }],
      },
    ],
    ...overrides,
  };
}

describe('Meegle work-item mapping', () => {
  it('maps configured fields and the configured role into a read-only TaskEnvelope', async () => {
    const result = await mapMeegleWorkItem(snapshot(), profile());
    expect(result.kind).toBe('mapped');
    if (result.kind !== 'mapped') throw new Error('expected mapped result');
    expect(result.task).toEqual({
      schemaVersion: '1',
      eventId: 'event-meegle-1',
      occurredAt: NOW,
      source: {
        system: 'meego',
        tenantKey: 'tenant-a',
        taskKey: 'project-a/story/4242',
        revision: 'revision-9',
        url: 'https://example.feishu.cn/project/work-item/4242',
      },
      actor: { type: 'user', id: 'source-reporter', displayName: 'Reporter' },
      coordination: {
        owner: { id: 'owner-user-key', displayName: 'Delivery Owner' },
      },
      target: {
        owner: 'example',
        repo: 'delivery-pilot',
        baseBranch: 'main',
        environment: 'test',
      },
      intent: {
        kind: 'requirement',
        title: 'Add resumable delivery',
        description: 'The control plane must resume without repeating effects.',
        acceptanceCriteria: [
          'resumes from the last checkpoint',
          'does not repeat dispatch',
        ],
        priority: 'p2',
      },
      policy: {
        allowRepositoryWrite: false,
        allowTestDeploy: false,
        allowProductionDeploy: false,
        requireHumanApproval: true,
      },
    });
    expect(result.snapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.profileDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('supports issue profiles and string-array acceptance criteria', async () => {
    const result = await mapMeegleWorkItem(
      snapshot({
        workItemTypeKey: 'issue',
        url: null,
        fields: [
          { fieldKey: 'acceptance_criteria', value: ['Reproduced', 'Regression covered'] },
          { fieldKey: 'target_repository', value: 'example/delivery-pilot' },
        ],
      }),
      profile({ workItemTypeKey: 'issue', kind: 'bug', defaultPriority: 'p1' }),
    );
    expect(result.kind).toBe('mapped');
    if (result.kind !== 'mapped') throw new Error('expected mapped result');
    expect(result.task.intent).toMatchObject({
      kind: 'bug',
      priority: 'p1',
      acceptanceCriteria: ['Reproduced', 'Regression covered'],
    });
  });

  it('returns deterministic triaging gaps without fabricating a TaskEnvelope', async () => {
    const result = await mapMeegleWorkItem(
      snapshot({
        revision: null,
        title: null,
        description: '   ',
        fieldsComplete: false,
        nextPageToken: 'business',
        fields: [],
        roles: [],
      }),
      profile(),
    );
    expect(result).toMatchObject({
      kind: 'triaging',
      candidate: {
        status: 'triaging',
        gaps: [
          'source_fields_incomplete',
          'revision_missing',
          'title_missing',
          'description_missing',
          'acceptance_criteria_missing',
          'owner_missing',
          'target_repository_missing',
        ],
      },
    });
    expect(result).not.toHaveProperty('task');
  });

  it('rejects ambiguous ownership, disallowed repositories, and untrusted schema extensions', async () => {
    const ambiguous = await mapMeegleWorkItem(
      snapshot({
        roles: [{
          roleKey: 'delivery_owner',
          owners: [{ userKey: 'owner-a' }, { userKey: 'owner-b' }],
        }],
        fields: [
          { fieldKey: 'acceptance_criteria', value: 'Verified' },
          { fieldKey: 'target_repository', value: 'other/repository' },
        ],
      }),
      profile(),
    );
    expect(ambiguous).toMatchObject({
      kind: 'triaging',
      candidate: {
        gaps: ['owner_ambiguous', 'target_repository_invalid'],
      },
    });

    expect(MeegleWorkItemSnapshotV1Schema.safeParse({
      ...snapshot(),
      policy: { allowRepositoryWrite: true },
    }).success).toBe(false);
    expect(MeegleTaskMappingProfileV1Schema.safeParse({
      ...profile(),
      allowedRepositories: ['example/delivery-pilot', 'example/delivery-pilot'],
    }).success).toBe(false);
    await expect(mapMeegleWorkItem(snapshot(), profile({ tenantKey: 'another-tenant' })))
      .rejects.toMatchObject({ code: 'profile_binding_mismatch' });
  });
});
