const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const DATABASE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BOOKMARK_PATTERN = /^[A-Za-z0-9_-]{1,500}$/;
const MAX_RESPONSE_BYTES = 64 * 1_024;

export type D1ExportClientErrorCode =
  | 'request_failed'
  | 'invalid_response'
  | 'not_ready';

export class D1ExportClientError extends Error {
  constructor(readonly code: D1ExportClientErrorCode) {
    super(code === 'not_ready' ? 'D1 export is not ready' : 'D1 export request failed');
    this.name = 'D1ExportClientError';
  }
}

export interface CloudflareD1ExportClientOptions {
  accountId: string;
  databaseId: string;
  apiToken: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

interface ExportEnvelope {
  success: boolean;
  result: Record<string, unknown>;
}

function safeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('D1 backup configuration is invalid');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      url.search !== '' || url.hash !== '') {
    throw new Error('D1 backup configuration is invalid');
  }
  return url.toString().replace(/\/$/, '');
}

function safeSignedUrl(raw: string): string {
  if (raw.length > 8_192) throw new D1ExportClientError('invalid_response');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new D1ExportClientError('invalid_response');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new D1ExportClientError('invalid_response');
  }
  return url.toString();
}

/** Minimal adapter for Cloudflare's official polling D1 export endpoint. */
export class CloudflareD1ExportClient {
  private readonly endpoint: string;
  private readonly apiToken: string;
  private readonly fetch: typeof fetch;

  constructor(options: CloudflareD1ExportClientOptions) {
    if (
      !ACCOUNT_ID_PATTERN.test(options.accountId) ||
      !DATABASE_ID_PATTERN.test(options.databaseId) ||
      options.apiToken.length < 1 ||
      options.apiToken.length > 4_096 ||
      /[\0\r\n]/.test(options.apiToken)
    ) throw new Error('D1 backup configuration is invalid');
    const baseUrl = safeBaseUrl(options.apiBaseUrl ?? 'https://api.cloudflare.com');
    this.endpoint =
      `${baseUrl}/client/v4/accounts/${options.accountId}/d1/database/${options.databaseId}/export`;
    this.apiToken = options.apiToken;
    this.fetch = options.fetch ?? fetch;
  }

  async start(): Promise<{ bookmark: string }> {
    const envelope = await this.request({ output_format: 'polling' });
    const bookmark = envelope.result.at_bookmark;
    if (typeof bookmark !== 'string' || !BOOKMARK_PATTERN.test(bookmark)) {
      throw new D1ExportClientError('invalid_response');
    }
    return { bookmark };
  }

  async poll(bookmark: string): Promise<{ signedUrl: string }> {
    if (!BOOKMARK_PATTERN.test(bookmark)) throw new D1ExportClientError('invalid_response');
    const envelope = await this.request({ current_bookmark: bookmark });
    const signedUrl = envelope.result.signed_url;
    if (signedUrl === undefined || signedUrl === null) {
      throw new D1ExportClientError('not_ready');
    }
    if (typeof signedUrl !== 'string' || signedUrl.length > 8_192) {
      throw new D1ExportClientError('invalid_response');
    }
    return { signedUrl: safeSignedUrl(signedUrl) };
  }

  async download(rawSignedUrl: string): Promise<ReadableStream<Uint8Array>> {
    const signedUrl = safeSignedUrl(rawSignedUrl);
    let response: Response;
    try {
      response = await this.fetch(signedUrl, { method: 'GET', redirect: 'error' });
    } catch {
      throw new D1ExportClientError('request_failed');
    }
    if (!response.ok || response.body === null) {
      throw new D1ExportClientError('request_failed');
    }
    return response.body;
  }

  private async request(payload: Record<string, string>): Promise<ExportEnvelope> {
    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new D1ExportClientError('request_failed');
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new D1ExportClientError('request_failed');
    }
    if (!response.ok || new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new D1ExportClientError('request_failed');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new D1ExportClientError('invalid_response');
    }
    if (
      typeof raw !== 'object' || raw === null ||
      (raw as { success?: unknown }).success !== true ||
      typeof (raw as { result?: unknown }).result !== 'object' ||
      (raw as { result?: unknown }).result === null ||
      Array.isArray((raw as { result?: unknown }).result)
    ) throw new D1ExportClientError('invalid_response');
    return {
      success: true,
      result: (raw as { result: Record<string, unknown> }).result,
    };
  }
}
