/**
 * One-shot: emit SQL registering a Cloudflare sandbox executor profile pinned to
 * the Go-capable image plus the tipsy-backend work/publisher routes. Mirrors
 * register-cloudflare-executor.ts so configuration/capabilities are computed by
 * the real plugin and pass registerProfile's digest check. Output to stdout,
 * then piped into `wrangler d1 execute`.
 */
import {
  cloudflareSandboxExecutorProfile,
  CloudflareSandboxExecutorPlugin,
} from '../src/executor/plugins/cloudflare-sandbox/cloudflare-sandbox-plugin.js';
import type { CloudflareSandboxExecutorEffects } from '../src/executor/plugins/cloudflare-sandbox/cloudflare-sandbox-plugin.js';

const WORKER_ORIGIN = 'https://agent-executor.fantacy.live';
const IMAGE_REF =
  'registry.cloudflare.com/041d4868e5611b45f9959f4f58c1e4c7/delivery-agent-sandbox@sha256:230f858d02f2c739008638a7aecdcbaa71d5a37245a8568fd519858ccf0261c3';
const RELEASE_DIGEST = 'sha256:230f858d02f2c739008638a7aecdcbaa71d5a37245a8568fd519858ccf0261c3';
const PROFILE_ID = 'cloudflare-sandbox-openrouter-http-tipsy-v21';
const PRIOR_PROFILE_ID = 'cloudflare-sandbox-openrouter-http-tipsy-v20';
// Advances with the profile so each re-registration writes fresh route_ids and
// route_version — see the route loop below for why both must move together.
const ROUTE_GENERATION = 21;
const REPOSITORY = 'lightspeed-intelligence/tipsy-backend';
const NOW = new Date().toISOString();

// role per mode, mirroring the active evilstar9527/delivery-loop route set.
const ROUTES: ReadonlyArray<{ mode: string; role: string }> = [
  { mode: 'analysis', role: 'work' },
  { mode: 'implement', role: 'work' },
  { mode: 'implement', role: 'publisher' },
  { mode: 'review_fix', role: 'work' },
  { mode: 'review_fix', role: 'publisher' },
];

const profile = cloudflareSandboxExecutorProfile({
  profileId: PROFILE_ID,
  workerOrigin: WORKER_ORIGIN,
  imageRef: IMAGE_REF,
  releaseDigest: RELEASE_DIGEST,
});

const unusedEffects: CloudflareSandboxExecutorEffects = {
  ensureSandbox: async () => { throw new Error('n/a'); },
  observeSandbox: async () => { throw new Error('n/a'); },
  cancelSandbox: async () => { throw new Error('n/a'); },
  verifySandboxIdentity: async () => { throw new Error('n/a'); },
};
const plugin = new CloudflareSandboxExecutorPlugin(unusedEffects);
const capabilities = plugin.capabilities(profile);

function sqlStr(s: string): string { return `'${s.replace(/'/g, "''")}'`; }

const rows: string[] = [];
// Re-point tipsy-backend at the rebuilt image. Disable the prior v1 routes and
// retire the prior profile first — a (repo, mode, role) tuple allows only one
// active route, and the inserts below use ON CONFLICT DO NOTHING so they cannot
// overwrite a still-active row. New routes bump route_version to 2.
rows.push(
  `UPDATE executor_routes SET status='disabled', updated_at=${sqlStr(NOW)} WHERE repository=${sqlStr(REPOSITORY)} AND profile_id=${sqlStr(PRIOR_PROFILE_ID)} AND status='active';`,
);
rows.push(
  `UPDATE executor_profiles SET status='retired', retired_at=${sqlStr(NOW)} WHERE profile_id=${sqlStr(PRIOR_PROFILE_ID)} AND status='active';`,
);
rows.push(
  `INSERT INTO executor_profiles (profile_id, schema_version, provider_kind, plugin_schema_version, release_digest, configuration_json, capabilities_json, status, created_at, activated_at, retired_at) VALUES (`
  + `${sqlStr(profile.profileId)}, '1', ${sqlStr(profile.kind)}, ${sqlStr(profile.pluginSchemaVersion)}, ${sqlStr(profile.releaseDigest)}, ${sqlStr(JSON.stringify(profile.configuration))}, ${sqlStr(JSON.stringify(capabilities))}, 'active', ${sqlStr(NOW)}, ${sqlStr(NOW)}, NULL) ON CONFLICT DO NOTHING;`,
);
for (const { mode, role } of ROUTES) {
  // route_id and route_version must both advance whenever the profile changes:
  // a (repo, mode, role) tuple allows one active route, and the INSERT uses
  // ON CONFLICT DO NOTHING, so reusing a prior route_id would silently leave the
  // repository with zero active routes after the disable above.
  const routeId = `cf-http-${REPOSITORY.replace(/[^a-z0-9]/gi, '-')}-${mode}-${role}-v${ROUTE_GENERATION}`;
  rows.push(
    `INSERT INTO executor_routes (route_id, repository, attempt_mode, execution_role, profile_id, route_version, status, created_at, updated_at) VALUES (`
    + `${sqlStr(routeId)}, ${sqlStr(REPOSITORY)}, ${sqlStr(mode)}, ${sqlStr(role)}, ${sqlStr(profile.profileId)}, ${ROUTE_GENERATION}, 'active', ${sqlStr(NOW)}, ${sqlStr(NOW)}) ON CONFLICT DO NOTHING;`,
  );
}
console.log(rows.join('\n'));
