import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  MEEGLE_EVIDENCE_CLI_VERSION,
  MeegleWorkItemEvidenceManifestV1Schema,
  type MeegleWorkItemEvidenceManifestV1,
} from '../domain/meegle-work-item-evidence.js';
import { MeegleTriageGapSchema, type MeegleTriageGap } from '../domain/meegle-work-item.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const BINARY_PATTERN = /^[^\0\r\n]{1,1000}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,599}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_OUTPUT_BYTES = 2 * 1_024 * 1_024;
const COMMAND_TIMEOUT_MS = 60_000;

const EnvelopeSchema = z.object({
  data: z.unknown(),
  meta: z.record(z.string(), z.unknown()),
  error: z.unknown().nullable(),
}).strict();

const ProjectionSchema = z.object({
  schemaVersion: z.literal('1'),
  tenantKey: z.string().regex(KEY_PATTERN),
  eventId: z.string().regex(ID_PATTERN),
  outcome: z.enum(['mapped', 'triaging']).nullable(),
  counts: z.object({
    mappingLineages: z.number().int().nonnegative().max(100),
    mappedLineages: z.number().int().nonnegative().max(100),
    triageLineages: z.number().int().nonnegative().max(100),
    tasks: z.number().int().nonnegative().max(100),
    runs: z.number().int().nonnegative().max(100),
    workflowCreateOutboxes: z.number().int().nonnegative().max(100),
  }).strict(),
  lineage: z.object({
    ingressOutboxId: z.string().regex(ID_PATTERN),
    projectKey: z.string().regex(KEY_PATTERN),
    workItemTypeKey: z.string().regex(KEY_PATTERN),
    workItemId: z.string().regex(KEY_PATTERN),
    revision: z.string().min(1).max(500).nullable(),
    exactSnapshotDigest: z.string().regex(DIGEST_PATTERN),
    mappingSnapshotDigest: z.string().regex(DIGEST_PATTERN),
    mappingProfileVersion: z.number().int().positive(),
    mappingProfileDigest: z.string().regex(DIGEST_PATTERN),
    acceptanceCriteriaFieldKey: z.string().regex(KEY_PATTERN),
    ownerRoleKey: z.string().regex(KEY_PATTERN),
    targetRepositoryFieldKey: z.string().regex(KEY_PATTERN),
    fieldsComplete: z.boolean(),
    hasNextPageToken: z.boolean(),
    fieldCount: z.number().int().nonnegative().max(1_000),
    roleCount: z.number().int().nonnegative().max(200),
    ownerCount: z.number().int().nonnegative().max(100),
    targetRepositoryStatus: z.enum(['allowed', 'missing', 'invalid']),
    snapshotObjectPresent: z.boolean(),
    snapshotDigestVerified: z.boolean(),
  }).strict().nullable(),
  mapped: z.object({
    sourceTaskKey: z.string().min(1).max(600),
    taskRevision: z.string().min(1).max(500),
    taskDigest: z.string().regex(DIGEST_PATTERN),
    taskId: z.string().regex(ID_PATTERN),
    runId: z.string().regex(ID_PATTERN),
    workflowInstanceId: z.string().regex(ID_PATTERN),
    workflowCreateOutboxId: z.string().regex(ID_PATTERN),
    workflowCreateState: z.enum(['pending', 'delivering', 'settled']),
  }).strict().nullable(),
  triage: z.object({
    candidateId: z.string().regex(ID_PATTERN),
    gaps: z.array(MeegleTriageGapSchema).nonempty(),
    lineageCount: z.number().int().positive().max(100),
  }).strict().nullable(),
}).strict();

type Projection = z.infer<typeof ProjectionSchema>;
type CaseName = keyof MeegleWorkItemEvidenceManifestV1['cases'];

export interface MeegleCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface MeegleCommandRunner {
  run(args: readonly string[]): Promise<MeegleCommandResult>;
}

