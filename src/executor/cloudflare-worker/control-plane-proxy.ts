export const CONTROL_PLANE_PROXY_ORIGIN = 'https://control.delivery-loop.internal';

interface ControlPlaneProxyEnv {
  EXECUTOR_CALLBACK_TOKEN?: string;
}

interface ControlPlaneProxyParams {
  controlPlaneOrigin: string;
  executionId: string;
  attemptId: string;
}

function validProxyParams(value: unknown): value is ControlPlaneProxyParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.controlPlaneOrigin === 'string' &&
    typeof record.executionId === 'string' &&
    typeof record.attemptId === 'string';
}

function allowedAttemptPath(pathname: string, attemptId: string): boolean {
  const prefix = `/v1/attempts/${encodeURIComponent(attemptId)}`;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function requiresExecutorCallback(
  url: URL,
  method: string,
  attemptId: string,
): boolean {
  const { pathname } = url;
  const prefix = `/v1/attempts/${encodeURIComponent(attemptId)}`;
  const publisherPrefix = `${prefix}/executor-publisher`;
  return pathname === `${prefix}/executor-exchange` ||
    (method === 'GET' && pathname.startsWith(`${prefix}/executor-patches/`)) ||
    ((method === 'GET' || method === 'POST') &&
      pathname.startsWith(`${publisherPrefix}/repository.git/`) &&
      !pathname.endsWith('/git-receive-pack') &&
      url.searchParams.get('service') !== 'git-receive-pack') ||
    (method === 'POST' && pathname.startsWith(`${publisherPrefix}/`) &&
      !pathname.startsWith(`${publisherPrefix}/repository.git/`));
}

/** Container egress PEP: callback only for identity operations; short grants otherwise survive. */
export async function proxyControlPlaneRequest(
  request: Request,
  rawEnv: unknown,
  context: { containerId: string; params?: unknown },
): Promise<Response> {
  const env = rawEnv as Partial<ControlPlaneProxyEnv>;
  if (!validProxyParams(context.params) || env.EXECUTOR_CALLBACK_TOKEN === undefined) {
    return new Response(null, { status: 503 });
  }
  const url = new URL(request.url);
  if (
    url.origin !== CONTROL_PLANE_PROXY_ORIGIN ||
    !allowedAttemptPath(url.pathname, context.params.attemptId) ||
    !['GET', 'POST', 'PUT'].includes(request.method)
  ) {
    return new Response(null, { status: 403 });
  }
  const headers = new Headers(request.headers);
  headers.delete('cookie');
  headers.delete('proxy-authorization');
  headers.delete('x-delivery-executor-container-id');
  headers.delete('x-delivery-execution-id');
  if (requiresExecutorCallback(url, request.method, context.params.attemptId)) {
    headers.set('authorization', `Bearer ${env.EXECUTOR_CALLBACK_TOKEN}`);
  }
  headers.set('x-delivery-executor-container-id', context.containerId);
  headers.set('x-delivery-execution-id', context.params.executionId);
  const target = new URL(`${url.pathname}${url.search}`, context.params.controlPlaneOrigin);
  return await fetch(new Request(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
  }));
}
