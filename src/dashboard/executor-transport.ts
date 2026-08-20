import type { Bindings } from '../env.js';
import {
  cloudflareSandboxEffectsFromEnv,
} from '../executor/plugins/cloudflare-sandbox/cloudflare-sandbox-runtime.js';
import type {
  CloudflareSandboxWorkerEffects,
} from '../executor/plugins/cloudflare-sandbox/cloudflare-sandbox-runtime.js';

/**
 * Resolved executor transport for board features, or `null` when the board
 * cannot reach a sandbox.
 */
export interface DashboardExecutorTransport {
  readonly effects: CloudflareSandboxWorkerEffects;
  readonly origin: string;
}

/**
 * Resolves the sandbox transport for read-only board features and operator
 * actions, reporting absence instead of throwing.
 *
 * `cloudflareSandboxEffectsFromEnv` returns null only when every sandbox
 * setting is missing and throws when they are partial. That split is reachable
 * in practice: `AGENT_EXECUTOR_URL` ships as a plain var in wrangler.jsonc
 * while `AGENT_EXECUTOR_CONTROL_TOKEN` is a secret, so an environment holding
 * the var without the secret raises. CI runs in exactly that shape.
 *
 * For the executor pipeline that throw is correct — a half-configured
 * deployment must not silently skip dispatch. For the board it is not: every
 * caller here already has a defined "no transport" behaviour (report recorded
 * state, leave a container reapable, answer 503), and turning a configuration
 * gap into an unhandled 500 loses that behaviour. Worse, in the removal path it
 * surfaced as a failed request after the run had already been cancelled and
 * dismissed.
 *
 * Callers that must distinguish "unconfigured" from "unreachable" should treat
 * null as unconfigured; a configured-but-failing transport still throws from
 * its own methods.
 */
export function dashboardExecutorTransport(
  env: Pick<Bindings,
    | 'AGENT_EXECUTOR'
    | 'AGENT_EXECUTOR_URL'
    | 'AGENT_EXECUTOR_CONTROL_TOKEN'
    | 'AGENT_EXECUTOR_CALLBACK_TOKEN'>,
): DashboardExecutorTransport | null {
  let effects: CloudflareSandboxWorkerEffects | null;
  try {
    effects = cloudflareSandboxEffectsFromEnv(env);
  } catch {
    return null;
  }
  const origin = env.AGENT_EXECUTOR_URL;
  if (effects === null || origin === undefined) return null;
  return { effects, origin };
}
