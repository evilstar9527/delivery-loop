/**
 * Tool call semantics adapted from Watt's tool-bridge SDK and gateway.
 * Source: Watt packages/toolbridge/vendor/tb/types.ts and
 * packages/core/src/authz/tool-action.ts at 476e3cdd2490d725fde174e7c697ebf00899edc6.
 */
export type ToolEffect = 'read' | 'write' | 'destructive' | 'external';

export interface TrustedToolSpec {
  path: string;
  scope: string;
  effect: ToolEffect;
}

const TRIAGE_TOOL_SPECS = [
  { path: 'repo/read', scope: 'repo:read', effect: 'read' },
  { path: 'logs/search', scope: 'logs:read', effect: 'read' },
  { path: 'traces/get', scope: 'trace:read', effect: 'read' },
  { path: 'k8s/diagnose', scope: 'k8s:read', effect: 'read' },
  { path: 'database/diagnose', scope: 'database:diagnostic', effect: 'read' },
] as const satisfies readonly TrustedToolSpec[];

export const TRIAGE_TOOL_ACTIONS: readonly string[] = Object.freeze(
  TRIAGE_TOOL_SPECS.map((spec) => spec.scope),
);

export const EXECUTION_TOOL_ACTIONS: readonly string[] = Object.freeze([
  ...TRIAGE_TOOL_ACTIONS,
  'checkpoint:write',
  'artifact:write',
]);

export function isExactTriageToolActions(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length === TRIAGE_TOOL_ACTIONS.length &&
    value.every((action, index) => action === TRIAGE_TOOL_ACTIONS[index]);
}

export function isExactExecutionToolActions(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length === EXECUTION_TOOL_ACTIONS.length &&
    value.every((action, index) => action === EXECUTION_TOOL_ACTIONS[index]);
}

const DENIED_TOOL_SPECS = [
  // Known upstream capabilities kept in the catalog so the PEP can audit an explicit deny.
  { path: 'repo/write', scope: 'repo:write', effect: 'write' },
  { path: 'k8s/apply', scope: 'k8s:write', effect: 'write' },
  { path: 'database/execute', scope: 'database:write', effect: 'destructive' },
  { path: 'shell/exec', scope: 'shell:exec', effect: 'destructive' },
] as const satisfies readonly TrustedToolSpec[];

const TRUSTED_TOOL_SPECS: readonly TrustedToolSpec[] = [
  ...TRIAGE_TOOL_SPECS,
  ...DENIED_TOOL_SPECS,
];

const TRUSTED_TOOL_CATALOG = new Map<string, TrustedToolSpec>(
  TRUSTED_TOOL_SPECS.map((spec) => [spec.path, spec]),
);

/** The request may select a path, but scope and effect always come from this catalog. */
export function trustedToolSpec(path: string): TrustedToolSpec | null {
  return TRUSTED_TOOL_CATALOG.get(path) ?? null;
}

/** Copied from Watt's single mapping point: an explicit scope is the policy action. */
export function toolActionFor(scope: string | undefined): string {
  return scope ? scope : 'invoke';
}

export const TOOL_CALL_RESULT_CATEGORIES = [
  'success',
  'policy_denied',
  'upstream_error',
  'timeout',
  'unavailable',
  'invalid_response',
] as const;

export type ToolCallResultCategory = (typeof TOOL_CALL_RESULT_CATEGORIES)[number];

export const MAX_TOOL_CALL_TRACE_DURATION_MS = 60_000;

export function boundedToolCallDuration(startedAt: number, completedAt: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return 0;
  return Math.min(
    MAX_TOOL_CALL_TRACE_DURATION_MS,
    Math.max(0, Math.floor(completedAt - startedAt)),
  );
}
