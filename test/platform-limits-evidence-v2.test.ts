import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PlatformLimitsEvidenceManifestV1Schema,
  PlatformLimitsEvidenceManifestV2Schema,
} from
  '../src/domain/platform-limits-evidence.js';

function userManifest(): Record<string, unknown> {
  const legacy = JSON.parse(readFileSync(
    new URL('../schemas/platform-limits-evidence-v1.example.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>;
  const github = legacy.github as Record<string, unknown>;
  const organizationPolicy = github.organizationPolicy as Record<string, unknown>;
  const concurrencyProbe = github.concurrencyProbe as Record<string, unknown>;
  const {
    reviewedOrganizationLimit,
    ...accountConcurrencyProbe
  } = concurrencyProbe;
  const billing = github.billing as Record<string, unknown>;
  return {
    ...legacy,
    schemaVersion: '2',
    github: {
      account: { type: 'user', login: 'example' },
      repository: github.repository,
      accountPolicy: {
        type: 'user',
        digest: organizationPolicy.digest,
        enabled: true,
        allowedActions: organizationPolicy.allowedActions,
        defaultWorkflowPermissions: organizationPolicy.defaultWorkflowPermissions,
        canApprovePullRequestReviews: organizationPolicy.canApprovePullRequestReviews,
        artifactAndLogRetentionDays: organizationPolicy.artifactAndLogRetentionDays,
      },
      billing: {
        ...billing,
        auditUrl: 'https://github.com/settings/billing/usage',
      },
      concurrencyProbe: {
        ...accountConcurrencyProbe,
        reviewedAccountLimit: reviewedOrganizationLimit,
      },
      durationProbe: github.durationProbe,
    },
  };
}

describe('platform limits evidence V2 account contract', () => {
  it('keeps V1 parse-only compatibility while requiring V2 for the new account contract', () => {
    const legacy = JSON.parse(readFileSync(
      new URL('../schemas/platform-limits-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(PlatformLimitsEvidenceManifestV1Schema.safeParse(legacy).success).toBe(true);
    expect(PlatformLimitsEvidenceManifestV2Schema.safeParse(legacy).success).toBe(false);
  });

  it('accepts a personal account and rejects owner, policy, and billing URL drift', () => {
    const input = userManifest();
    expect(PlatformLimitsEvidenceManifestV2Schema.safeParse(input).success).toBe(true);

    const github = input.github as Record<string, unknown>;
    expect(PlatformLimitsEvidenceManifestV2Schema.safeParse({
      ...input,
      github: { ...github, repository: 'other/delivery-target' },
    }).success).toBe(false);
    expect(PlatformLimitsEvidenceManifestV2Schema.safeParse({
      ...input,
      github: {
        ...github,
        accountPolicy: {
          ...(github.accountPolicy as Record<string, unknown>),
          enabledRepositories: 'selected',
        },
      },
    }).success).toBe(false);
    expect(PlatformLimitsEvidenceManifestV2Schema.safeParse({
      ...input,
      github: {
        ...github,
        billing: {
          ...(github.billing as Record<string, unknown>),
          auditUrl: 'https://github.com/organizations/example/settings/billing/usage',
        },
      },
    }).success).toBe(false);
  });
});
