import type { PlanEffect } from './plan.js';

export const ANALYSIS_READ_EFFECTS = [
  'repo_read',
  'logs_read',
  'database_diagnostic',
] as const satisfies readonly PlanEffect[];

export const ANALYSIS_READ_COMMAND_REFS = ['policy:inspect', 'policy:diagnose'] as const;

/**
 * In-sandbox verification refs the analysis agent may attach to a self-verifying
 * change Item, keyed by target repository.
 *
 * These must name commands the target repository actually declares in its own
 * delivery.yaml: the ref is resolved in the sandbox against that file, and
 * `resolveDeliveryCommand` throws `untrusted_command` for an id the contract
 * does not define. A single hardcoded set therefore only ever works for one
 * repository — a Go repository declaring `test:unit` / `verify:all` failed at
 * plan time while this listed only `smoke`.
 *
 * The control plane cannot read the target's delivery.yaml to discover these:
 * that file is only trusted as committed at the dispatch base SHA and is read
 * inside the sandbox from the verified checkout. Keeping the mapping here
 * preserves that boundary — the ceiling stays a control-plane decision derived
 * from trusted Task classification, never from agent-reachable input.
 *
 * Commands should stay bounded, but the old "0.5 vCPU" constraint no longer
 * holds: the sandbox runs on `standard-4` (4 vCPU / 12 GiB memory / 20 GB disk)
 * since the enlargement in 78d43ba. The OOM kills that motivated reducing
 * everything to a file-existence smoke were observed before that resize, so a
 * targeted package test is affordable now. The authoritative full suite still
 * runs as the target repository's pull_request CI, the enforced merge gate.
 */
interface PilotCommandRefs {
  readonly change: readonly string[];
  readonly verification: readonly string[];
}

const DEFAULT_PILOT_COMMAND_REFS: PilotCommandRefs = {
  change: ['test:smoke', 'verify:smoke'],
  verification: ['verify:smoke'],
};

const PILOT_COMMAND_REFS_BY_REPOSITORY: Readonly<Record<string, PilotCommandRefs>> = {
  // Go monolith. Measured on the standard-4 sandbox against a real checkout:
  //
  //   go mod download            102s, 1.7 GiB module cache
  //   go build ./cmd/smoketest/… 114s, peak ~1.7 GiB   <- offered
  //   go test ./service -run …   >540s and still linking, no test had begun
  //
  // Memory is not the constraint (1.7 GiB against a 12 GiB limit); link time is.
  // `test:unit` cannot finish inside its own 600s budget once module download is
  // counted, so offering it would guarantee a timeout kill. The smoketest build
  // is what the repository's own smoke-build.yml enforces on every pull request
  // — the DTO coupling gate — so it is both affordable and the check that
  // actually matters here.
  //
  // The ref category must be one of setup|test|verify|acceptance
  // (COMMAND_REF_PATTERN). The affordable smoketest build is declared in the
  // repository's delivery.yaml under BOTH `targeted.smoke` (test:smoke) and
  // `verify.smoke` (verify:smoke) — the same `go build ./cmd/smoketest/...`,
  // 114s cold / 1s warm — because a self-verifying change item requires one
  // test:* ref AND one verify:* ref (commit + test evidence). Offering only
  // verify:smoke made every plan impossible: selfVerifying (the sole way to
  // satisfy requiresRepositoryChange) demands a test:* ref, so the model either
  // added an out-of-allowlist test:* (command_ref_not_allowed) or omitted it
  // (repository_change_required). test:smoke here is the Go smoketest build, not
  // test:unit — the latter still exceeds its 600s budget and stays excluded.
  'lightspeed-intelligence/tipsy-backend': {
    change: ['test:smoke', 'verify:smoke'],
    verification: ['verify:smoke'],
  },
};

export function analysisPilotCommandRefs(repository: string): PilotCommandRefs {
  return PILOT_COMMAND_REFS_BY_REPOSITORY[repository] ?? DEFAULT_PILOT_COMMAND_REFS;
}

/** @deprecated Use {@link analysisPilotCommandRefs}; kept for existing callers. */
export const ANALYSIS_PILOT_CHANGE_COMMAND_REFS = DEFAULT_PILOT_COMMAND_REFS.change;
export const ANALYSIS_PILOT_VERIFICATION_COMMAND_REFS = DEFAULT_PILOT_COMMAND_REFS.verification;

export interface AnalysisPlanPolicy {
  allowedEffects: readonly PlanEffect[];
  allowedCommandRefs: readonly string[];
  verificationCommandRefs: readonly string[];
  requiresRepositoryChange: boolean;
  requiresTestDeployment: boolean;
}

/**
 * Derives the Plan proposal ceiling from trusted Task classification, never Task
 * prose.
 *
 * `repository` selects the in-sandbox command refs, which must match the target
 * repository's own delivery.yaml contract. It is optional so existing callers
 * keep the default pilot refs.
 */
export function deriveAnalysisPlanPolicy(
  intentKind: 'requirement' | 'bug',
  allowRepositoryWrite: boolean,
  allowTestDeploy = false,
  targetEnvironment: 'none' | 'test' | 'production' = 'none',
  repository?: string,
): AnalysisPlanPolicy {
  const allowsTestDeployment =
    allowRepositoryWrite && allowTestDeploy && targetEnvironment === 'test';
  const pilot = analysisPilotCommandRefs(repository ?? '');
  return {
    allowedEffects: allowRepositoryWrite
      ? [...ANALYSIS_READ_EFFECTS, 'repo_write', ...(allowsTestDeployment ? ['test_deploy' as const] : [])]
      : ANALYSIS_READ_EFFECTS,
    allowedCommandRefs: allowRepositoryWrite
      ? [...ANALYSIS_READ_COMMAND_REFS, ...pilot.change]
      : ANALYSIS_READ_COMMAND_REFS,
    verificationCommandRefs: allowRepositoryWrite
      ? pilot.verification
      : [],
    // A writable intake is an execution request regardless of whether it began
    // as a PRD or a bug report. Read-only bug intake remains investigation-only.
    requiresRepositoryChange: allowRepositoryWrite,
    requiresTestDeployment: allowsTestDeployment,
  };
}
