import { z } from 'zod';
import { SecretScanner, type SecretScannerOptions } from '../security/redaction.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMAND_REF_PATTERN = /^(?:test|verify):[A-Za-z0-9_-]{1,64}$/;
export const MAX_PULL_REQUEST_BODY_BYTES = 65_536;

const SourceSchema = z.object({
  system: z.string().min(1).max(100),
  tenantKey: z.string().min(1).max(200),
  taskKey: z.string().min(1).max(300),
  revision: z.string().min(1).max(300),
  url: z.url().max(2_000).optional(),
  title: z.string().min(1).max(1_000),
}).strict();

const PlanSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  version: z.number().int().positive(),
  digest: z.string().regex(DIGEST_PATTERN),
  objective: z.string().min(1).max(5_000),
}).strict();

const ItemSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  title: z.string().min(1).max(1_000),
}).strict();

const AcceptanceCriterionSchema = z.object({
  index: z.number().int().nonnegative().max(999),
  text: z.string().min(1).max(5_000),
  status: z.enum(['passed', 'failed', 'pending']),
  evidenceIds: z.array(z.string().regex(ID_PATTERN)).max(200),
}).strict();

const TestEvidenceSchema = z.object({
  evidenceId: z.string().regex(ID_PATTERN),
  commandRef: z.string().regex(COMMAND_REF_PATTERN),
  exitCode: z.number().int().min(0).max(255),
  durationMs: z.number().int().min(0).max(3_600_000),
  headSha: z.string().regex(SHA_PATTERN),
}).strict();

const UnfinishedItemSchema = ItemSchema.extend({
  status: z.enum(['pending', 'ready', 'in_progress', 'failed', 'blocked', 'skipped']),
}).strict();

export const PullRequestDraftBodyInputSchema = z.object({
  source: SourceSchema,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  plan: PlanSchema,
  head: z.object({
    branch: z.string().min(1).max(240),
    sha: z.string().regex(SHA_PATTERN),
  }).strict(),
  completedItems: z.array(ItemSchema).min(1).max(200),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(100),
  risks: z.array(z.string().min(1).max(2_000)).min(1).max(50),
  tests: z.array(TestEvidenceSchema).min(1).max(100),
  unfinishedItems: z.array(UnfinishedItemSchema).max(200),
  rollback: z.string().min(1).max(2_000),
}).strict().superRefine((input, context) => {
  const unique = (values: readonly string[], path: (string | number)[]): void => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', path, message: 'entries must be unique' });
    }
  };
  unique(input.completedItems.map((item) => item.id), ['completedItems']);
  unique(input.acceptanceCriteria.map((criterion) => String(criterion.index)), ['acceptanceCriteria']);
  unique(input.tests.map((test) => test.evidenceId), ['tests']);
  unique(input.unfinishedItems.map((item) => item.id), ['unfinishedItems']);
});

export type PullRequestDraftBodyInput = z.infer<typeof PullRequestDraftBodyInputSchema>;
export type PullRequestDraftErrorCode = 'invalid_input' | 'secret_detected' | 'body_too_large';

export class PullRequestDraftError extends Error {
  constructor(readonly code: PullRequestDraftErrorCode) {
    super(`Pull Request draft rendering failed: ${code}`);
    this.name = 'PullRequestDraftError';
  }
}

const MARKDOWN_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '@': '&#64;',
  '[': '&#91;',
  ']': '&#93;',
  '(': '&#40;',
  ')': '&#41;',
  '`': '&#96;',
  '*': '&#42;',
  '_': '&#95;',
  '#': '&#35;',
  '!': '&#33;',
  '|': '&#124;',
  '\\': '&#92;',
};

function safeText(value: string): string {
  const normalized = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return [...normalized].map((character) => MARKDOWN_ENTITIES[character] ?? character).join('');
}

function sourceUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== ''
  ) return undefined;
  url.search = '';
  url.hash = '';
  return url.toString().replaceAll('(', '%28').replaceAll(')', '%29');
}

function checked(status: PullRequestDraftBodyInput['acceptanceCriteria'][number]['status']): string {
  return status === 'passed' ? 'x' : ' ';
}

/** Deterministic public Markdown; all natural-language fields are rendered as inert text. */
export function renderPullRequestDraftBody(
  rawInput: unknown,
  scannerOptions: SecretScannerOptions = {},
): string {
  const parsed = PullRequestDraftBodyInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new PullRequestDraftError('invalid_input');
  const input = parsed.data;
  const scanner = new SecretScanner(scannerOptions);
  if (scanner.scan(input).length > 0) throw new PullRequestDraftError('secret_detected');
  const taskUrl = sourceUrl(input.source.url);
  const lines = [
    '# Delivery Loop Draft PR',
    '',
    '> Generated from durable Task, Plan, Git head, and verified Evidence snapshots.',
    '',
    '## Source task',
    '',
    `- Task: \`${safeText(input.source.system)}/${safeText(input.source.tenantKey)}/${safeText(input.source.taskKey)}\``,
    `- Revision: \`${safeText(input.source.revision)}\``,
    `- Title: ${safeText(input.source.title)}`,
    ...(taskUrl === undefined ? [] : [`- Source: [Open source task](${taskUrl})`]),
    `- Repository: \`${input.repository}\``,
    `- Plan: \`${input.plan.id}\` v${input.plan.version} (\`${input.plan.digest}\`)`,
    '',
    '## Change summary',
    '',
    `- Objective: ${safeText(input.plan.objective)}`,
    `- Head: \`${input.head.sha}\` on \`${safeText(input.head.branch)}\``,
    ...input.completedItems.map((item) => `- Completed \`${item.id}\`: ${safeText(item.title)}`),
    '',
    '## Acceptance criteria',
    '',
    ...input.acceptanceCriteria.flatMap((criterion) => [
      `- [${checked(criterion.status)}] AC ${criterion.index + 1}: ${safeText(criterion.text)} — **${criterion.status}**`,
      `  - Evidence: ${criterion.evidenceIds.map((id) => `\`${id}\``).join(', ')}`,
    ]),
    '',
    '## Risks',
    '',
    ...input.risks.map((risk) => `- ${safeText(risk)}`),
    '',
    '## Test evidence',
    '',
    ...input.tests.map((test) =>
      `- \`${test.commandRef}\` — exit \`${test.exitCode}\`, \`${test.durationMs} ms\`, head \`${test.headSha}\`, Evidence \`${test.evidenceId}\``),
    '',
    '## Unfinished items',
    '',
    ...(input.unfinishedItems.length === 0
      ? ['- None.']
      : input.unfinishedItems.map((item) =>
        `- \`${item.id}\` — **${item.status}**: ${safeText(item.title)}`)),
    '',
    '## Rollback',
    '',
    `- ${safeText(input.rollback)}`,
    '',
  ];
  const body = lines.join('\n');
  if (new TextEncoder().encode(body).length > MAX_PULL_REQUEST_BODY_BYTES) {
    throw new PullRequestDraftError('body_too_large');
  }
  if (scanner.scanText(body).length > 0) throw new PullRequestDraftError('secret_detected');
  return body;
}
