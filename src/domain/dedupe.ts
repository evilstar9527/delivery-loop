/**
 * dedupeKey idempotency: pure function plus a storage interface.
 *
 * Copied from Watt commit 476e3cdd2490d725fde174e7c697ebf00899edc6
 * (`packages/core/src/event/dedupe.ts`). The durable monitor adapter uses the
 * same inclusive-window semantics in D1; this in-memory implementation remains
 * the executable oracle for the boundary behavior.
 */

export const DEFAULT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DedupeRecord {
  eventId: string;
  storedAt: number;
}

export interface DedupeStore {
  get(dedupeKey: string): DedupeRecord | undefined;
  set(dedupeKey: string, record: DedupeRecord): void;
}

export class InMemoryDedupeStore implements DedupeStore {
  private readonly map = new Map<string, DedupeRecord>();

  get(dedupeKey: string): DedupeRecord | undefined {
    return this.map.get(dedupeKey);
  }

  set(dedupeKey: string, record: DedupeRecord): void {
    this.map.set(dedupeKey, record);
  }
}

export interface ResolveDedupeInput {
  dedupeKey: string;
  eventId: string;
  now: number;
  windowMs?: number;
}

export interface DedupeResult {
  eventId: string;
  duplicate: boolean;
}

/** The exact window edge remains a duplicate; one millisecond later is new. */
export function resolveDedupe(store: DedupeStore, input: ResolveDedupeInput): DedupeResult {
  const windowMs = input.windowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const existing = store.get(input.dedupeKey);
  if (existing !== undefined && input.now - existing.storedAt <= windowMs) {
    return { eventId: existing.eventId, duplicate: true };
  }
  store.set(input.dedupeKey, { eventId: input.eventId, storedAt: input.now });
  return { eventId: input.eventId, duplicate: false };
}
