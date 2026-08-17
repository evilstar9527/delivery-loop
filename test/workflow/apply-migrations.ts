/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

// Copied from Watt: Cloudflare's migration tracker makes this safe across test files.
beforeAll(async () => {
  await applyD1Migrations(env.DB_CONTROL, env.TEST_MIGRATIONS);
  const now = '2026-08-17T00:00:00.000Z';
  const profileId = 'test-github-actions-route-v1';
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO executor_profiles (
         profile_id, schema_version, provider_kind, plugin_schema_version,
         release_digest, configuration_json, capabilities_json, status,
         created_at, activated_at, retired_at
       ) VALUES (?, '1', 'github_actions', '1', ?, ?, ?, 'active', ?, ?, NULL)
       ON CONFLICT DO NOTHING`,
    ).bind(
      profileId,
      'sha256:071a9c98264ad5059cd55a8bf4392c7804539df384e379e771b265607638e6cd',
      JSON.stringify({
        executorRepository: 'example/delivery-loop',
        executorRef: 'refs/heads/main',
      }),
      JSON.stringify({
        workspaceIsolation: 'provider_managed',
        networkIsolation: 'provider_managed',
        supportsCancellation: true,
        supportsReconciliation: true,
        supportsSemanticResume: true,
        supportsPublisherRole: false,
        maxExecutionSeconds: 21_600,
      }),
      now,
      now,
    ),
    ...['example/repo', 'example/delivery-target'].map((repository, index) =>
      env.DB_CONTROL.prepare(
        `INSERT INTO executor_routes (
           route_id, repository, attempt_mode, execution_role, profile_id,
           route_version, status, created_at, updated_at
         ) VALUES (?, ?, 'analysis', 'work', ?, 1, 'active', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(`test-analysis-route-${index + 1}`, repository, profileId, now, now)),
    ...(['implement', 'review_fix'] as const).map((mode, index) =>
      env.DB_CONTROL.prepare(
        `INSERT INTO executor_routes (
           route_id, repository, attempt_mode, execution_role, profile_id,
           route_version, status, created_at, updated_at
         ) VALUES (?, 'example/delivery-target', ?, 'work', ?, 1, 'active', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(`test-execution-route-${index + 1}`, mode, profileId, now, now)),
  ]);
});
