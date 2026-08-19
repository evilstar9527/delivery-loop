/**
 * 一次性:生成注册 Cloudflare sandbox executor profile + routes 的 SQL。
 * 用真实代码算出 configuration/capabilities,保证与 registerProfile 的 digest 校验一致。
 * 输出 SQL 到 stdout,再由 wrangler d1 execute 灌入 remote 库。
 */
import { cloudflareSandboxExecutorProfile, CloudflareSandboxExecutorPlugin } from '../src/executor/plugins/cloudflare-sandbox/cloudflare-sandbox-plugin.js';
import type { CloudflareSandboxExecutorEffects } from '../src/executor/plugins/cloudflare-sandbox/cloudflare-sandbox-plugin.js';

const WORKER_ORIGIN = 'https://agent-executor.fantacy.live';
const IMAGE_REF = 'registry.cloudflare.com/041d4868e5611b45f9959f4f58c1e4c7/delivery-agent-sandbox@sha256:c168baf955f7879859d7395ec24126ea158aa4c147684880e1a67d24d3e8fa8a';
const RELEASE_DIGEST = 'sha256:c168baf955f7879859d7395ec24126ea158aa4c147684880e1a67d24d3e8fa8a';
const PROFILE_ID = 'cloudflare-sandbox-openrouter-http-v2';
const REPOSITORY = 'evilstar9527/delivery-loop';
const NOW = new Date().toISOString();

const profile = cloudflareSandboxExecutorProfile({
  profileId: PROFILE_ID,
  workerOrigin: WORKER_ORIGIN,
  imageRef: IMAGE_REF,
  releaseDigest: RELEASE_DIGEST,
});

// capabilities 用 plugin 真实计算(effects 用不到,注册只需 capabilities())
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
// 先禁用旧 v1 profile/routes(同 repo+mode+role 只能一个 active)
rows.push(`UPDATE executor_routes SET status='disabled', updated_at=${sqlStr(NOW)} WHERE repository=${sqlStr(REPOSITORY)} AND execution_role='work' AND status='active';`);
rows.push(`UPDATE executor_profiles SET status='retired', retired_at=${sqlStr(NOW)} WHERE profile_id='cloudflare-sandbox-openrouter-http-v1' AND status='active';`);
// profile (status=active)
rows.push(
  `INSERT INTO executor_profiles (profile_id, schema_version, provider_kind, plugin_schema_version, release_digest, configuration_json, capabilities_json, status, created_at, activated_at, retired_at) VALUES (`
  + `${sqlStr(profile.profileId)}, '1', ${sqlStr(profile.kind)}, ${sqlStr(profile.pluginSchemaVersion)}, ${sqlStr(profile.releaseDigest)}, ${sqlStr(JSON.stringify(profile.configuration))}, ${sqlStr(JSON.stringify(capabilities))}, 'active', ${sqlStr(NOW)}, ${sqlStr(NOW)}, NULL) ON CONFLICT DO NOTHING;`
);
// routes: 3 modes × work role
for (const mode of ['analysis', 'implement', 'review_fix']) {
  const routeId = `cf-http-${REPOSITORY.replace(/[^a-z0-9]/gi, '-')}-${mode}-work-v2`;
  rows.push(
    `INSERT INTO executor_routes (route_id, repository, attempt_mode, execution_role, profile_id, route_version, status, created_at, updated_at) VALUES (`
    + `${sqlStr(routeId)}, ${sqlStr(REPOSITORY)}, ${sqlStr(mode)}, 'work', ${sqlStr(profile.profileId)}, 1, 'active', ${sqlStr(NOW)}, ${sqlStr(NOW)}) ON CONFLICT DO NOTHING;`
  );
}
console.log(rows.join('\n'));
