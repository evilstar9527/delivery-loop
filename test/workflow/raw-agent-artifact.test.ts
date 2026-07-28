/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { EXECUTION_TOOL_ACTIONS } from '../../src/domain/tool-bridge.js';

const BASE_URL = 'https://delivery-loop.test';
const RUN_ID = 'run-raw-artifact';
const TASK_ID = 'task-raw-artifact';
const ATTEMPT_ID = 'attempt-raw-artifact';
const ANALYSIS_ATTEMPT_ID = 'attempt-raw-artifact-analysis';
const PLAN_ID = 'plan-raw-artifact';
const ITEM_ID = 'item-raw-artifact';
const RAW_TOKEN = 'runner-raw-artifact-token';
const ARTIFACT_ID = '11111111-2222-4333-8444-555555555555';
const ENCRYPTION_KEY = 'XOL8MO7eCWDeaTn27cjz6KkV2u3o0d1KnpKzVQxUebQ';
const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const PLAN_DIGEST = `sha256:${'3'.repeat(64)}`;
const PUBLIC_MARKER = 'PUBLIC_AGENT_TRANSCRIPT_MARKER';

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

async function upload(body: Record<string, unknown>, token = RAW_TOKEN): Promise<Response> {
  return await SELF.fetch(`${BASE_URL}/v1/attempts/${ATTEMPT_ID}/artifacts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function clearRawObjects(): Promise<void> {
  const objects = await env.RAW_AGENT_OBJECTS.list();
  if (objects.objects.length > 0) {
    await env.RAW_AGENT_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
}

async function seed(): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  const taskDigest = `sha256:${'4'.repeat(64)}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM raw_agent_artifact_uploads'),
    env.DB_CONTROL.prepare('DELETE FROM raw_agent_artifacts'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'artifact-test', ?, '1', ?, 'r2://tasks/artifact-test',
                 'system', 'artifact-test', 'example/repo', 'main', 'test',
                 'requirement', 'Persist an encrypted Agent artifact', 'p1', 1,
                 1, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, TASK_ID, taskDigest, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, '1', ?, ?, ?, 'executing', 3, ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, taskDigest, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, 'example/repo',
                 'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 1, ?, ?)`,
    ).bind(ANALYSIS_ATTEMPT_ID, RUN_ID, BASE_SHA, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, '1', ?, ?, 'active', ?,
                 'Persist an encrypted transcript.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, ANALYSIS_ATTEMPT_ID, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, ?, 'change', 'Persist transcript',
                 'Persist only encrypted, scanned Agent output.', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, plan_id, plan_version, plan_item_id,
         head_branch, head_sha, version, lease_generation, lease_expires_at,
         heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'running', ?, 'example/repo',
                 'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 '400002', ?, 1, ?, 'agent/task/artifact', ?, 1, 1, ?, ?, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      RUN_ID,
      BASE_SHA,
      PLAN_ID,
      ITEM_ID,
      HEAD_SHA,
      expiresAt,
      nowIso,
      nowIso,
      nowIso,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, ?, 'in_progress', ?, 2, ?)`,
    ).bind(PLAN_ID, ITEM_ID, ATTEMPT_ID, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, lease_generation,
         scopes_json, expires_at, created_at
       ) VALUES ('token-raw-artifact', ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      `sha256:${'5'.repeat(64)}`,
      await canonicalSha256(RAW_TOKEN),
      JSON.stringify(EXECUTION_TOOL_ACTIONS),
      expiresAt,
      nowIso,
    ),
  ]);
}

beforeEach(async () => {
  await clearRawObjects();
  await seed();
});

describe('fenced encrypted raw Agent artifact producer', () => {
  it('converges, encrypts before R2/D1, and rejects Secrets, stale fencing, or missing scope', async () => {
    const content = `${JSON.stringify({ event: 'agent_step', marker: PUBLIC_MARKER })}\n`;
    const request = {
      schemaVersion: '1',
      artifactId: ARTIFACT_ID,
      category: 'raw_transcript',
      expectedVersion: 1,
      leaseGeneration: 1,
      content,
    };
    const responses = await Promise.all(Array.from({ length: 20 }, () => upload(request)));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.every((response) => [200, 201, 202].includes(response.status))).toBe(true);
    const final = await upload(request);
    expect(final.status).toBe(200);
    const result = await final.json<{
      artifactId: string;
      objectIdentityDigest: string;
      ciphertextDigest: string;
    }>();
    expect(result.artifactId).toBe(ARTIFACT_ID);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM raw_agent_artifacts',
    ).first()).toEqual({ count: 1 });

    const objects = await env.RAW_AGENT_OBJECTS.list();
    expect(objects.objects).toHaveLength(1);
    const object = await env.RAW_AGENT_OBJECTS.get(objects.objects[0]!.key);
    if (object === null) throw new Error('encrypted artifact missing');
    const stored = await object.text();
    expect(stored).not.toContain(PUBLIC_MARKER);
    expect(stored).not.toContain(content);
    const envelope = JSON.parse(stored) as { v: 1; iv: string; ct: string };
    const key = await crypto.subtle.importKey(
      'raw',
      decodeBase64Url(ENCRYPTION_KEY),
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: decodeBase64Url(envelope.iv),
      additionalData: new TextEncoder().encode(result.objectIdentityDigest),
    }, key, decodeBase64Url(envelope.ct));
    expect(new TextDecoder().decode(plaintext)).toBe(content);

    expect((await upload({ ...request, content: `${content}changed` })).status).toBe(409);
    expect((await upload({ ...request, expectedVersion: 2 })).status).toBe(409);
    expect((await upload(request, 'wrong-token')).status).toBe(401);

    const configuredCanary = env.GITHUB_WEBHOOK_SECRET;
    if (configuredCanary === undefined) throw new Error('test Secret missing');
    const rejectedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const rejected = await upload({
      ...request,
      artifactId: rejectedId,
      content: `copied credential ${configuredCanary}`,
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.text()).not.toContain(configuredCanary);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM raw_agent_artifacts',
    ).first()).toEqual({ count: 1 });
    expect((await env.RAW_AGENT_OBJECTS.list()).objects).toHaveLength(1);

    await env.DB_CONTROL.prepare(
      `UPDATE attempt_tokens SET scopes_json = '["repo:read","checkpoint:write"]'
       WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).run();
    expect((await upload({
      ...request,
      artifactId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    })).status).toBe(403);
    const persisted = JSON.stringify(await env.DB_CONTROL.prepare(
      'SELECT * FROM raw_agent_artifacts',
    ).all());
    expect(persisted).not.toContain(PUBLIC_MARKER);
    expect(persisted).not.toContain(configuredCanary);

    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        'UPDATE attempt_tokens SET scopes_json = ? WHERE attempt_id = ?',
      ).bind(JSON.stringify(EXECUTION_TOOL_ACTIONS), ATTEMPT_ID),
      env.DB_CONTROL.prepare(
        'UPDATE attempts SET version = 2 WHERE attempt_id = ?',
      ).bind(ATTEMPT_ID),
    ]);
    const afterHeartbeat = await upload({ ...request, expectedVersion: 2 });
    expect(afterHeartbeat.status).toBe(200);
    expect((await env.RAW_AGENT_OBJECTS.list()).objects).toHaveLength(1);
  });
});
