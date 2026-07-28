import { describe, expect, it } from 'vitest';
import {
  CloudflareD1ExportClient,
  D1ExportClientError,
} from '../src/backup/d1-export-client.js';

const ACCOUNT_ID = 'a'.repeat(32);
const DATABASE_ID = '11111111-2222-4333-8444-555555555555';
const API_TOKEN = 'backup-api-token-canary';

describe('Cloudflare D1 export adapter', () => {
  it('uses the official polling export contract without exposing credentials', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      new Response(JSON.stringify({
        success: true,
        result: { at_bookmark: '00000085-0000024c-backup' },
      }), { status: 200 }),
      new Response(JSON.stringify({
        success: true,
        result: {
          signed_url: 'https://backup.example.test/export.sql?signature=SIGNED_CANARY',
          filename: 'database.sql',
        },
      }), { status: 200 }),
      new Response('CREATE TABLE backup_fixture(id TEXT);', { status: 200 }),
    ];
    const client = new CloudflareD1ExportClient({
      accountId: ACCOUNT_ID,
      databaseId: DATABASE_ID,
      apiToken: API_TOKEN,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        const response = responses.shift();
        if (response === undefined) throw new Error('unexpected request');
        return response;
      },
    });

    const started = await client.start();
    expect(started).toEqual({ bookmark: '00000085-0000024c-backup' });
    const ready = await client.poll(started.bookmark);
    expect(ready).toEqual({
      signedUrl: 'https://backup.example.test/export.sql?signature=SIGNED_CANARY',
    });
    const download = await client.download(ready.signedUrl);
    expect(await new Response(download).text()).toBe('CREATE TABLE backup_fixture(id TEXT);');
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/export`,
    );
    expect(calls.slice(0, 2).map((call) => JSON.parse(String(call.init?.body)))).toEqual([
      { output_format: 'polling' },
      { current_bookmark: started.bookmark },
    ]);
    expect(calls.slice(0, 2).every((call) => new Headers(call.init?.headers).get('authorization') ===
      `Bearer ${API_TOKEN}`)).toBe(true);
    expect(calls[2]?.url).toBe(ready.signedUrl);
    expect(new Headers(calls[2]?.init?.headers).has('authorization')).toBe(false);
    expect(JSON.stringify(started)).not.toContain(API_TOKEN);
    expect(JSON.stringify(started)).not.toContain('SIGNED_CANARY');
  });

  it('fails closed on malformed IDs, non-HTTPS URLs, raw errors, and unfinished exports', async () => {
    expect(() => new CloudflareD1ExportClient({
      accountId: '../account',
      databaseId: DATABASE_ID,
      apiToken: API_TOKEN,
    })).toThrow('D1 backup configuration is invalid');

    for (const response of [
      new Response('RAW_PROVIDER_SECRET', { status: 500 }),
      new Response(JSON.stringify({ success: false, errors: [{ message: 'RAW_PROVIDER_SECRET' }] }), {
        status: 200,
      }),
      new Response(JSON.stringify({ success: true, result: {} }), { status: 200 }),
    ]) {
      const client = new CloudflareD1ExportClient({
        accountId: ACCOUNT_ID,
        databaseId: DATABASE_ID,
        apiToken: API_TOKEN,
        fetch: async () => response.clone(),
      });
      await expect(client.start()).rejects.toSatisfy((error: unknown) =>
        error instanceof D1ExportClientError && error.message === 'D1 export request failed');
      await expect(client.start()).rejects.not.toThrow('RAW_PROVIDER_SECRET');
    }

    const unfinished = new CloudflareD1ExportClient({
      accountId: ACCOUNT_ID,
      databaseId: DATABASE_ID,
      apiToken: API_TOKEN,
      fetch: async () => new Response(JSON.stringify({ success: true, result: {} }), { status: 200 }),
    });
    await expect(unfinished.poll('00000085-0000024c-backup'))
      .rejects.toMatchObject({ code: 'not_ready' });

    const insecure = new CloudflareD1ExportClient({
      accountId: ACCOUNT_ID,
      databaseId: DATABASE_ID,
      apiToken: API_TOKEN,
      fetch: async () => new Response(JSON.stringify({
        success: true,
        result: { signed_url: 'http://backup.example.test/export.sql?signature=secret' },
      }), { status: 200 }),
    });
    await expect(insecure.poll('00000085-0000024c-backup'))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });
});
