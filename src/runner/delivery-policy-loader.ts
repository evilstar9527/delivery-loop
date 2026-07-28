import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import {
  MAX_DELIVERY_POLICY_BYTES,
  parseDeliveryPolicy,
  type DeliveryPolicyV1,
} from '../domain/delivery-policy.js';

const BASE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const DELIVERY_POLICY_PATH = 'delivery.yaml';

export interface LoadedDeliveryPolicy {
  policy: DeliveryPolicyV1;
  digest: string;
  baseSha: string;
  path: typeof DELIVERY_POLICY_PATH;
}

export class DeliveryPolicySourceError extends Error {
  constructor() {
    super('delivery policy source is invalid');
    this.name = 'DeliveryPolicySourceError';
  }
}

async function readPolicyBlob(repositoryPath: string, baseSha: string): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      ['show', `${baseSha}:${DELIVERY_POLICY_PATH}`],
      {
        cwd: repositoryPath,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: MAX_DELIVERY_POLICY_BYTES + 1,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(new DeliveryPolicySourceError());
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

/** Loads only the delivery.yaml blob committed at the already trusted dispatch base SHA. */
export async function loadDeliveryPolicyAtCommit(
  repositoryPath: string,
  baseSha: string,
): Promise<LoadedDeliveryPolicy> {
  if (!isAbsolute(repositoryPath) || !BASE_SHA_PATTERN.test(baseSha)) {
    throw new DeliveryPolicySourceError();
  }
  let parsed;
  try {
    parsed = await parseDeliveryPolicy(await readPolicyBlob(resolve(repositoryPath), baseSha));
  } catch {
    throw new DeliveryPolicySourceError();
  }
  return {
    ...parsed,
    baseSha,
    path: DELIVERY_POLICY_PATH,
  };
}
