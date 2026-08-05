import { z } from 'zod';

export const MAX_PATCH_CHANGES = 8;
export const MAX_PATCH_PATH_BYTES = 240;
// Codex JSONL repeats the structured final message inside an agent-message string.
// Keep worst-case JSON escaping below the shared 64 KiB stdout-line boundary.
export const MAX_PATCH_FILE_BYTES = 12 * 1_024;
export const MAX_PATCH_TOTAL_BYTES = 12 * 1_024;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function patchPathIsSafe(path: string): boolean {
  if (
    path.length === 0 ||
    encoder.encode(path).length > MAX_PATCH_PATH_BYTES ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    [...path].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) return false;
  const segments = path.split('/');
  return segments.every((segment) =>
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    segment.toLowerCase() !== '.git',
  );
}

export function patchContentIsUtf8(content: string): boolean {
  try {
    return decoder.decode(encoder.encode(content)) === content &&
      ![...content].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint === 0 ||
          (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
          codePoint === 0x7f;
      });
  } catch {
    return false;
  }
}

const PatchChangeV1Schema = z.object({
  path: z.string().min(1).max(MAX_PATCH_PATH_BYTES),
  baseDigest: z.string().regex(DIGEST_PATTERN).nullable(),
  content: z.string(),
}).strict().superRefine((change, context) => {
  if (!patchPathIsSafe(change.path)) {
    context.addIssue({ code: 'custom', path: ['path'], message: 'patch path is invalid' });
  }
  if (!patchContentIsUtf8(change.content)) {
    context.addIssue({ code: 'custom', path: ['content'], message: 'patch content is not UTF-8' });
  }
  if (encoder.encode(change.content).length > MAX_PATCH_FILE_BYTES) {
    context.addIssue({ code: 'custom', path: ['content'], message: 'patch content is oversized' });
  }
});

export const PatchProposalV1Schema = z.object({
  schemaVersion: z.literal('1'),
  changes: z.array(PatchChangeV1Schema).min(1).max(MAX_PATCH_CHANGES),
}).strict().superRefine((proposal, context) => {
  let previous = '';
  let totalBytes = 0;
  for (const [index, change] of proposal.changes.entries()) {
    totalBytes += encoder.encode(change.content).length;
    if (index > 0 && change.path <= previous) {
      context.addIssue({
        code: 'custom',
        path: ['changes', index, 'path'],
        message: 'patch paths must be unique and sorted',
      });
    }
    previous = change.path;
  }
  if (totalBytes > MAX_PATCH_TOTAL_BYTES) {
    context.addIssue({ code: 'custom', path: ['changes'], message: 'patch proposal is oversized' });
  }
});

export type PatchProposalV1 = z.infer<typeof PatchProposalV1Schema>;

export async function patchContentDigest(content: string): Promise<string> {
  if (!patchContentIsUtf8(content)) throw new Error('patch content is not UTF-8');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(content));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}
