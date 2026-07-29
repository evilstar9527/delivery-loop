import { describe, expect, it } from 'vitest';
import { normalizeCloudflareWorkflowStepName } from
  '../src/pilot/cloudflare-workflow-step.js';

describe('Cloudflare Workflow platform step names', () => {
  it('normalizes only the exact stable title and bounded platform attempt suffix', () => {
    const expected = 'dispatch-analysis-attempt';
    expect(normalizeCloudflareWorkflowStepName(expected, expected)).toBe(expected);
    expect(normalizeCloudflareWorkflowStepName(`${expected}-1`, expected)).toBe(expected);
    expect(normalizeCloudflareWorkflowStepName(`${expected}-20`, expected)).toBe(expected);
    for (const value of [
      `${expected}-0`, `${expected}-01`, `${expected}-21`, `${expected}-retry`,
      `other-${expected}-1`, null,
    ]) expect(normalizeCloudflareWorkflowStepName(value, expected)).toBeNull();
  });
});
