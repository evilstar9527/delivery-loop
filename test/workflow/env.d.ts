/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Bindings } from '../../src/env.js';

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
      TASK_INTAKE_TOKEN: string;
      APPROVAL_ADAPTER_TOKEN: string;
      GITHUB_WEBHOOK_SECRET: string;
      GITHUB_OIDC_JWKS: string;
      TEST_GITHUB_OIDC_PRIVATE_JWK: string;
    }
  }
}
