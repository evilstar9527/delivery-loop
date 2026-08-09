import { z } from 'zod';

export const MAX_PATCH_CHANGES = 8;
export const MAX_PATCH_PATH_BYTES = 240;
// The proposal body is read only from Codex --output-last-message. Its duplicate
// JSONL agent-message is replaced before any 64 KiB parser or transcript sink.
export const MAX_PATCH_FILE_BYTES = 128 * 1_024;
export const MAX_PATCH_TOTAL_BYTES = 256 * 1_024;
export const MAX_PATCH_EDITS_PER_FILE = 16;
export const MAX_PATCH_EDIT_TEXT_BYTES = 32 * 1_024;
export const MAX_PATCH_EDIT_TOTAL_BYTES = 128 * 1_024;

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

const PatchEditV2Schema = z.object({
  oldText: z.string().min(1),
  newText: z.string(),
}).strict().superRefine((edit, context) => {
  const oldBytes = encoder.encode(edit.oldText).length;
  const newBytes = encoder.encode(edit.newText).length;
  if (!patchContentIsUtf8(edit.oldText) || !patchContentIsUtf8(edit.newText)) {
    context.addIssue({ code: 'custom', message: 'patch edit text is not UTF-8' });
  }
  if (oldBytes > MAX_PATCH_EDIT_TEXT_BYTES || newBytes > MAX_PATCH_EDIT_TEXT_BYTES) {
    context.addIssue({ code: 'custom', message: 'patch edit text is oversized' });
  }
  if (edit.oldText === edit.newText) {
    context.addIssue({ code: 'custom', message: 'patch edit must change content' });
  }
});

const PatchChangeV2Schema = z.object({
  path: z.string().min(1).max(MAX_PATCH_PATH_BYTES),
  baseDigest: z.string().regex(DIGEST_PATTERN),
  edits: z.array(PatchEditV2Schema).min(1).max(MAX_PATCH_EDITS_PER_FILE),
}).strict().superRefine((change, context) => {
  if (!patchPathIsSafe(change.path)) {
    context.addIssue({ code: 'custom', path: ['path'], message: 'patch path is invalid' });
  }
});

export const PatchProposalV2Schema = z.object({
  schemaVersion: z.literal('2'),
  changes: z.array(PatchChangeV2Schema).min(1).max(MAX_PATCH_CHANGES),
}).strict().superRefine((proposal, context) => {
  let previous = '';
  let totalBytes = 0;
  for (const [changeIndex, change] of proposal.changes.entries()) {
    if (changeIndex > 0 && change.path <= previous) {
      context.addIssue({
        code: 'custom',
        path: ['changes', changeIndex, 'path'],
        message: 'patch paths must be unique and sorted',
      });
    }
    previous = change.path;
    for (const edit of change.edits) {
      totalBytes += encoder.encode(edit.oldText).length + encoder.encode(edit.newText).length;
    }
  }
  if (totalBytes > MAX_PATCH_EDIT_TOTAL_BYTES) {
    context.addIssue({ code: 'custom', path: ['changes'], message: 'patch edits are oversized' });
  }
});

export const PatchProposalSchema = z.discriminatedUnion('schemaVersion', [
  PatchProposalV1Schema,
  PatchProposalV2Schema,
]);

export type PatchProposalV2 = z.infer<typeof PatchProposalV2Schema>;
export type PatchProposal = z.infer<typeof PatchProposalSchema>;

export async function patchContentDigest(content: string): Promise<string> {
  if (!patchContentIsUtf8(content)) throw new Error('patch content is not UTF-8');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(content));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}
