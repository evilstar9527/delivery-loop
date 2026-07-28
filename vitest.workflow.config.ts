import { resolve } from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { exportJWK, generateKeyPair } from 'jose';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations(resolve('migrations'));
const githubOidcTestKey = await generateKeyPair('RS256', { extractable: true });
const githubOidcPublicJwk = {
  ...(await exportJWK(githubOidcTestKey.publicKey)),
  alg: 'RS256',
  kid: 'delivery-loop-test-github-oidc',
  use: 'sig',
};
const githubOidcPrivateJwk = {
  ...(await exportJWK(githubOidcTestKey.privateKey)),
  alg: 'RS256',
  kid: githubOidcPublicJwk.kid,
};

export default defineConfig({
  test: {
    include: ['test/workflow/**/*.test.ts'],
    setupFiles: ['./test/workflow/apply-migrations.ts'],
    testTimeout: 15_000,
    // D1 concurrency cases already create 20 in-file requests. Serialize files:
    // their reset/seed fixtures share the configured local D1 binding, so parallel
    // files can delete another file's rows and create intermittent 409 responses.
    maxWorkers: 1,
  },
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          TASK_INTAKE_TOKEN: 'test-task-intake-token',
          OPERATIONS_TOKEN: 'test-operations-token',
          APPROVAL_ADAPTER_TOKEN: 'test-approval-adapter-token',
          FEISHU_APP_ID: 'cli_test_delivery_loop',
          FEISHU_DELIVERY_TENANT_KEY: 'test-feishu-tenant',
          FEISHU_DELIVERY_CHAT_ID: 'oc_feishu_delivery_status',
          FEISHU_EVENT_ENCRYPT_KEY: 'test-feishu-event-encrypt-key',
          FEISHU_EVENT_VERIFICATION_TOKEN: 'test-feishu-event-verification-token',
          MONITOR_WEBHOOK_SECRET: 'test-monitor-webhook-secret',
          MONITOR_TENANT_KEY: 'test-monitor-tenant',
          MONITOR_ALLOWED_REPOSITORIES: '["example/delivery-target"]',
          MONITOR_SUPPRESSION_WINDOW_SECONDS: '60',
          RAW_AGENT_ARTIFACT_ENCRYPTION_KEY:
            'XOL8MO7eCWDeaTn27cjz6KkV2u3o0d1KnpKzVQxUebQ',
          GITHUB_WEBHOOK_SECRET: 'test-github-webhook-secret',
          GITHUB_OIDC_JWKS: JSON.stringify({ keys: [githubOidcPublicJwk] }),
          TEST_GITHUB_OIDC_PRIVATE_JWK: JSON.stringify(githubOidcPrivateJwk),
        },
      },
    }),
  ],
});
