const OIDC_AUDIENCE = 'delivery-loop-test-deploy';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SUCCESS_MARKER = '{"event":"cross_repository_oidc_probe","outcome":"rejected"}';
const FAILURE_MARKER = '{"event":"cross_repository_oidc_probe","outcome":"failed"}';

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error('probe configuration is incomplete');
  }
  return value;
}

function controlPlaneOrigin(raw) {
  let url;
  try { url = new globalThis.URL(raw); } catch { throw new Error('control plane URL is invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new Error('control plane URL is invalid');
  return url.origin;
}

async function jsonResponse(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('probe response is invalid');
  }
  const text = await response.text();
  if (new globalThis.TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
    throw new Error('probe response is invalid');
  }
  try { return JSON.parse(text); } catch { throw new Error('probe response is invalid'); }
}

async function oidcToken() {
  const requestUrl = new globalThis.URL(required('ACTIONS_ID_TOKEN_REQUEST_URL'));
  if (requestUrl.protocol !== 'https:' || requestUrl.username !== '' || requestUrl.password !== '') {
    throw new Error('GitHub OIDC URL is invalid');
  }
  requestUrl.searchParams.set('audience', OIDC_AUDIENCE);
  const response = await globalThis.fetch(requestUrl, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${required('ACTIONS_ID_TOKEN_REQUEST_TOKEN')}`,
    },
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) throw new Error('GitHub OIDC request failed');
  const body = await jsonResponse(response);
  if (
    typeof body !== 'object' || body === null || Array.isArray(body) ||
    Object.keys(body).length !== 1 || typeof body.value !== 'string' ||
    body.value.length < 1 || body.value.length > 20_000 || /[\0\r\n]/.test(body.value)
  ) throw new Error('GitHub OIDC response is invalid');
  return body.value;
}

async function main() {
  const deploymentId = required('DELIVERY_CROSS_REPO_TARGET_DEPLOYMENT_ID');
  if (!ID_PATTERN.test(deploymentId)) throw new Error('target deployment ID is invalid');
  const origin = controlPlaneOrigin(required('DELIVERY_CONTROL_PLANE_URL'));
  const token = await oidcToken();
  const response = await globalThis.fetch(
    `${origin}/v1/test-deployments/${deploymentId}/oidc-attestation`,
    {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(10_000),
    },
  );
  const body = await jsonResponse(response);
  if (
    response.status !== 403 || typeof body !== 'object' || body === null || Array.isArray(body) ||
    body.code !== 'policy_denied' || body.retryable !== false
  ) throw new Error('cross-repository OIDC binding was not rejected');
  process.stdout.write(`${SUCCESS_MARKER}\n`);
}

try {
  await main();
} catch {
  process.stderr.write(`${FAILURE_MARKER}\n`);
  process.exitCode = 1;
}
import process from 'node:process';
