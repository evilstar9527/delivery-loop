import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  CLOUDFLARE_OBSERVABILITY_KEYCHAIN_SERVICE,
  CloudflareObservabilityCredentialProvisioningAuthorizationV1Schema,
  type CloudflareObservabilityCredentialProvisioningAuthorizationV1,
} from '../src/domain/cloudflare-observability-credential-provisioning.js';
import {
  CloudflareObservabilityCredentialProvisioningError,
  provisionCloudflareObservabilityCredential,
} from '../src/pilot/cloudflare-observability-credential-provisioner.js';
import { SecretScanner } from '../src/security/redaction.js';

const MAX_AUTHORITY_BYTES = 64 * 1_024;
const KEYCHAIN_TIMEOUT_MS = 30_000;
const KEYCHAIN_ACCOUNT = 'delivery-loop-transport-diagnostic';

class AuthorityReadError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid') { super(kind); }
}

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function readAuthority(
  path: string,
): Promise<CloudflareObservabilityCredentialProvisioningAuthorizationV1> {
  if (!isAbsolute(path)) throw new AuthorityReadError('invalid');
  const resolved = resolve(path);
  let repository: string;
  try { repository = await realpath(resolve('.')); }
  catch { throw new AuthorityReadError('unavailable'); }
  let handle;
  try { handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new AuthorityReadError('unavailable'); }
  try {
    let file: string;
    try { file = await realpath(resolved); }
    catch { throw new AuthorityReadError('unavailable'); }
    const fromRepository = relative(repository, file);
    if (
      fromRepository === '' ||
      (!fromRepository.startsWith('..') && !isAbsolute(fromRepository))
    ) throw new AuthorityReadError('invalid');
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || (metadata.mode & 0o077) !== 0 ||
      metadata.size < 1 || metadata.size > MAX_AUTHORITY_BYTES
    ) throw new AuthorityReadError('invalid');
    const source = await handle.readFile('utf8');
    if (
      Buffer.byteLength(source, 'utf8') > MAX_AUTHORITY_BYTES ||
      new SecretScanner().scanText(source, '$.authority').length > 0
    ) {
      throw new AuthorityReadError('invalid');
    }
    let raw: unknown;
    try { raw = JSON.parse(source) as unknown; }
    catch { throw new AuthorityReadError('invalid'); }
    const parsed = CloudflareObservabilityCredentialProvisioningAuthorizationV1Schema.safeParse(raw);
    if (!parsed.success) throw new AuthorityReadError('invalid');
    return parsed.data;
  } finally {
    await handle.close();
  }
}

async function storeMacosKeychainSecret(secret: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('unsupported platform');
  const helper = resolve('scripts/store-macos-keychain-secret.swift');
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('/usr/bin/swift', [helper], {
      shell: false,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        PATH: '/usr/bin:/bin',
      },
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolvePromise();
      else reject(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('keychain helper timeout'));
    }, KEYCHAIN_TIMEOUT_MS);
    child.once('error', () => { finish(new Error('keychain helper unavailable')); });
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) finish();
      else finish(new Error('keychain helper failed'));
    });
    child.stdin?.once('error', () => { finish(new Error('keychain helper stdin failed')); });
    child.stdin?.end(secret);
  });
}

async function assertMacosKeychainSlotAvailable(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('unsupported platform');
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('/usr/bin/security', [
      'find-generic-password',
      '-s',
      CLOUDFLARE_OBSERVABILITY_KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
    ], {
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        HOME: process.env.HOME ?? '',
        PATH: '/usr/bin:/bin',
      },
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolvePromise();
      else reject(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('keychain preflight timeout'));
    }, KEYCHAIN_TIMEOUT_MS);
    child.once('error', () => { finish(new Error('keychain preflight unavailable')); });
    child.once('exit', (code, signal) => {
      if (code === 44 && signal === null) finish();
      else finish(new Error('keychain slot is not available'));
    });
  });
}

async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_CLOUDFLARE_OBSERVABILITY_CREDENTIAL_PROVISIONING !== '1') {
    console.error('cloudflare-observability-credential-provisioning: opt-in missing');
    process.exitCode = 2;
    return;
  }
  const required = {
    authorityFile: env('CLOUDFLARE_OBSERVABILITY_CREDENTIAL_AUTHORITY_FILE'),
    bootstrapToken: env('CLOUDFLARE_OBSERVABILITY_CREDENTIAL_BOOTSTRAP_TOKEN'),
    accountId: env('CLOUDFLARE_OBSERVABILITY_CREDENTIAL_ACCOUNT_ID'),
    canary: env('CLOUDFLARE_OBSERVABILITY_CREDENTIAL_CANARY_SECRET'),
  };
  if (Object.values(required).some((value) => value === '')) {
    console.error(
      'cloudflare-observability-credential-provisioning: required configuration is incomplete',
    );
    process.exitCode = 2;
    return;
  }
  let authority: CloudflareObservabilityCredentialProvisioningAuthorizationV1;
  try { authority = await readAuthority(required.authorityFile); }
  catch (error) {
    const kind = error instanceof AuthorityReadError ? error.kind : 'invalid';
    console.error(`cloudflare-observability-credential-provisioning: authority is ${kind}`);
    process.exitCode = kind === 'unavailable' ? 2 : 1;
    return;
  }
  const cloudflareApiOrigin = env('CLOUDFLARE_OBSERVABILITY_CREDENTIAL_API_URL');
  try {
    const summary = await provisionCloudflareObservabilityCredential(authority, {
      bootstrapToken: required.bootstrapToken,
      cloudflareAccountId: required.accountId,
      canary: required.canary,
      assertStorageAvailable: assertMacosKeychainSlotAvailable,
      storeSecret: storeMacosKeychainSecret,
      ...(cloudflareApiOrigin === '' ? {} : { cloudflareApiOrigin }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    if (error instanceof CloudflareObservabilityCredentialProvisioningError) {
      const stage = error.stage === undefined ? '' : ` stage=${error.stage}`;
      console.error(
        `cloudflare-observability-credential-provisioning: FAIL ${error.code}${stage}`,
      );
    } else {
      console.error('cloudflare-observability-credential-provisioning: FAIL provisioning_failed');
    }
    process.exitCode = 1;
  }
}

await main();
