/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

// Copied from Watt: Cloudflare's migration tracker makes this safe across test files.
beforeAll(async () => {
  await applyD1Migrations(env.DB_CONTROL, env.TEST_MIGRATIONS);
});
