import { z } from 'zod';
import { canonicalSha256, sha256Bytes } from './digest.js';
import {
  DIAGNOSTIC_LOCATOR_KINDS,
  DiagnosticRootCauseV1Schema,
} from './diagnostic-evidence.js';
import { PlanItemV1Schema } from './plan.js';

const nonBlank = (maximum: number): z.ZodString =>
  z.string().min(1).max(maximum).refine((value) => /\S/.test(value), 'must not be blank');

/** Agent-controlled content only; trusted Plan identity/envelope is added server-side. */
export const AnalysisPlanContentV1Schema = z
  .object({
    objective: nonBlank(4_000),
    assumptions: z.array(nonBlank(1_000)).max(100),
    evidenceRefs: z.array(nonBlank(500)).max(200),
    items: z.array(PlanItemV1Schema).min(1).max(200),
  })
  .strict();

export type AnalysisPlanContentV1 = z.infer<typeof AnalysisPlanContentV1Schema>;

const CONTEXT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/**
 * Ephemeral Runner-owned file envelope. Only `context` contains the untrusted
 * Task/Plan policy payload; the marker is computed before the Agent starts.
 */
export const AnalysisContextFileV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    contextDigest: z.string().regex(CONTEXT_DIGEST_PATTERN),
    context: z.json(),
  })
  .strict();

export type AnalysisContextFileV1 = z.infer<typeof AnalysisContextFileV1Schema>;

export async function computeAnalysisContextDigest(context: unknown): Promise<string> {
  const jsonContext = z.json().parse(context);
  return await sha256Bytes(new TextEncoder().encode(JSON.stringify(jsonContext)));
}

export async function createAnalysisContextFileV1(
  context: unknown,
): Promise<AnalysisContextFileV1> {
  const jsonContext = z.json().parse(context);
  return {
    schemaVersion: '1',
    contextDigest: await computeAnalysisContextDigest(jsonContext),
    context: jsonContext,
  };
}

/**
 * Ephemeral provider-wire output. `contextDigest` is a compatibility field only:
 * the Runner ignores its value, verifies its own context file before/after the
 * invocation, and never persists the field in ExecutionPlan.
 */
export const AnalysisAgentOutputV1Schema = z
  .object({
    contextDigest: z.string().regex(CONTEXT_DIGEST_PATTERN),
    plan: AnalysisPlanContentV1Schema,
  })
  .strict();

export type AnalysisAgentOutputV1 = z.infer<typeof AnalysisAgentOutputV1Schema>;

const TOOL_ARGUMENT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

const DiagnosticToolArgumentsSchema = z
  .record(z.string().regex(TOOL_ARGUMENT_KEY_PATTERN), z.json())
  .refine((value) => Object.keys(value).length <= 50, 'too many tool arguments');

export const DiagnosticLogSearchRequestV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    locatorKinds: z.array(z.enum(DIAGNOSTIC_LOCATOR_KINDS)).min(1).max(3),
    arguments: DiagnosticToolArgumentsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.locatorKinds).size !== value.locatorKinds.length ||
      value.locatorKinds.some(
        (kind, index) =>
          index > 0 &&
          DIAGNOSTIC_LOCATOR_KINDS.indexOf(kind) <=
            DIAGNOSTIC_LOCATOR_KINDS.indexOf(value.locatorKinds[index - 1]!),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'diagnostic locator kinds must be unique and ordered',
      });
    }
  });

export const DiagnosticTraceRequestV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    arguments: DiagnosticToolArgumentsSchema,
  })
  .strict();

export const DiagnosticRootCauseResultV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    contextDigest: z.string().regex(CONTEXT_DIGEST_PATTERN),
    rootCause: DiagnosticRootCauseV1Schema,
  })
  .strict();

export type DiagnosticLogSearchRequestV1 = z.infer<
  typeof DiagnosticLogSearchRequestV1Schema
>;
export type DiagnosticTraceRequestV1 = z.infer<typeof DiagnosticTraceRequestV1Schema>;
export type DiagnosticRootCauseResultV1 = z.infer<typeof DiagnosticRootCauseResultV1Schema>;

