import { z } from 'zod';
import { canonicalSha256 } from './digest.js';
import {
  TaskEnvelopeSchema,
  TaskKindSchema,
  TaskPrioritySchema,
  type TaskEnvelope,
} from './task.js';

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const MeeglePrincipalSchema = z.object({
  userKey: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200).optional(),
}).strict();

const MeegleFieldValueSchema = z.union([
  z.string().max(1_000_000),
  z.array(z.string().max(20_000)).max(200),
  z.null(),
]);

const MeegleFieldProjectionSchema = z.object({
  fieldKey: z.string().regex(KEY_PATTERN),
  value: MeegleFieldValueSchema,
}).strict();

const MeegleRoleProjectionSchema = z.object({
  roleKey: z.string().regex(KEY_PATTERN),
  owners: z.array(MeeglePrincipalSchema).max(100),
}).strict();

function uniqueProjectionKeys(
  values: readonly { fieldKey?: string; roleKey?: string }[],
  key: 'fieldKey' | 'roleKey',
): boolean {
  const keys = values.map((value) => value[key]);
  return new Set(keys).size === keys.length;
}

export const MeegleWorkItemSnapshotV1Schema = z.object({
  schemaVersion: z.literal('1'),
  eventId: z.string().min(1).max(200),
  eventOccurredAt: z.iso.datetime({ offset: true }),
  tenantKey: z.string().regex(KEY_PATTERN),
  projectKey: z.string().regex(KEY_PATTERN),
  workItemTypeKey: z.string().regex(KEY_PATTERN),
  workItemId: z.string().regex(KEY_PATTERN),
  revision: z.string().min(1).max(500).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
  url: z.url().nullable(),
  title: z.string().max(10_000).nullable(),
  description: z.string().max(1_000_000).nullable(),
  actor: z.object({
    type: z.enum(['user', 'bot', 'system']),
    id: z.string().min(1).max(200),
    displayName: z.string().min(1).max(200).optional(),
  }).strict(),
  fieldsComplete: z.boolean(),
  nextPageToken: z.string().min(1).max(500).nullable(),
  fields: z.array(MeegleFieldProjectionSchema).max(1_000),
  roles: z.array(MeegleRoleProjectionSchema).max(200),
}).strict().superRefine((snapshot, context) => {
  if (!uniqueProjectionKeys(snapshot.fields, 'fieldKey')) {
    context.addIssue({
      code: 'custom',
      path: ['fields'],
      message: 'field projections must have unique fieldKey values',
    });
  }
  if (!uniqueProjectionKeys(snapshot.roles, 'roleKey')) {
    context.addIssue({
      code: 'custom',
      path: ['roles'],
      message: 'role projections must have unique roleKey values',
    });
  }
});

export type MeegleWorkItemSnapshotV1 = z.infer<typeof MeegleWorkItemSnapshotV1Schema>;

export const MeegleTaskMappingProfileV1Schema = z.object({
  schemaVersion: z.literal('1'),
  profileVersion: z.number().int().positive(),
  tenantKey: z.string().regex(KEY_PATTERN),
  projectKey: z.string().regex(KEY_PATTERN),
  workItemTypeKey: z.string().regex(KEY_PATTERN),
  ownerRoleKey: z.string().regex(KEY_PATTERN),
  acceptanceCriteriaFieldKey: z.string().regex(KEY_PATTERN),
  targetRepositoryFieldKey: z.string().regex(KEY_PATTERN),
  kind: TaskKindSchema,
  baseBranch: z.string().min(1).max(255),
  environment: z.enum(['none', 'test', 'production']),
  defaultPriority: TaskPrioritySchema,
  allowedRepositories: z.array(z.string().regex(REPOSITORY_PATTERN)).min(1).max(200),
}).strict().superRefine((profile, context) => {
  if (new Set(profile.allowedRepositories).size !== profile.allowedRepositories.length) {
    context.addIssue({
      code: 'custom',
      path: ['allowedRepositories'],
      message: 'allowedRepositories must be unique',
    });
  }
});

export type MeegleTaskMappingProfileV1 = z.infer<
  typeof MeegleTaskMappingProfileV1Schema
>;

