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
    exclude: ['.claude/worktree/**', 'node_modules/**'],
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
        outboundService: async (request: Request) => {
          const url = new URL(request.url);
          if (url.origin !== 'https://github-fetch-through.test') {
            return new Response(null, { status: 502 });
          }
          if (url.pathname === '/redirect') {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://github-fetch-through.test/followed' },
            });
          }
          if (url.pathname === '/followed') {
            return new Response(null, { status: 418 });
          }
          const body = await request.text();
          const authorization = request.headers.get('authorization');
          const signedJwt = authorization?.startsWith('Bearer ') === true &&
            authorization.slice('Bearer '.length).split('.').length === 3;
          const valid =
            url.pathname === '/app/installations/149587996/access_tokens' &&
            request.method === 'POST' &&
            request.headers.get('accept') === 'application/vnd.github+json' &&
            (authorization === 'Bearer test-signed-jwt' || signedJwt) &&
            request.headers.get('content-type') === 'application/json' &&
            request.headers.get('x-github-api-version') === '2022-11-28' &&
            body === JSON.stringify({
              repositories: ['delivery-loop'],
              permissions: { actions: 'write', contents: 'read' },
            });
          return Response.json(valid
            ? signedJwt
              ? {
                  token: ['test', 'installation', 'credential'].join('-'),
                  expires_at: '2099-01-01T00:00:00.000Z',
                }
              : { accepted: true }
            : { accepted: false }, { status: valid ? 201 : 400 });
        },
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
