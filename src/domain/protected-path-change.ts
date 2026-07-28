import { z } from 'zod';
import { canonicalSha256 } from './digest.js';

const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function safeRepositoryPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 500 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    ![...path].some((character) => character.charCodeAt(0) < 32) &&
    !path.split('/').includes('..')
  );
}

const repositoryPath = z.string().min(1).max(500).refine(safeRepositoryPath);

export const BUILT_IN_PROTECTED_PATH_PATTERNS = [
  'delivery.yaml',
  '.github/workflows/**',
  'CODEOWNERS',
  '**/CODEOWNERS',
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '.dev.vars',
  '.dev.vars.*',
  '**/.dev.vars',
  '**/.dev.vars.*',
  'secrets.yml',
  'secrets.yaml',
  '**/secrets.yml',
  '**/secrets.yaml',
  '.secrets/**',
  '**/.secrets/**',
  'wrangler.json',
  'wrangler.jsonc',
  'wrangler.toml',
  '**/wrangler.json',
  '**/wrangler.jsonc',
  '**/wrangler.toml',
  'Dockerfile',
  '**/Dockerfile',
  'docker-compose*.yml',
  'docker-compose*.yaml',
  '**/docker-compose*.yml',
  '**/docker-compose*.yaml',
  'k8s/**',
  'kubernetes/**',
  'helm/**',
  'charts/**',
  'deploy/**',
  'deployment/**',
  'infra/**',
  'terraform/**',
  '*.tf',
  '*.tfvars',
  '**/*.tf',
  '**/*.tfvars',
] as const;

export const ProtectedPathChangeTypeSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type_changed',
  'unmerged',
]);

const lineCount = z.number().int().nonnegative().nullable();

export const ProtectedPathChangeV1Schema = z
  .object({
    path: repositoryPath,
    previousPath: repositoryPath.optional(),
    changeType: ProtectedPathChangeTypeSchema,
    additions: lineCount,
    deletions: lineCount,
  })
  .strict()
  .superRefine((change, context) => {
    const needsPreviousPath = change.changeType === 'renamed' || change.changeType === 'copied';
    if (needsPreviousPath !== (change.previousPath !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['previousPath'],
        message: 'previousPath must be present only for rename/copy changes',
      });
    }
  });

export const ProtectedPathChangeReportV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    baseSha: z.string().regex(SHA1_PATTERN),
    stagedTreeSha: z.string().regex(SHA1_PATTERN),
    policyDigest: z.string().regex(DIGEST_PATTERN),
    diffDigest: z.string().regex(DIGEST_PATTERN),
    totalChangedFiles: z.number().int().positive().max(10_000),
    protectedChanges: z.array(ProtectedPathChangeV1Schema).min(1).max(200),
  })
  .strict()
  .superRefine((report, context) => {
    const identities = report.protectedChanges.map(
      (change) => `${change.changeType}\0${change.previousPath ?? ''}\0${change.path}`,
    );
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: 'custom',
        path: ['protectedChanges'],
        message: 'protected path changes must be unique',
      });
    }
  });

export type ProtectedPathChangeType = z.infer<typeof ProtectedPathChangeTypeSchema>;
export type ProtectedPathChangeV1 = z.infer<typeof ProtectedPathChangeV1Schema>;
export type ProtectedPathChangeReportV1 = z.infer<typeof ProtectedPathChangeReportV1Schema>;

function escapeRegularExpression(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

/** Small, anchored git-style matcher for the safe protectedPaths contract. */
export function protectedPathPatternMatches(pattern: string, path: string): boolean {
  if (
    !safeRepositoryPath(path) ||
    pattern.length < 1 ||
    pattern.length > 300 ||
    pattern.startsWith('/') ||
    pattern.startsWith('!') ||
    pattern.includes('\\') ||
    pattern.split('/').includes('..')
  ) {
    return false;
  }
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      const followedBySlash = pattern[index + 2] === '/';
      source += followedBySlash ? '(?:.*/)?' : '.*';
      index += followedBySlash ? 2 : 1;
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += escapeRegularExpression(character);
    }
  }
  return new RegExp(`${source}$`, 'u').test(path);
}

export function isProtectedRepositoryPath(
  path: string,
  policyPatterns: readonly string[],
): boolean {
  return [...BUILT_IN_PROTECTED_PATH_PATTERNS, ...policyPatterns].some(
    (pattern) => protectedPathPatternMatches(pattern, path),
  );
}

/** Binds an approval to the exact base and staged tree without persisting file contents. */
export async function computeProtectedPathDiffDigest(
  baseSha: string,
  stagedTreeSha: string,
): Promise<string> {
  if (!SHA1_PATTERN.test(baseSha) || !SHA1_PATTERN.test(stagedTreeSha)) {
    throw new Error('protected path diff identity is invalid');
  }
  return await canonicalSha256({ schemaVersion: '1', baseSha, stagedTreeSha });
}
