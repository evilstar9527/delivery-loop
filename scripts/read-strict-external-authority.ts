import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { SecretScanner } from '../src/security/redaction.js';

const MAX_AUTHORITY_BYTES = 64 * 1_024;

interface StrictSchema<T> {
  safeParse: (value: unknown) =>
    | { success: true; data: T }
    | { success: false };
}

export class StrictAuthorityReadError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid') { super(kind); }
}

export async function readStrictExternalAuthority<T>(
  path: string,
  schema: StrictSchema<T>,
): Promise<T> {
  if (!isAbsolute(path)) throw new StrictAuthorityReadError('invalid');
  const resolved = resolve(path);
  let repository: string;
  try { repository = await realpath(resolve('.')); }
  catch { throw new StrictAuthorityReadError('unavailable'); }
  let handle;
  try { handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new StrictAuthorityReadError('unavailable'); }
  try {
    let file: string;
    try { file = await realpath(resolved); }
    catch { throw new StrictAuthorityReadError('unavailable'); }
    const fromRepository = relative(repository, file);
    if (
      fromRepository === '' ||
      (!fromRepository.startsWith('..') && !isAbsolute(fromRepository))
    ) throw new StrictAuthorityReadError('invalid');
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || (metadata.mode & 0o077) !== 0 ||
      metadata.size < 1 || metadata.size > MAX_AUTHORITY_BYTES
    ) throw new StrictAuthorityReadError('invalid');
    const source = await handle.readFile('utf8');
    if (
      Buffer.byteLength(source, 'utf8') > MAX_AUTHORITY_BYTES ||
      new SecretScanner().scanText(source, '$.authority').length > 0
    ) throw new StrictAuthorityReadError('invalid');
    let raw: unknown;
    try { raw = JSON.parse(source) as unknown; }
    catch { throw new StrictAuthorityReadError('invalid'); }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new StrictAuthorityReadError('invalid');
    return parsed.data;
  } finally {
    await handle.close();
  }
}