export const MEEGLE_TRIAGE_GAPS = [
  'source_fields_incomplete',
  'revision_missing',
  'title_missing',
  'title_invalid',
  'description_missing',
  'acceptance_criteria_missing',
  'owner_missing',
  'owner_ambiguous',
  'target_repository_missing',
  'target_repository_invalid',
] as const;

export const MeegleTriageGapSchema = z.enum(MEEGLE_TRIAGE_GAPS);
export type MeegleTriageGap = z.infer<typeof MeegleTriageGapSchema>;

export class MeegleWorkItemMappingError extends Error {
  constructor(readonly code: 'profile_binding_mismatch') {
    super(`Meegle work-item mapping rejected: ${code}`);
    this.name = 'MeegleWorkItemMappingError';
  }
}

export interface MeegleMappedWorkItem {
  kind: 'mapped';
  task: TaskEnvelope;
  snapshotDigest: string;
  profileDigest: string;
}

export interface MeegleTriageCandidate {
  status: 'triaging';
  source: {
    system: 'meego';
    tenantKey: string;
    projectKey: string;
    workItemTypeKey: string;
    workItemId: string;
    revision: string | null;
  };
  gaps: MeegleTriageGap[];
  snapshotDigest: string;
  profileDigest: string;
  mappingProfileVersion: number;
}

export interface MeegleTriagingWorkItem {
  kind: 'triaging';
  candidate: MeegleTriageCandidate;
}

export type MeegleWorkItemMappingResult =
  | MeegleMappedWorkItem
  | MeegleTriagingWorkItem;

function mappingSnapshot(snapshot: MeegleWorkItemSnapshotV1): Omit<
  MeegleWorkItemSnapshotV1,
  'eventId' | 'eventOccurredAt'
> {
  return {
    schemaVersion: snapshot.schemaVersion,
    tenantKey: snapshot.tenantKey,
    projectKey: snapshot.projectKey,
    workItemTypeKey: snapshot.workItemTypeKey,
    workItemId: snapshot.workItemId,
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
    url: snapshot.url,
    title: snapshot.title,
    description: snapshot.description,
    actor: snapshot.actor,
    fieldsComplete: snapshot.fieldsComplete,
    nextPageToken: snapshot.nextPageToken,
    fields: snapshot.fields,
    roles: snapshot.roles,
  };
}

export async function meegleExactSnapshotDigest(
  rawSnapshot: MeegleWorkItemSnapshotV1,
): Promise<string> {
  return await canonicalSha256(MeegleWorkItemSnapshotV1Schema.parse(rawSnapshot));
}

export async function meegleMappingSnapshotDigest(
  rawSnapshot: MeegleWorkItemSnapshotV1,
): Promise<string> {
  const snapshot = MeegleWorkItemSnapshotV1Schema.parse(rawSnapshot);
  return await canonicalSha256(mappingSnapshot(snapshot));
}

export async function meegleMappingProfileDigest(
  rawProfile: MeegleTaskMappingProfileV1,
): Promise<string> {
  return await canonicalSha256(MeegleTaskMappingProfileV1Schema.parse(rawProfile));
}

function acceptanceCriteria(value: z.infer<typeof MeegleFieldValueSchema> | undefined): string[] {
  if (value === undefined || value === null) return [];
  const rawItems = Array.isArray(value)
    ? value
    : (() => {
        const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const checklist = lines.flatMap((line) => {
          const match = /^[-*+]\s+\[[ xX]\]\s+(.+)$/.exec(line);
          return match?.[1] === undefined ? [] : [match[1]];
        });
        return checklist.length > 0 ? checklist : lines;
      })();
  const normalized = rawItems
    .map((item) => item.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, ''))
    .filter(Boolean);
  return [...new Set(normalized)];
}

function fieldValue(
  snapshot: MeegleWorkItemSnapshotV1,
  fieldKey: string,
): z.infer<typeof MeegleFieldValueSchema> | undefined {
  return snapshot.fields.find((field) => field.fieldKey === fieldKey)?.value;
}

function sourceProjection(snapshot: MeegleWorkItemSnapshotV1): MeegleTriageCandidate['source'] {
  return {
    system: 'meego',
    tenantKey: snapshot.tenantKey,
    projectKey: snapshot.projectKey,
    workItemTypeKey: snapshot.workItemTypeKey,
    workItemId: snapshot.workItemId,
    revision: snapshot.revision,
  };
}

