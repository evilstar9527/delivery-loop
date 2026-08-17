import { canonicalSha256 } from '../../domain/digest.js';

const SANDBOX_ID_PREFIX = 'executor-';
const MAX_SANDBOX_ID_LENGTH = 63;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;

export async function sandboxIdFor(executionId: string): Promise<string> {
  const digest = await canonicalSha256(executionId);
  return `${SANDBOX_ID_PREFIX}${digest.slice(
    'sha256:'.length,
    'sha256:'.length + MAX_SANDBOX_ID_LENGTH - SANDBOX_ID_PREFIX.length,
  )}`;
}

/**
 * ContainerProxy receives the Durable Object identity in its immutable props;
 * the provider placement UUID is only a liveness fact and cannot be reproduced
 * by the callback isolate. Freeze the identity that both isolates can prove.
 */
export function providerContainerIdentity(
  durableObjectId: string,
  placementId: string | null | undefined,
): string {
  if (
    !CONTAINER_ID_PATTERN.test(durableObjectId) ||
    typeof placementId !== 'string' || placementId.length === 0
  ) throw new Error('container placement unavailable');
  return durableObjectId;
}