const DiagnosticLogSearchAgentOutputV1Schema = z.object({
  schemaVersion: z.literal('1'),
  locatorKinds: z.array(z.enum(DIAGNOSTIC_LOCATOR_KINDS)).min(1).max(3),
  arguments: z.object({
    uid: z.string().max(500),
    cid: z.string().max(500),
    path: z.string().max(500),
  }).strict(),
}).strict().superRefine((value, context) => {
  const selected = new Set(value.locatorKinds);
  if (
    selected.size !== value.locatorKinds.length ||
    value.locatorKinds.some((kind, index) =>
      index > 0 && DIAGNOSTIC_LOCATOR_KINDS.indexOf(kind) <=
        DIAGNOSTIC_LOCATOR_KINDS.indexOf(value.locatorKinds[index - 1]!)) ||
    DIAGNOSTIC_LOCATOR_KINDS.some((kind) =>
      selected.has(kind) ? !/\S/.test(value.arguments[kind]) : value.arguments[kind] !== '')
  ) {
    context.addIssue({
      code: 'custom',
      message: 'diagnostic locator arguments must match the selected locator kinds',
    });
  }
});

const DiagnosticTraceAgentOutputV1Schema = z.object({
  schemaVersion: z.literal('1'),
  arguments: z.object({
    requestId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
  }).strict(),
}).strict();

const DiagnosticRootCauseAgentOutputV1Schema = z.object({
  schemaVersion: z.literal('1'),
  contextDigest: z.string().regex(CONTEXT_DIGEST_PATTERN),
  rootCause: z.object({
    summary: nonBlank(2_000),
    confidence: z.enum(['low', 'medium', 'high']),
    codeRefs: z.array(z.object({
      path: z.string().min(1).max(500),
      line: z.number().int().min(0).max(10_000_000),
      symbol: z.string().max(300),
    }).strict()).min(1).max(50),
  }).strict(),
}).strict();

export function parseDiagnosticLogSearchAgentOutput(
  raw: unknown,
): DiagnosticLogSearchRequestV1 {
  const output = DiagnosticLogSearchAgentOutputV1Schema.parse(raw);
  return DiagnosticLogSearchRequestV1Schema.parse({
    schemaVersion: output.schemaVersion,
    locatorKinds: output.locatorKinds,
    arguments: Object.fromEntries(
      output.locatorKinds.map((kind) => [kind, output.arguments[kind]]),
    ),
  });
}

export function parseDiagnosticTraceAgentOutput(raw: unknown): DiagnosticTraceRequestV1 {
  return DiagnosticTraceRequestV1Schema.parse(
    DiagnosticTraceAgentOutputV1Schema.parse(raw),
  );
}

export function parseDiagnosticRootCauseAgentOutput(
  raw: unknown,
): DiagnosticRootCauseResultV1 {
  const output = DiagnosticRootCauseAgentOutputV1Schema.parse(raw);
  return DiagnosticRootCauseResultV1Schema.parse({
    ...output,
    rootCause: {
      ...output.rootCause,
      codeRefs: output.rootCause.codeRefs.map((ref) => ({
        path: ref.path,
        ...(ref.line === 0 ? {} : { line: ref.line }),
        ...(ref.symbol === '' ? {} : { symbol: ref.symbol }),
      })),
    },
  });
}

export const DIAGNOSTIC_EVIDENCE_REF_PATTERN = /^d1:\/\/evidence\/diagnostic_[A-Za-z0-9_-]+$/;

const diagnosticCodeRefJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'line', 'symbol'],
  properties: {
    path: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
    },
    line: { type: 'integer', minimum: 0, maximum: 10_000_000 },
    symbol: { type: 'string', maxLength: 300 },
  },
} as const;

const diagnosticToolArgumentsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['uid', 'cid', 'path'],
  properties: {
    uid: { type: 'string', maxLength: 500 },
    cid: { type: 'string', maxLength: 500 },
    path: { type: 'string', maxLength: 500 },
  },
} as const;

export const DIAGNOSTIC_LOG_SEARCH_REQUEST_V1_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'locatorKinds', 'arguments'],
  properties: {
    schemaVersion: { type: 'string', enum: ['1'] },
    locatorKinds: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: { enum: DIAGNOSTIC_LOCATOR_KINDS },
    },
    arguments: diagnosticToolArgumentsJsonSchema,
  },
} as const;

