import { spawn } from 'node:child_process';
import {
  CLOUDFLARE_OBSERVABILITY_KEYCHAIN_ACCOUNT,
  CloudflareObservabilityCredentialVerificationAuthorizationV1Schema,
  type CloudflareObservabilityCredentialVerificationAuthorizationV1,
} from '../src/domain/cloudflare-observability-credential-verification.js';
import { CLOUDFLARE_OBSERVABILITY_KEYCHAIN_SERVICE } from '../src/domain/cloudflare-observability-credential-provisioning.js';
import {
  CloudflareObservabilityCredentialVerificationError,
  verifyExistingCloudflareObservabilityCredential,
} from '../src/pilot/cloudflare-observability-credential-verifier.js';
import {
  StrictAuthorityReadError,
  readStrictExternalAuthority,
} from './read-strict-external-authority.js';

const KEYCHAIN_TIMEOUT_MS = 30_000;
const MAX_CREDENTIAL_BYTES = 2_000;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function readMacosKeychainCredential(): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('unsupported platform');
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn('/usr/bin/security', [
      'find-generic-password',
      '-w',
      '-s',
      CLOUDFLARE_OBSERVABILITY_KEYCHAIN_SERVICE,
      '-a',
      CLOUDFLARE_OBSERVABILITY_KEYCHAIN_ACCOUNT,
    ], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        HOME: process.env.HOME ?? '',
        PATH: '/usr/bin:/bin',
      },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        reject(error);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
      if (raw === '' || /[\0\r\n]/.test(raw)) {
        reject(new Error('keychain credential is invalid'));
      } else {
        resolvePromise(raw);
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('keychain read timeout'));
    }, KEYCHAIN_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_CREDENTIAL_BYTES) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', () => { finish(new Error('keychain read unavailable')); });
    child.once('exit', (code, signal) => {
      if (!overflow && code === 0 && signal === null) finish();
      else finish(new Error('keychain read failed'));
    });
  });
}

async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_CLOUDFLARE_OBSERVABILITY_CREDENTIAL_VERIFICATION !== '1') {
    console.error('cloudflare-observability-credential-verification: opt-in missing');
    process.exitCode = 2;
    return;
  }
  const required = {
    authorityFile: env('CLOUDFLARE_OBSERVABILITY_CREDENTIAL_VERIFICATION_AUTHORITY_FILE'),
    accountId: env('CLOUDFLARE_OBSERVABILITY_CREDENTIAL_VERIFICATION_ACCOUNT_ID'),
    canary: env('CLOUDFLARE_OBSERVABILITY_CREDENTIAL_VERIFICATION_CANARY_SECRET'),
  };
  if (Object.values(required).some((value) => value === '')) {
    console.error(
      'cloudflare-observability-credential-verification: required configuration is incomplete',
    );
    process.exitCode = 2;
    return;
  }
  let authority: CloudflareObservabilityCredentialVerificationAuthorizationV1;
  try {
    authority = await readStrictExternalAuthority(
      required.authorityFile,
      CloudflareObservabilityCredentialVerificationAuthorizationV1Schema,
    );
  } catch (error) {
    const kind = error instanceof StrictAuthorityReadError ? error.kind : 'invalid';
    console.error(`cloudflare-observability-credential-verification: authority is ${kind}`);
    process.exitCode = kind === 'unavailable' ? 2 : 1;
    return;
  }
  let credential: string;
  try {
    credential = await readMacosKeychainCredential();
  } catch {
    console.error('cloudflare-observability-credential-verification: FAIL keychain_unavailable');
    process.exitCode = 1;
    return;
  }
  const cloudflareApiOrigin = env('CLOUDFLARE_OBSERVABILITY_CREDENTIAL_VERIFICATION_API_URL');
  try {
    const summary = await verifyExistingCloudflareObservabilityCredential(authority, {
      credential,
      cloudflareAccountId: required.accountId,
      canary: required.canary,
      ...(cloudflareApiOrigin === '' ? {} : { cloudflareApiOrigin }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    if (error instanceof CloudflareObservabilityCredentialVerificationError) {
      const stage = error.stage === undefined ? '' : ` stage=${error.stage}`;
      const failureKind = error.failureKind === undefined
        ? ''
        : ` failureKind=${error.failureKind}`;
      console.error(
        `cloudflare-observability-credential-verification: FAIL ${error.code}` +
          `${stage}${failureKind}`,
      );
    } else {
      console.error('cloudflare-observability-credential-verification: FAIL verification_failed');
    }
    process.exitCode = 1;
  }
}

await main();