export type MeegleWorkItemEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'cli_unavailable'
  | 'cli_response_invalid'
  | 'cli_version_mismatch'
  | 'metadata_mismatch'
  | 'pagination_incomplete'
  | 'live_work_item_mismatch'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'lineage_mismatch'
  | 'mapped_result_mismatch'
  | 'triage_mismatch'
  | 'triage_effect_mismatch';

export class MeegleWorkItemEvidenceVerificationError extends Error {
  constructor(readonly code: MeegleWorkItemEvidenceVerificationErrorCode) {
    super(`Meegle work-item evidence verification failed: ${code}`);
    this.name = 'MeegleWorkItemEvidenceVerificationError';
  }
}

export interface MeegleWorkItemEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  operationsToken: string;
  meegleProfile: string;
  tenantKey: string;
  projectKey: string;
  workItemTypeKey: string;
  meegleBinary?: string;
  commandRunner?: MeegleCommandRunner;
  fetch?: typeof fetch;
}

export interface MeegleWorkItemEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  tenantKey: string;
  projectKey: string;
  workItemTypeKey: string;
  checkedWorkItemCount: 5;
  mappedWorkItemCount: 1;
  triagingWorkItemCount: 4;
  mappedTaskId: string;
  mappedRunId: string;
  zeroEffectTriageCount: 4;
}

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new MeegleWorkItemEvidenceVerificationError('configuration_invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new MeegleWorkItemEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

function defaultCommandRunner(binary: string): MeegleCommandRunner {
  return {
    run: async (args) => await new Promise<MeegleCommandResult>((resolve, reject) => {
      const child = spawn(binary, [...args], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let settled = false;
      const timeout: { id?: ReturnType<typeof setTimeout> } = {};
      const finish = (result: MeegleCommandResult | Error): void => {
        if (settled) return;
        settled = true;
        if (timeout.id !== undefined) clearTimeout(timeout.id);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const append = (chunks: Buffer[], chunk: Buffer): void => {
        size += chunk.byteLength;
        if (size > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          finish(new Error('command output exceeded limit'));
          return;
        }
        chunks.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => { append(stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { append(stderr, chunk); });
      child.on('error', (error) => { finish(error); });
      child.on('close', (code) => {
        finish({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      timeout.id = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('command timed out'));
      }, COMMAND_TIMEOUT_MS);
    }),
  };
}

async function runCommand(
  runner: MeegleCommandRunner,
  args: readonly string[],
): Promise<MeegleCommandResult> {
  let result: MeegleCommandResult;
  try { result = await runner.run(args); }
  catch { throw new MeegleWorkItemEvidenceVerificationError('cli_unavailable'); }
  if (
    !Number.isSafeInteger(result.exitCode) || result.exitCode !== 0 ||
    Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8') >
      MAX_OUTPUT_BYTES
  ) throw new MeegleWorkItemEvidenceVerificationError('cli_unavailable');
  return result;
}

async function runEnvelope(
  runner: MeegleCommandRunner,
  args: readonly string[],
): Promise<z.infer<typeof EnvelopeSchema>> {
  const result = await runCommand(runner, args);
  let raw: unknown;
  try { raw = JSON.parse(result.stdout) as unknown; }
  catch { throw new MeegleWorkItemEvidenceVerificationError('cli_response_invalid'); }
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success || parsed.data.error !== null) {
    throw new MeegleWorkItemEvidenceVerificationError('cli_response_invalid');
  }
  return parsed.data;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayAt(data: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(data)) return data;
  const record = object(data);
  if (record === null) return [];
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

function stringAt(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function nullableStringAt(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (record[key] === null) return null;
    const value = stringAt(record, [key]);
    if (value !== null) return value;
  }
  return null;
}

function fieldRecords(data: unknown): Array<{ key: string; value: unknown }> {
  return arrayAt(data, ['fields', 'work_item_fields']).flatMap((raw) => {
    const entry = object(raw);
    if (entry === null) return [];
    const key = stringAt(entry, ['field_key', 'fieldKey', 'key']);
    if (key === null) return [];
    const value = 'value' in entry ? entry.value : entry.field_value;
    return [{ key, value }];
  });
}

function roleRecords(data: unknown): Array<{ key: string; owners: unknown[] }> {
  return arrayAt(data, ['roles', 'role_owners']).flatMap((raw) => {
    const entry = object(raw);
    if (entry === null) return [];
    const key = stringAt(entry, ['role_key', 'roleKey', 'role']);
    const owners = Array.isArray(entry.owners)
      ? entry.owners
      : Array.isArray(entry.user_keys) ? entry.user_keys : [];
    return key === null ? [] : [{ key, owners }];
  });
}

function criteria(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : typeof value === 'string'
      ? value.split(/\r?\n/).map((line) => line.replace(/^[-*+]\s+\[[ xX]\]\s+/, ''))
      : [];
  return values.map((entry) => entry.trim()).filter(Boolean);
}

function scalarFieldValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim();
  const record = object(value);
  if (record === null) return null;
  return stringAt(record, ['value', 'name', 'label'])?.trim() ?? null;
}

function liveGaps(
  data: Record<string, unknown>,
  manifest: MeegleWorkItemEvidenceManifestV1,
): MeegleTriageGap[] {
  const gaps: MeegleTriageGap[] = [];
  const revision = nullableStringAt(data, ['revision', 'updated_at', 'updatedAt']);
  if (revision === null || revision.trim() === '') gaps.push('revision_missing');
  const title = nullableStringAt(data, ['title', 'name'])?.trim() ?? '';
  if (title === '') gaps.push('title_missing');
  else if (title.length > 200) gaps.push('title_invalid');
  const description = nullableStringAt(data, ['description'])?.trim() ?? '';
  if (description === '') gaps.push('description_missing');
  const fields = fieldRecords(data);
  const acceptance = fields.find(
    (field) => field.key === manifest.mappingProfile.acceptanceCriteriaFieldKey,
  );
  if (criteria(acceptance?.value).length === 0) gaps.push('acceptance_criteria_missing');
  const owners = roleRecords(data).find(
    (role) => role.key === manifest.mappingProfile.ownerRoleKey,
  )?.owners ?? [];
  if (owners.length === 0) gaps.push('owner_missing');
  else if (owners.length !== 1) gaps.push('owner_ambiguous');
  const repository = scalarFieldValue(fields.find(
    (field) => field.key === manifest.mappingProfile.targetRepositoryFieldKey,
  )?.value);
  if (repository === null || repository === '') gaps.push('target_repository_missing');
  else if (!manifest.mappingProfile.allowedRepositories.includes(repository)) {
    gaps.push('target_repository_invalid');
  }
  return gaps;
}

function metadataList(data: unknown): Record<string, unknown>[] {
  return arrayAt(data, ['list', 'fields', 'roles', 'items'])
    .map(object)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

async function verifyMetadata(
  runner: MeegleCommandRunner,
  manifest: MeegleWorkItemEvidenceManifestV1,
): Promise<void> {
  const common = [
    '--project-key', manifest.source.projectKey,
    '--work-item-type', manifest.source.workItemTypeKey,
    '--page-num', '1',
  ];
  const fields = await runEnvelope(runner, [
    'workitem', 'meta-fields', ...common,
    '--field-keys', JSON.stringify([
      manifest.mappingProfile.acceptanceCriteriaFieldKey,
      manifest.mappingProfile.targetRepositoryFieldKey,
    ]),
    '--auto-paginate', '--envelope', '--format', 'json',
    '--profile', manifest.cli.profile,
  ]);
  assertCompleteEnvelope(fields);
  const fieldMetadata = metadataList(fields.data);
  const exactField = (key: string, type: string): boolean => fieldMetadata.some((entry) =>
    stringAt(entry, ['field_key', 'fieldKey', 'key']) === key &&
    stringAt(entry, ['field_type', 'field_type_key', 'fieldType', 'type']) === type);
  if (
    !exactField(
      manifest.mappingProfile.acceptanceCriteriaFieldKey,
      manifest.mappingProfile.acceptanceCriteriaFieldType,
    ) ||
    !exactField(
      manifest.mappingProfile.targetRepositoryFieldKey,
      manifest.mappingProfile.targetRepositoryFieldType,
    )
  ) throw new MeegleWorkItemEvidenceVerificationError('metadata_mismatch');

  const roles = await runEnvelope(runner, [
    'workitem', 'meta-roles', ...common,
    '--role-keys', JSON.stringify([manifest.mappingProfile.ownerRoleKey]),
    '--auto-paginate', '--envelope', '--format', 'json',
    '--profile', manifest.cli.profile,
  ]);
  assertCompleteEnvelope(roles);
  if (!metadataList(roles.data).some((entry) =>
    stringAt(entry, ['role_key', 'roleKey', 'key']) === manifest.mappingProfile.ownerRoleKey)) {
    throw new MeegleWorkItemEvidenceVerificationError('metadata_mismatch');
  }
}

function paginationNumber(meta: Record<string, unknown>, key: string, fallback: number): number {
  const value = meta[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
}

function assertCompleteEnvelope(response: z.infer<typeof EnvelopeSchema>): void {
  const data = object(response.data);
  if (
    response.meta.truncated === true ||
    (typeof response.meta.stopped_reason === 'string' && response.meta.stopped_reason !== '') ||
    (data !== null && typeof data.next_page_token === 'string' && data.next_page_token !== '')
  ) throw new MeegleWorkItemEvidenceVerificationError('pagination_incomplete');
}

async function verifyLiveWorkItem(
  runner: MeegleCommandRunner,
  manifest: MeegleWorkItemEvidenceManifestV1,
  name: CaseName,
): Promise<void> {
  const expected = manifest.cases[name];
  const response = await runEnvelope(runner, [
    'workitem', 'get',
    '--project-key', manifest.source.projectKey,
    '--work-item-id', expected.workItemId,
    '--fields', '["_all"]',
    '--params', '{"page_size":200}',
    '--auto-paginate', '--envelope', '--format', 'json',
    '--profile', manifest.cli.profile,
  ]);
  const data = object(response.data);
  assertCompleteEnvelope(response);
  if (data === null) throw new MeegleWorkItemEvidenceVerificationError('cli_response_invalid');
  const fields = fieldRecords(data);
  const pagesMerged = paginationNumber(response.meta, 'pages_merged', 1);
  const totalItems = paginationNumber(response.meta, 'total_items', fields.length);
  if (
    pagesMerged !== expected.pagesMerged || totalItems !== expected.totalItems ||
    (pagesMerged > 1 && response.meta.auto_paginated !== true)
  ) throw new MeegleWorkItemEvidenceVerificationError('pagination_incomplete');
  const projectKey = stringAt(data, ['project_key', 'projectKey']);
  const typeKey = stringAt(data, ['work_item_type_key', 'workItemTypeKey', 'work_item_type']);
  const workItemId = stringAt(data, ['work_item_id', 'workItemId', 'id']);
  const revision = nullableStringAt(data, ['revision', 'updated_at', 'updatedAt']);
  if (
    projectKey !== manifest.source.projectKey || typeKey !== manifest.source.workItemTypeKey ||
    workItemId !== expected.workItemId || revision !== expected.revision
  ) throw new MeegleWorkItemEvidenceVerificationError('live_work_item_mismatch');
  if (
    name !== 'paginationIncomplete' &&
    JSON.stringify(liveGaps(data, manifest)) !== JSON.stringify(expected.expectedGaps)
  ) throw new MeegleWorkItemEvidenceVerificationError('live_work_item_mismatch');
}

async function readBounded(response: Response): Promise<unknown> {
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new MeegleWorkItemEvidenceVerificationError('control_plane_unavailable');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_OUTPUT_BYTES) {
    await response.body?.cancel();
    throw new MeegleWorkItemEvidenceVerificationError('control_plane_response_invalid');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_OUTPUT_BYTES) {
        await reader.cancel();
        throw new MeegleWorkItemEvidenceVerificationError('control_plane_response_invalid');
      }
      chunks.push(part.value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new MeegleWorkItemEvidenceVerificationError('control_plane_response_invalid'); }
}

async function projection(
  fetcher: typeof fetch,
  origin: string,
  token: string,
  tenantKey: string,
  eventId: string,
): Promise<Projection> {
  const query = new URLSearchParams({ tenantKey, eventId });
  let response: Response;
  try {
    response = await fetcher(`${origin}/v1/operations/meegle/evidence?${query}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
    });
  } catch {
    throw new MeegleWorkItemEvidenceVerificationError('control_plane_unavailable');
  }
  const parsed = ProjectionSchema.safeParse(await readBounded(response));
  if (!parsed.success) {
    throw new MeegleWorkItemEvidenceVerificationError('control_plane_response_invalid');
  }
  return parsed.data;
}

function verifyLineage(
  manifest: MeegleWorkItemEvidenceManifestV1,
  name: CaseName,
  value: Projection,
): void {
  const expected = manifest.cases[name];
  const lineage = value.lineage;
  const paginationCase = name === 'paginationIncomplete';
  if (
    value.tenantKey !== manifest.source.tenantKey || value.eventId !== expected.eventId ||
    value.counts.mappingLineages !== 1 || lineage === null ||
    lineage.projectKey !== manifest.source.projectKey ||
    lineage.workItemTypeKey !== manifest.source.workItemTypeKey ||
    lineage.workItemId !== expected.workItemId || lineage.revision !== expected.revision ||
    lineage.exactSnapshotDigest !== expected.exactSnapshotDigest ||
    lineage.mappingSnapshotDigest !== expected.mappingSnapshotDigest ||
    lineage.mappingProfileVersion !== manifest.mappingProfile.version ||
    lineage.mappingProfileDigest !== manifest.mappingProfile.digest ||
    lineage.acceptanceCriteriaFieldKey !== manifest.mappingProfile.acceptanceCriteriaFieldKey ||
    lineage.ownerRoleKey !== manifest.mappingProfile.ownerRoleKey ||
    lineage.targetRepositoryFieldKey !== manifest.mappingProfile.targetRepositoryFieldKey ||
    lineage.snapshotObjectPresent !== true || lineage.snapshotDigestVerified !== true ||
    lineage.fieldsComplete === paginationCase || lineage.hasNextPageToken !== paginationCase
  ) throw new MeegleWorkItemEvidenceVerificationError('lineage_mismatch');
}

function verifyMapped(
  manifest: MeegleWorkItemEvidenceManifestV1,
  value: Projection,
): void {
  const expected = manifest.mappedResult;
  const mapped = value.mapped;
  if (
    value.outcome !== 'mapped' || value.counts.mappedLineages !== 1 ||
    value.counts.triageLineages !== 0 || value.counts.tasks !== 1 ||
    value.counts.runs !== 1 || value.counts.workflowCreateOutboxes !== 1 ||
    value.triage !== null || mapped === null ||
    mapped.sourceTaskKey !== expected.sourceTaskKey ||
    mapped.taskRevision !== expected.taskRevision || mapped.taskDigest !== expected.taskDigest ||
    mapped.taskId !== expected.taskId || mapped.runId !== expected.runId ||
    mapped.workflowInstanceId !== expected.workflowInstanceId ||
    mapped.workflowInstanceId !== mapped.runId ||
    mapped.workflowCreateOutboxId !== expected.workflowCreateOutboxId
  ) throw new MeegleWorkItemEvidenceVerificationError('mapped_result_mismatch');
}

function verifyTriage(
  manifest: MeegleWorkItemEvidenceManifestV1,
  name: Exclude<CaseName, 'mapped'>,
  value: Projection,
): void {
  if (
    value.outcome !== 'triaging' || value.counts.mappedLineages !== 0 ||
    value.counts.triageLineages !== 1 || value.mapped !== null
  ) throw new MeegleWorkItemEvidenceVerificationError('triage_mismatch');
  if (
    value.counts.tasks !== 0 || value.counts.runs !== 0 ||
    value.counts.workflowCreateOutboxes !== 0
  ) throw new MeegleWorkItemEvidenceVerificationError('triage_effect_mismatch');
  if (
    value.triage === null ||
    JSON.stringify(value.triage.gaps) !== JSON.stringify(manifest.cases[name].expectedGaps)
  ) throw new MeegleWorkItemEvidenceVerificationError('triage_mismatch');
  const lineage = value.lineage!;
  const expectedOwnerCount = name === 'missingFields' ? 0 : name === 'ownerAmbiguous' ? 2 : 1;
  const expectedRepositoryStatus = name === 'missingFields'
    ? 'missing'
    : name === 'repositoryDisallowed' ? 'invalid' : 'allowed';
  if (
    lineage.ownerCount !== expectedOwnerCount ||
    lineage.targetRepositoryStatus !== expectedRepositoryStatus
  ) throw new MeegleWorkItemEvidenceVerificationError('triage_mismatch');
}

export async function verifyMeegleWorkItemEvidence(
  input: MeegleWorkItemEvidenceManifestV1,
  options: MeegleWorkItemEvidenceVerifierOptions,
): Promise<MeegleWorkItemEvidenceVerificationSummary> {
  const parsed = MeegleWorkItemEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new MeegleWorkItemEvidenceVerificationError('manifest_invalid');
  const manifest = parsed.data;
  const origin = safeOrigin(options.controlPlaneOrigin);
  const expectedOrigin = safeOrigin(manifest.controlPlaneOrigin);
  const binary = options.meegleBinary ?? 'meegle';
  if (
    origin !== expectedOrigin || !TOKEN_PATTERN.test(options.operationsToken) ||
    !BINARY_PATTERN.test(binary) || options.meegleProfile !== manifest.cli.profile ||
    options.tenantKey !== manifest.source.tenantKey ||
    options.projectKey !== manifest.source.projectKey ||
    options.workItemTypeKey !== manifest.source.workItemTypeKey
  ) throw new MeegleWorkItemEvidenceVerificationError('configuration_invalid');

  const runner = options.commandRunner ?? defaultCommandRunner(binary);
  const version = await runCommand(runner, ['--version']);
  const versionMatch = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(version.stdout.trim());
  if (versionMatch?.[1] !== MEEGLE_EVIDENCE_CLI_VERSION) {
    throw new MeegleWorkItemEvidenceVerificationError('cli_version_mismatch');
  }
  await verifyMetadata(runner, manifest);
  const caseNames: CaseName[] = [
    'mapped', 'missingFields', 'ownerAmbiguous',
    'repositoryDisallowed', 'paginationIncomplete',
  ];
  for (const name of caseNames) await verifyLiveWorkItem(runner, manifest, name);

  const fetcher = options.fetch ?? fetch;
  const projections = new Map<CaseName, Projection>();
  for (const name of caseNames) {
    projections.set(name, await projection(
      fetcher,
      origin,
      options.operationsToken,
      manifest.source.tenantKey,
      manifest.cases[name].eventId,
    ));
  }
  for (const name of caseNames) verifyLineage(manifest, name, projections.get(name)!);
  verifyMapped(manifest, projections.get('mapped')!);
  for (const name of [
    'missingFields', 'ownerAmbiguous', 'repositoryDisallowed', 'paginationIncomplete',
  ] as const) verifyTriage(manifest, name, projections.get(name)!);

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    tenantKey: manifest.source.tenantKey,
    projectKey: manifest.source.projectKey,
    workItemTypeKey: manifest.source.workItemTypeKey,
    checkedWorkItemCount: 5,
    mappedWorkItemCount: 1,
    triagingWorkItemCount: 4,
    mappedTaskId: manifest.mappedResult.taskId,
    mappedRunId: manifest.mappedResult.runId,
    zeroEffectTriageCount: 4,
  };
}