export const DIAGNOSTIC_TRACE_REQUEST_V1_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'arguments'],
  properties: {
    schemaVersion: { type: 'string', enum: ['1'] },
    arguments: {
      type: 'object',
      additionalProperties: false,
      required: ['requestId'],
      properties: {
        requestId: {
          type: 'string', minLength: 1, maxLength: 200,
          pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$',
        },
      },
    },
  },
} as const;

// `const`, `uniqueItems`, regex lookahead, open objects and optional object
// properties are outside the relay's portable structured-output subset.
// Runtime Zod schemas remain the trusted boundary for locator/item uniqueness,
// non-blank checks, ordering, and cross-field plan validation.
const analysisPlanContentV1JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['objective', 'assumptions', 'evidenceRefs', 'items'],
  properties: {
    objective: { type: 'string', minLength: 1, maxLength: 4_000 },
    assumptions: {
      type: 'array',
      maxItems: 100,
      items: { type: 'string', minLength: 1, maxLength: 1_000 },
    },
    evidenceRefs: {
      type: 'array',
      maxItems: 200,
      items: { type: 'string', minLength: 1, maxLength: 500 },
    },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'kind',
          'title',
          'objective',
          'acceptanceCriteriaIndexes',
          'doneWhen',
          'verification',
          'effects',
          'dependsOn',
          'required',
        ],
        properties: {
          id: {
            type: 'string', minLength: 1, maxLength: 64,
            pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',
          },
          kind: { enum: ['investigation', 'change', 'verification', 'delivery'] },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          objective: { type: 'string', minLength: 1, maxLength: 2_000 },
          acceptanceCriteriaIndexes: {
            type: 'array', maxItems: 100,
            items: { type: 'integer', minimum: 0 },
          },
          doneWhen: {
            type: 'array', minItems: 1, maxItems: 50,
            items: { type: 'string', minLength: 1, maxLength: 1_000 },
          },
          verification: {
            type: 'object',
            additionalProperties: false,
            required: ['commandRefs', 'evidenceKinds', 'externalFacts'],
            properties: {
              commandRefs: {
                type: 'array', maxItems: 50,
                items: { type: 'string', minLength: 1, maxLength: 200 },
              },
              evidenceKinds: {
                type: 'array', minItems: 1,
                items: {
                  enum: [
                    'diagnostic', 'plan', 'test', 'lint', 'build', 'commit',
                    'pull_request', 'check', 'deployment', 'approval',
                  ],
                },
              },
              externalFacts: {
                type: 'array',
                items: { enum: ['github_pr', 'github_check', 'deployment'] },
              },
            },
          },
          effects: {
            type: 'array',
            items: {
              enum: [
                'repo_read', 'logs_read', 'database_diagnostic', 'repo_write',
                'test_deploy', 'merge', 'production_deploy',
              ],
            },
          },
          dependsOn: {
            type: 'array', maxItems: 200,
            items: { type: 'string', minLength: 1, maxLength: 64 },
          },
          required: { type: 'boolean' },
        },
      },
    },
  },
} as const;

export const ANALYSIS_AGENT_OUTPUT_V1_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['contextDigest', 'plan'],
  properties: {
    contextDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    plan: analysisPlanContentV1JsonSchema,
  },
} as const;

export const DIAGNOSTIC_ROOT_CAUSE_RESULT_V1_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'contextDigest', 'rootCause'],
  properties: {
    schemaVersion: { type: 'string', enum: ['1'] },
    contextDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    rootCause: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'confidence', 'codeRefs'],
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 2_000 },
        confidence: { enum: ['low', 'medium', 'high'] },
        codeRefs: {
          type: 'array', minItems: 1, maxItems: 50,
          items: diagnosticCodeRefJsonSchema,
        },
      },
    },
  },
} as const;

/** Stable trusted identity shared by the Runner and control-plane persistence path. */
export async function deriveAnalysisPlanId(
  runId: string,
  attemptId: string,
  version: number,
): Promise<string> {
  const digest = await canonicalSha256({ runId, attemptId, version });
  return `plan_${digest.slice('sha256:'.length, 'sha256:'.length + 56)}`;
}
