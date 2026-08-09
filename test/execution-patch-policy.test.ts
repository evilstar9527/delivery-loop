import { describe, expect, it } from 'vitest';
import {
  MAX_PATCH_EDIT_TEXT_BYTES,
  MAX_PATCH_EDIT_TOTAL_BYTES,
  MAX_PATCH_FILE_BYTES,
  MAX_PATCH_TOTAL_BYTES,
  PatchProposalV1Schema,
  PatchProposalV2Schema,
} from '../src/domain/patch-proposal.js';
import {
  ExecutionPatchPolicyError,
  validateExecutionPatchProposal,
} from '../src/runner/execution-patch-policy.js';

function proposal(path: string, content: string) {
  return {
    schemaVersion: '1' as const,
    changes: [{ path, baseDigest: null, content }],
  };
}

describe('execution patch proposal policy', () => {
  it('accepts a bounded regular source proposal without changing it', () => {
    const input = proposal('src/value.ts', 'export const value = 1;\n');
    expect(validateExecutionPatchProposal(
      input,
      ['delivery.yaml', '.github/workflows/**', 'CODEOWNERS'],
      ['RUNTIME_SECRET_VALUE'],
    )).toEqual(input);
  });

  it.each([
    ['protected path', proposal('.github/workflows/unsafe.yml', 'name: unsafe\n')],
    ['registered runtime Secret', proposal('src/value.ts', 'RUNTIME_SECRET_VALUE\n')],
    ['credential-shaped content', proposal(
      'src/value.ts',
      `Bearer ${'a'.repeat(24)}\n`,
    )],
  ])('rejects %s before filesystem application', (_name, input) => {
    expect(() => validateExecutionPatchProposal(
      input,
      ['delivery.yaml', '.github/workflows/**', 'CODEOWNERS'],
      ['RUNTIME_SECRET_VALUE'],
    )).toThrow(ExecutionPatchPolicyError);
  });

  it('rejects invalid Unicode and per-file/total byte overflow in the strict schema', () => {
    expect(PatchProposalV1Schema.safeParse(proposal('src/value.ts', '\ud800')).success).toBe(false);
    expect(PatchProposalV1Schema.safeParse(
      proposal('src/value.ts', '字'.repeat(Math.ceil(MAX_PATCH_FILE_BYTES / 3) + 1)),
    ).success).toBe(false);
    expect(PatchProposalV1Schema.safeParse({
      schemaVersion: '1',
      changes: [
        { path: 'a.txt', baseDigest: null, content: 'a'.repeat(MAX_PATCH_FILE_BYTES) },
        { path: 'b.txt', baseDigest: null, content: 'b'.repeat(MAX_PATCH_FILE_BYTES) },
        { path: 'c.txt', baseDigest: null, content: 'c' },
      ],
    }).success).toBe(false);
    expect(MAX_PATCH_FILE_BYTES).toBe(128 * 1_024);
    expect(MAX_PATCH_TOTAL_BYTES).toBe(256 * 1_024);
  });

  it('accepts the two real-sized replacement files within the independent limits', () => {
    expect(PatchProposalV1Schema.safeParse({
      schemaVersion: '1',
      changes: [
        { path: 'src/storage/task-query-store.ts', baseDigest: null, content: 'a'.repeat(72_529) },
        { path: 'test/workflow/task-query-api.test.ts', baseDigest: null, content: 'b'.repeat(15_271) },
      ],
    }).success).toBe(true);
  });

  it('accepts a bounded V2 edit and rejects unsafe or oversized edits', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const input = {
      schemaVersion: '2' as const,
      changes: [{
        path: 'src/storage/task-query-store.ts',
        baseDigest: digest,
        edits: [{ oldText: 'const before = true;\n', newText: 'const before = false;\n' }],
      }],
    };
    expect(validateExecutionPatchProposal(
      input,
      ['delivery.yaml', '.github/workflows/**', 'CODEOWNERS'],
      ['RUNTIME_SECRET_VALUE'],
    )).toEqual(input);
    expect(() => validateExecutionPatchProposal({
      ...input,
      changes: [{ ...input.changes[0]!, edits: [{
        oldText: 'const before = true;\n',
        newText: 'RUNTIME_SECRET_VALUE',
      }] }],
    }, [], ['RUNTIME_SECRET_VALUE'])).toThrow(ExecutionPatchPolicyError);
    expect(PatchProposalV2Schema.safeParse({
      ...input,
      changes: [{ ...input.changes[0]!, edits: [{ oldText: 'same', newText: 'same' }] }],
    }).success).toBe(false);
    expect(PatchProposalV2Schema.safeParse({
      ...input,
      changes: [{ ...input.changes[0]!, edits: [{
        oldText: 'a'.repeat(MAX_PATCH_EDIT_TEXT_BYTES + 1),
        newText: 'b',
      }] }],
    }).success).toBe(false);
    expect(PatchProposalV2Schema.safeParse({
      schemaVersion: '2',
      changes: Array.from({ length: 5 }, (_, index) => ({
        path: `${index}.ts`,
        baseDigest: digest,
        edits: [{
          oldText: 'a'.repeat(MAX_PATCH_EDIT_TEXT_BYTES),
          newText: 'b'.repeat(MAX_PATCH_EDIT_TEXT_BYTES),
        }],
      })),
    }).success).toBe(false);
    expect(MAX_PATCH_EDIT_TOTAL_BYTES).toBe(128 * 1_024);
  });
});
