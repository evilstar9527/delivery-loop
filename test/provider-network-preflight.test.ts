import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  probeProviderNetwork,
  PROVIDER_NETWORK_PREFLIGHT_CODES,
  type ProviderNetworkProbeDependencies,
} from '../src/agent/provider-network-preflight.js';

function dependencies(
  overrides: Partial<ProviderNetworkProbeDependencies> = {},
): ProviderNetworkProbeDependencies {
  return {
    resolve: vi.fn().mockResolvedValue([{ address: '203.1.2.3', family: 4 }]),
    connectTcp: vi.fn().mockResolvedValue(undefined),
    connectTls: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('provider network preflight', () => {
  it.each([
    '',
    ' https://relay.example.test/v1',
    'http://relay.example.test/v1',
    'https://user@relay.example.test/v1',
    'https://relay.example.test/v1?key=value',
    'https://relay.example.test/v1#fragment',
    'https://127.0.0.1/v1',
    'https://localhost/v1',
    'https://relay.internal/v1',
  ])('rejects an unsafe provider URL without resolving it: %s', async (baseUrl) => {
    const deps = dependencies();

    await expect(probeProviderNetwork(baseUrl, deps)).resolves.toEqual({
      code: 'provider_base_url_invalid',
      dns: false,
      tcp: false,
      tls: false,
    });
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  it('treats a missing provider URL as a prerequisite without network use', async () => {
    const deps = dependencies();

    await expect(probeProviderNetwork(undefined, deps)).resolves.toEqual({
      code: 'provider_base_url_missing',
      dns: false,
      tcp: false,
      tls: false,
    });
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  it('returns a fixed DNS failure without leaking the resolver error', async () => {
    const deps = dependencies({
      resolve: vi.fn().mockRejectedValue(new Error('resolver exposed a private hostname')),
    });

    const result = await probeProviderNetwork('https://relay.example.test/v1', deps);

    expect(result).toEqual({
      code: 'provider_dns_failed',
      dns: false,
      tcp: false,
      tls: false,
    });
    expect(JSON.stringify(result)).not.toContain('hostname');
    expect(deps.connectTcp).not.toHaveBeenCalled();
  });

  it.each([
    ['0.0.0.0', 4],
    ['10.0.0.1', 4],
    ['100.64.0.1', 4],
    ['127.0.0.1', 4],
    ['169.254.0.1', 4],
    ['172.16.0.1', 4],
    ['192.0.2.1', 4],
    ['192.168.0.1', 4],
    ['198.18.0.1', 4],
    ['198.51.100.1', 4],
    ['203.0.113.1', 4],
    ['224.0.0.1', 4],
    ['255.255.255.255', 4],
    ['::', 6],
    ['::1', 6],
    ['::ffff:127.0.0.1', 6],
    ['100::1', 6],
    ['2001:db8::1', 6],
    ['fc00::1', 6],
    ['fe80::1', 6],
    ['ff02::1', 6],
  ] as const)('refuses a non-public DNS result without socket use: %s', async (address, family) => {
    const deps = dependencies({
      resolve: vi.fn().mockResolvedValue([{ address, family }]),
    });

    await expect(probeProviderNetwork('https://relay.example.test/v1', deps)).resolves.toEqual({
      code: 'provider_dns_not_public',
      dns: false,
      tcp: false,
      tls: false,
    });
    expect(deps.connectTcp).not.toHaveBeenCalled();
  });

  it('accepts a public IPv6 result for TCP and TLS validation', async () => {
    const deps = dependencies({
      resolve: vi.fn().mockResolvedValue([
        { address: '2606:4700:4700::1111', family: 6 },
      ]),
    });

    await expect(probeProviderNetwork('https://relay.example.test/v1', deps)).resolves.toEqual({
      code: 'provider_network_preflight_passed',
      dns: true,
      tcp: true,
      tls: true,
    });
    expect(deps.connectTcp).toHaveBeenCalledWith('2606:4700:4700::1111', 443, 6);
    expect(deps.connectTls).toHaveBeenCalledWith(
      '2606:4700:4700::1111',
      443,
      6,
      'relay.example.test',
    );
  });

  it('stops after a TCP failure', async () => {
    const deps = dependencies({
      connectTcp: vi.fn().mockRejectedValue(new Error('connection refused by 203.1.2.3')),
    });

    await expect(probeProviderNetwork('https://relay.example.test/v1', deps)).resolves.toEqual({
      code: 'provider_tcp_failed',
      dns: true,
      tcp: false,
      tls: false,
    });
    expect(deps.connectTls).not.toHaveBeenCalled();
  });

  it('distinguishes TLS or certificate validation failure from TCP reachability', async () => {
    const deps = dependencies({
      connectTls: vi.fn().mockRejectedValue(new Error('certificate contains a secret hostname')),
    });

    await expect(probeProviderNetwork('https://relay.example.test/v1', deps)).resolves.toEqual({
      code: 'provider_tls_failed',
      dns: true,
      tcp: true,
      tls: false,
    });
  });

  it('passes only after ordered DNS, TCP 443, and validated TLS checks', async () => {
    const calls: string[] = [];
    const deps = dependencies({
      resolve: vi.fn(async (hostname) => {
        calls.push(`dns:${hostname}`);
        return [{ address: '203.1.2.3', family: 4 as const }];
      }),
      connectTcp: vi.fn(async (address, port, family) => {
        calls.push(`tcp:${address}:${port}:${family}`);
      }),
      connectTls: vi.fn(async (address, port, family, servername) => {
        calls.push(`tls:${address}:${port}:${family}:${servername}`);
      }),
    });

    const result = await probeProviderNetwork('https://relay.example.test/v1/', deps);

    expect(result).toEqual({
      code: 'provider_network_preflight_passed',
      dns: true,
      tcp: true,
      tls: true,
    });
    expect(calls).toEqual([
      'dns:relay.example.test',
      'tcp:203.1.2.3:443:4',
      'tls:203.1.2.3:443:4:relay.example.test',
    ]);
    expect(PROVIDER_NETWORK_PREFLIGHT_CODES).toContain(result.code);
  });

  it('defaults to exit 2 before reading a URL or using the network', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_PROVIDER_NETWORK_PREFLIGHT;
    delete environment.OPENAI_BASE_URL;
    delete environment.OPENAI_API_KEY;
    delete environment.CODEX_API_KEY;
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/verify-provider-network.ts'],
      {
        cwd: resolve('.'),
        env: environment,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'provider-network-preflight: opt-in missing\n',
    );
  });

  it('requires the base URL after explicit opt-in without reading any key', () => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      DELIVERY_LOOP_PROVIDER_NETWORK_PREFLIGHT: '1',
    };
    delete environment.OPENAI_BASE_URL;
    delete environment.OPENAI_API_KEY;
    delete environment.CODEX_API_KEY;
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/verify-provider-network.ts'],
      {
        cwd: resolve('.'),
        env: environment,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'provider-network-preflight: prerequisite missing provider_base_url_missing\n',
    );
  });
});
