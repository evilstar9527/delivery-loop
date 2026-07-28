import { probeProviderNetwork } from '../src/agent/provider-network-preflight.js';

try {
  if (process.env.DELIVERY_LOOP_PROVIDER_NETWORK_PREFLIGHT !== '1') {
    console.error('provider-network-preflight: opt-in missing');
    process.exitCode = 2;
  } else {
    const result = await probeProviderNetwork(process.env.OPENAI_BASE_URL);
    const stages = `dns=${String(result.dns)} tcp=${String(result.tcp)} tls=${String(result.tls)}`;
    if (result.code === 'provider_base_url_missing') {
      console.error(`provider-network-preflight: prerequisite missing ${result.code}`);
      process.exitCode = 2;
    } else if (result.code === 'provider_network_preflight_passed') {
      console.log(`provider-network-preflight: PASS ${result.code} ${stages}`);
    } else {
      console.error(`provider-network-preflight: FAIL ${result.code} ${stages}`);
      process.exitCode = 1;
    }
  }
} catch {
  console.error(
    'provider-network-preflight: FAIL provider_network_probe_failed dns=false tcp=false tls=false',
  );
  process.exitCode = 1;
}