export async function mapMeegleWorkItem(
  rawSnapshot: MeegleWorkItemSnapshotV1,
  rawProfile: MeegleTaskMappingProfileV1,
): Promise<MeegleWorkItemMappingResult> {
  const snapshot = MeegleWorkItemSnapshotV1Schema.parse(rawSnapshot);
  const profile = MeegleTaskMappingProfileV1Schema.parse(rawProfile);
  if (
    snapshot.tenantKey !== profile.tenantKey ||
    snapshot.projectKey !== profile.projectKey ||
    snapshot.workItemTypeKey !== profile.workItemTypeKey
  ) throw new MeegleWorkItemMappingError('profile_binding_mismatch');

  const snapshotDigest = await meegleMappingSnapshotDigest(snapshot);
  const profileDigest = await meegleMappingProfileDigest(profile);
  const gaps: MeegleTriageGap[] = [];
  if (!snapshot.fieldsComplete || snapshot.nextPageToken !== null) {
    gaps.push('source_fields_incomplete');
  }
  if (snapshot.revision === null) gaps.push('revision_missing');
  const title = snapshot.title?.trim() ?? '';
  if (title.length === 0) gaps.push('title_missing');
  else if (title.length > 200) gaps.push('title_invalid');
  const description = snapshot.description?.trim() ?? '';
  if (description.length === 0) gaps.push('description_missing');

  const criteria = acceptanceCriteria(
    fieldValue(snapshot, profile.acceptanceCriteriaFieldKey),
  );
  if (criteria.length === 0) gaps.push('acceptance_criteria_missing');

  const owners = snapshot.roles.find((role) => role.roleKey === profile.ownerRoleKey)?.owners ?? [];
  if (owners.length === 0) gaps.push('owner_missing');
  else if (owners.length !== 1) gaps.push('owner_ambiguous');

  const rawRepository = fieldValue(snapshot, profile.targetRepositoryFieldKey);
  let repository: string | null = null;
  if (
    rawRepository === undefined || rawRepository === null ||
    (typeof rawRepository === 'string' && rawRepository.trim().length === 0)
  ) {
    gaps.push('target_repository_missing');
  } else if (
    typeof rawRepository !== 'string' || !REPOSITORY_PATTERN.test(rawRepository.trim()) ||
    !profile.allowedRepositories.includes(rawRepository.trim())
  ) {
    gaps.push('target_repository_invalid');
  } else {
    repository = rawRepository.trim();
  }

  if (gaps.length > 0) {
    return {
      kind: 'triaging',
      candidate: {
        status: 'triaging',
        source: sourceProjection(snapshot),
        gaps,
        snapshotDigest,
        profileDigest,
        mappingProfileVersion: profile.profileVersion,
      },
    };
  }

  const [repositoryOwner, repositoryName] = repository!.split('/');
  const sourceOwner = owners[0]!;
  const task = TaskEnvelopeSchema.parse({
    schemaVersion: '1',
    eventId: snapshot.eventId,
    occurredAt: snapshot.eventOccurredAt,
    source: {
      system: 'meego',
      tenantKey: snapshot.tenantKey,
      taskKey: `${snapshot.projectKey}/${snapshot.workItemTypeKey}/${snapshot.workItemId}`,
      revision: snapshot.revision!,
      ...(snapshot.url === null ? {} : { url: snapshot.url }),
    },
    actor: snapshot.actor,
    coordination: {
      owner: {
        id: sourceOwner.userKey,
        ...(sourceOwner.displayName === undefined
          ? {}
          : { displayName: sourceOwner.displayName }),
      },
    },
    target: {
      owner: repositoryOwner,
      repo: repositoryName,
      baseBranch: profile.baseBranch,
      environment: profile.environment,
    },
    intent: {
      kind: profile.kind,
      title,
      description,
      acceptanceCriteria: criteria,
      priority: profile.defaultPriority,
    },
    policy: {
      allowRepositoryWrite: false,
      allowTestDeploy: false,
      allowProductionDeploy: false,
      requireHumanApproval: true,
    },
  });
  return { kind: 'mapped', task, snapshotDigest, profileDigest };
}
