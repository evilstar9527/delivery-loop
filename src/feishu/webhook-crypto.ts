/**
 * Feishu event signature/decryption primitives.
 *
 * Copied from Watt packages/plugin-feishu/src/adapter/crypto.ts at commit
 * 476e3cdd2490d725fde174e7c697ebf00899edc6. The algorithm is intentionally
 * unchanged: SHA-256(timestamp + nonce + encryptKey + exact body), followed by
 * AES-256-CBC with SHA-256(encryptKey) and the first 16 ciphertext bytes as IV.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

/** Constant-time comparison for equal-length signature or token material. */
export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function computeFeishuSignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  body: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${timestamp}${nonce}${encryptKey}${body}`),
  );
  return toHex(digest);
}

export async function verifyFeishuSignature(
  input: { timestamp: string; nonce: string; body: string; signature: string },
  encryptKey: string,
): Promise<boolean> {
  const expected = await computeFeishuSignature(
    input.timestamp,
    input.nonce,
    encryptKey,
    input.body,
  );
  return constantTimeEqual(expected, input.signature);
}

export async function decryptFeishuPayload(
  encrypted: string,
  encryptKey: string,
): Promise<string> {
  const keyBytes = await crypto.subtle.digest('SHA-256', encoder.encode(encryptKey));
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
  const bytes = base64ToBytes(encrypted);
  if (bytes.length <= 16) throw new Error('feishu ciphertext is too short');
  const initializationVector = bytes.slice(0, 16);
  const ciphertext = bytes.slice(16);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: initializationVector },
    key,
    ciphertext,
  );
  return decoder.decode(plaintext);
}
