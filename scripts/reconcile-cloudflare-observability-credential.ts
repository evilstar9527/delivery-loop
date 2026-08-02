import {
  CloudflareObservabilityCredentialReconciliationAuthorizationV1Schema,
  type CloudflareObservabilityCredentialReconciliationAuthorizationV1,
} from '../src/domain/cloudflare-observability-credential-reconciliation.js';
import {
  CloudflareObservabilityCredentialReconciliationError,
  reconcileCloudflareObservabilityCredential,
} from '../src/pilot/cloudflare-observability-credential-reconciler.js';
import {
  StrictAuthorityReadError,
  readStrictExternalAuthority,
} from './read-strict-external-authority.js';

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION !== '1') {
    console.error('cloudflare-observability-credential-reconciliation: opt-in missing');
    process.exitCode = 2;
    return;
  }
  const required = {
    authorityFile: env('CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION_AUTHORITY_FILE'),
    bootstrapToken: env('CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION_BOOTSTRAP_TOKEN'),
    accountId: env('CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION_ACCOUNT_ID'),
    canary: env('CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION_CANARY_SECRET'),
  };
  if (Object.values(required).some((value) => value === '')) {
    console.error(
      'cloudflare-observability-credential-reconciliation: required configuration is incomplete',
    );
    process.exitCode = 2;
    return;
  }
  let authority: CloudflareObservabilityCredentialReconciliationAuthorizationV1;
  try {
    authority = await readStrictExternalAuthority(
      required.authorityFile,
      CloudflareObservabilityCredentialReconciliationAuthorizationV1Schema,
    );
  }
  catch (error) {
    const kind = error instanceof StrictAuthorityReadError ? error.kind : 'invalid';
    console.error(`cloudflare-observability-credential-reconciliation: authority is ${kind}`);
    process.exitCode = kind === 'unavailable' ? 2 : 1;
    return;
  }
  const cloudflareApiOrigin =
    env('CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION_API_URL');
  try {
    const summary = await reconcileCloudflareObservabilityCredential(authority, {
      bootstrapToken: required.bootstrapToken,
      cloudflareAccountId: required.accountId,
      canary: required.canary,
      ...(cloudflareApiOrigin === '' ? {} : { cloudflareApiOrigin }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof CloudflareObservabilityCredentialReconciliationError
      ? error.code
      : 'reconciliation_failed';
    console.error(`cloudflare-observability-credential-reconciliation: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
