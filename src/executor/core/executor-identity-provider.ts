import type { ExecutorPluginRegistry } from './executor-registry.js';
import type {
  ExecutionHandle,
  ExecutorIdentityAssertion,
  ExecutorProfile,
  VerifiedExecutorIdentity,
} from './executor-plugin.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

interface ExecutionIdentityRow {
  execution_id: string;
  attempt_id: string;
  status: string;
  executor_profile_id: string;
  profile_schema_version: string;
  provider_kind: string;
  plugin_schema_version: string;
  release_digest: string;
  configuration_json: string;
  validated_handle_json: string | null;
}

export interface ExecutorIdentityRequest {
  executionId: string;
  attemptId: string;
  payload: unknown;
}

export interface ExecutorIdentityProvider {
  verify(request: ExecutorIdentityRequest): Promise<VerifiedExecutorIdentity>;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

/** Loads only the immutable D1 profile/handle, then delegates transient assertion verification. */
export class RegistryExecutorIdentityProvider implements ExecutorIdentityProvider {
  constructor(
    private readonly db: D1Database,
    private readonly registry: ExecutorPluginRegistry,
  ) {}

  async verify(request: ExecutorIdentityRequest): Promise<VerifiedExecutorIdentity> {
    if (!ID_PATTERN.test(request.executionId) || !ID_PATTERN.test(request.attemptId)) {
      throw new Error('executor identity request is invalid');
    }
    const row = await this.db.prepare(
      `SELECT execution.execution_id, execution.attempt_id, execution.status,
              execution.executor_profile_id, profile.schema_version AS profile_schema_version,
              profile.provider_kind, profile.plugin_schema_version, profile.release_digest,
              profile.configuration_json, execution.validated_handle_json
       FROM attempt_execution_instances AS execution
       JOIN executor_profiles AS profile
         ON profile.profile_id = execution.executor_profile_id
       WHERE execution.execution_id = ? AND execution.attempt_id = ?`,
    ).bind(request.executionId, request.attemptId).first<ExecutionIdentityRow>();
    if (
      row === null || !['starting', 'running'].includes(row.status) ||
      row.validated_handle_json === null
    ) throw new Error('executor identity binding is unavailable');
    const profile: ExecutorProfile = {
      schemaVersion: row.profile_schema_version as '1',
      profileId: row.executor_profile_id,
      kind: row.provider_kind,
      pluginSchemaVersion: row.plugin_schema_version,
      releaseDigest: row.release_digest,
      configuration: parseJson(row.configuration_json, 'executor profile configuration') as
        Record<string, string | number | boolean>,
    };
    const handle = parseJson(row.validated_handle_json, 'executor handle') as ExecutionHandle;
    const assertion: ExecutorIdentityAssertion = {
      schemaVersion: '1',
      profile,
      handle,
      payload: request.payload,
    };
    return await this.registry.verifyIdentity(assertion);
  }
}
