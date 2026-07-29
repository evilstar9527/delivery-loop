const MAX_PLATFORM_STEP_ATTEMPTS = 20;

export function normalizeCloudflareWorkflowStepName(
  value: unknown,
  expected: string,
): string | null {
  if (value === expected) return expected;
  if (typeof value !== 'string' || !value.startsWith(`${expected}-`)) return null;
  const suffix = value.slice(expected.length + 1);
  if (!/^[1-9][0-9]*$/.test(suffix)) return null;
  const attempt = Number(suffix);
  return Number.isSafeInteger(attempt) && attempt <= MAX_PLATFORM_STEP_ATTEMPTS
    ? expected : null;
}
