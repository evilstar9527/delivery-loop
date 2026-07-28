import { DEFAULT_DEDUPE_WINDOW_MS } from '../domain/dedupe.js';
import {
  MonitorAdapterProfileV1Schema,
  type MonitorAdapterProfileV1,
} from '../domain/monitor-alert.js';
import type { Bindings } from '../env.js';

export interface MonitorAdapterRuntime {
  secret: string;
  profile: MonitorAdapterProfileV1;
}

function allowedRepositories(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('monitor adapter configuration is invalid');
  }
  if (!Array.isArray(parsed)) throw new Error('monitor adapter configuration is invalid');
  return parsed as string[];
}

function suppressionWindowMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_DEDUPE_WINDOW_MS;
  if (!/^[1-9][0-9]{1,5}$/.test(raw)) {
    throw new Error('monitor adapter configuration is invalid');
  }
  return Number(raw) * 1_000;
}

export function monitorAdapterRuntimeFromEnv(env: Bindings): MonitorAdapterRuntime | null {
  const configured = [
    env.MONITOR_WEBHOOK_SECRET,
    env.MONITOR_TENANT_KEY,
    env.MONITOR_ALLOWED_REPOSITORIES,
    env.MONITOR_SUPPRESSION_WINDOW_SECONDS,
  ];
  if (configured.every((value) => value === undefined)) return null;
  if (
    env.MONITOR_WEBHOOK_SECRET === undefined ||
    env.MONITOR_TENANT_KEY === undefined ||
    env.MONITOR_ALLOWED_REPOSITORIES === undefined
  ) throw new Error('monitor adapter configuration is incomplete');
  if (
    env.MONITOR_WEBHOOK_SECRET.length < 16 ||
    env.MONITOR_WEBHOOK_SECRET.length > 4_096 ||
    /[\0\r\n]/.test(env.MONITOR_WEBHOOK_SECRET)
  ) throw new Error('monitor adapter configuration is invalid');

  const profile = MonitorAdapterProfileV1Schema.parse({
    schemaVersion: '1',
    adapter: 'generic',
    tenantKey: env.MONITOR_TENANT_KEY,
    allowedRepositories: allowedRepositories(env.MONITOR_ALLOWED_REPOSITORIES),
    suppressionWindowMs: suppressionWindowMs(env.MONITOR_SUPPRESSION_WINDOW_SECONDS),
  });
  return { secret: env.MONITOR_WEBHOOK_SECRET, profile };
}
