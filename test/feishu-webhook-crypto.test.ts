import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeFeishuSignature,
  constantTimeEqual,
  decryptFeishuPayload,
  verifyFeishuSignature,
} from '../src/feishu/webhook-crypto.js';
import {
  extractFeishuChallenge,
  verifyAndExtractFeishuWebhook,
} from '../src/feishu/webhook-verifier.js';

// Copied from Watt plugin-feishu@476e3cd: use node:crypto as an independent
// oracle for the Web Crypto implementation used by the Worker.
function oracleSignature(timestamp: string, nonce: string, key: string, body: string): string {
  return createHash('sha256').update(`${timestamp}${nonce}${key}${body}`).digest('hex');
}

function oracleEncrypt(plaintext: string, key: string): string {
  const keyBytes = createHash('sha256').update(key).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', keyBytes, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ciphertext]).toString('base64');
}

describe('Feishu webhook crypto copied from Watt', () => {
  it('matches the official plain SHA-256 signature oracle', async () => {
    const timestamp = '1700000000';
    const nonce = 'nonce-1';
    const key = 'feishu-encrypt-key';
    const body = '{"encrypt":"ciphertext"}';
    const expected = oracleSignature(timestamp, nonce, key, body);
    expect(await computeFeishuSignature(timestamp, nonce, key, body)).toBe(expected);
    await expect(verifyFeishuSignature({ timestamp, nonce, body, signature: expected }, key))
      .resolves.toBe(true);
    await expect(verifyFeishuSignature({
      timestamp,
      nonce,
      body: `${body} `,
      signature: expected,
    }, key)).resolves.toBe(false);
  });

  it('decrypts Watt-compatible AES-256-CBC payloads and rejects a wrong key', async () => {
    const key = 'feishu-encrypt-key';
    const plaintext = JSON.stringify({
      header: { event_id: 'event-1', tenant_key: 'tenant-1' },
      event: { message: { content: '{"text":"hello"}' } },
    });
    const encrypted = oracleEncrypt(plaintext, key);
    await expect(decryptFeishuPayload(encrypted, key)).resolves.toBe(plaintext);
    await expect(decryptFeishuPayload(encrypted, 'wrong-key')).rejects.toThrow();
  });

  it('uses a constant-time comparison for equal-length signature and token material', () => {
    expect(constantTimeEqual('abcdef', 'abcdef')).toBe(true);
    expect(constantTimeEqual('abcdef', 'abcdeg')).toBe(false);
    expect(constantTimeEqual('abcdef', 'abc')).toBe(false);
  });
});

describe('Feishu webhook source verification', () => {
  it('accepts a token-bound plaintext challenge and rejects an unconfigured verifier', async () => {
    const body = JSON.stringify({
      type: 'url_verification',
      challenge: 'challenge-1',
      token: 'verification-token',
    });
    const accepted = await verifyAndExtractFeishuWebhook(
      { headers: {}, body },
      { verificationToken: 'verification-token', now: () => 1_700_000_000 },
    );
    expect(accepted).toMatchObject({ ok: true, mode: 'plaintext' });
    if (accepted.ok) expect(extractFeishuChallenge(accepted.payload)).toBe('challenge-1');

    await expect(verifyAndExtractFeishuWebhook(
      { headers: {}, body },
      { now: () => 1_700_000_000 },
    )).resolves.toEqual({ ok: false, code: 'configuration_invalid' });
  });
});
