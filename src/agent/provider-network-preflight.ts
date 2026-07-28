import { lookup } from 'node:dns';
import { BlockList, createConnection, isIP } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { parseProviderBaseUrl } from './provider-base-url.js';

const NETWORK_TIMEOUT_MS = 10_000;
const MAX_RESOLVED_ADDRESSES = 4;

export const PROVIDER_NETWORK_PREFLIGHT_CODES = [
  'provider_network_preflight_passed',
  'provider_base_url_missing',
  'provider_base_url_invalid',
  'provider_dns_failed',
  'provider_dns_not_public',
  'provider_tcp_failed',
  'provider_tls_failed',
  'provider_network_probe_failed',
] as const;

export type ProviderNetworkPreflightCode =
  typeof PROVIDER_NETWORK_PREFLIGHT_CODES[number];

export interface ProviderResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface ProviderNetworkPreflightResult {
  readonly code: ProviderNetworkPreflightCode;
  readonly dns: boolean;
  readonly tcp: boolean;
  readonly tls: boolean;
}

export interface ProviderNetworkProbeDependencies {
  resolve(hostname: string): Promise<readonly ProviderResolvedAddress[]>;
  connectTcp(address: string, port: number, family: 4 | 6): Promise<void>;
  connectTls(
    address: string,
    port: number,
    family: 4 | 6,
    servername: string,
  ): Promise<void>;
}

const nonPublicAddresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, 'ipv6');
}

function fixedResult(
  code: ProviderNetworkPreflightCode,
  dns = false,
  tcp = false,
  tls = false,
): ProviderNetworkPreflightResult {
  return { code, dns, tcp, tls };
}

function publicAddress(candidate: ProviderResolvedAddress): boolean {
  if (isIP(candidate.address) !== candidate.family) return false;
  if (candidate.family === 6 && candidate.address.toLowerCase().startsWith('::ffff:')) {
    return false;
  }
  return !nonPublicAddresses.check(
    candidate.address,
    candidate.family === 4 ? 'ipv4' : 'ipv6',
  );
}

function resolveProvider(hostname: string): Promise<readonly ProviderResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('provider_dns_timeout'));
    }, NETWORK_TIMEOUT_MS);
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== null) {
        reject(new Error('provider_dns_failed'));
        return;
      }
      resolve(addresses.map(({ address, family }) => ({
        address,
        family: family === 6 ? 6 : 4,
      })));
    });
  });
}

function tcpConnect(address: string, port: number, family: 4 | 6): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: address, port, family });
    let settled = false;
    const finish = (passed: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (passed) resolve();
      else reject(new Error('provider_tcp_failed'));
    };
    socket.setTimeout(NETWORK_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function tlsConnect(
  address: string,
  port: number,
  _family: 4 | 6,
  servername: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectTls({
      host: address,
      port,
      servername,
      rejectUnauthorized: true,
    });
    let settled = false;
    const finish = (passed: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (passed) resolve();
      else reject(new Error('provider_tls_failed'));
    };
    socket.setTimeout(NETWORK_TIMEOUT_MS);
    socket.once('secureConnect', () => finish(socket.authorized));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

const DEFAULT_DEPENDENCIES: ProviderNetworkProbeDependencies = {
  resolve: resolveProvider,
  connectTcp: tcpConnect,
  connectTls: tlsConnect,
};

/** Performs no HTTP or model request and returns only fixed codes and booleans. */
export async function probeProviderNetwork(
  rawBaseUrl: string | undefined,
  dependencies: ProviderNetworkProbeDependencies = DEFAULT_DEPENDENCIES,
): Promise<ProviderNetworkPreflightResult> {
  if (rawBaseUrl === undefined) return fixedResult('provider_base_url_missing');

  let endpoint;
  try {
    endpoint = parseProviderBaseUrl(rawBaseUrl);
  } catch {
    return fixedResult('provider_base_url_invalid');
  }

  let resolved: readonly ProviderResolvedAddress[];
  try {
    resolved = await dependencies.resolve(endpoint.hostname);
  } catch {
    return fixedResult('provider_dns_failed');
  }

  const publicAddresses = [...new Map(
    resolved
      .filter(publicAddress)
      .map((candidate) => [`${candidate.family}:${candidate.address}`, candidate]),
  ).values()].slice(0, MAX_RESOLVED_ADDRESSES);
  if (publicAddresses.length === 0) {
    return fixedResult('provider_dns_not_public');
  }

  const tcpResults = await Promise.all(publicAddresses.map(async (candidate) => {
    try {
      await dependencies.connectTcp(candidate.address, endpoint.port, candidate.family);
      return candidate;
    } catch {
      return undefined;
    }
  }));
  const tcpAddresses = tcpResults.filter(
    (candidate): candidate is ProviderResolvedAddress => candidate !== undefined,
  );
  if (tcpAddresses.length === 0) return fixedResult('provider_tcp_failed', true);

  const tlsResults = await Promise.all(tcpAddresses.map(async (candidate) => {
    try {
      await dependencies.connectTls(
        candidate.address,
        endpoint.port,
        candidate.family,
        endpoint.hostname,
      );
      return true;
    } catch {
      return false;
    }
  }));
  if (!tlsResults.includes(true)) return fixedResult('provider_tls_failed', true, true);

  return fixedResult('provider_network_preflight_passed', true, true, true);
}
