/**
 * Exact-body HMAC-SHA256 verifier copied from Watt commit
 * 476e3cdd2490d725fde174e7c697ebf00899edc6
 * (`packages/core/src/eventbus/hmac.ts`), with only the product header name
 * adapted for delivery-loop monitor adapters.
 */

export const MONITOR_HMAC = {
  prefix: 'sha256=',
  signatureHeader: 'x-delivery-loop-monitor-signature',
} as const;

export type MonitorBodyBytes = string | Uint8Array;

function toBytes(body: MonitorBodyBytes): Uint8Array<ArrayBuffer> {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy;
}

function toHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const output = new Uint8Array(hex.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    const pair = hex.slice(index * 2, index * 2 + 2);
    const byte = Number.parseInt(pair, 16);
    if (Number.isNaN(byte) || !/^[0-9a-f]{2}$/.test(pair)) return null;
    output[index] = byte;
  }
  return output;
}

async function hmacBytes(secret: string, body: MonitorBodyBytes): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, toBytes(body)));
}

export function monitorTimingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export async function computeMonitorSignature(
  secret: string,
  body: MonitorBodyBytes,
): Promise<string> {
  return `${MONITOR_HMAC.prefix}${toHex(await hmacBytes(secret, body))}`;
}

export async function verifyMonitorSignature(
  secret: string,
  body: MonitorBodyBytes,
  headerValue: string,
): Promise<boolean> {
  if (!headerValue.startsWith(MONITOR_HMAC.prefix)) return false;
  const provided = hexToBytes(headerValue.slice(MONITOR_HMAC.prefix.length));
  if (provided === null) return false;
  return monitorTimingSafeEqual(provided, await hmacBytes(secret, body));
}
