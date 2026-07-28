interface ImmutableJsonObjectInput {
  key: string;
  body: string;
  metadata: Record<string, string>;
}

export class ImmutableR2ObjectConflictError extends Error {
  constructor() {
    super('immutable R2 object conflicts with stored content');
    this.name = 'ImmutableR2ObjectConflictError';
  }
}

/**
 * Content-addressed create-if-absent. The R2 conditional-write pattern is
 * copied from Watt's ObjectContextProvider at commit 476e3cdd2490d725fde174e7c697ebf00899edc6.
 */
export async function putImmutableJsonObject(
  bucket: R2Bucket,
  input: ImmutableJsonObjectInput,
): Promise<void> {
  const existing = await bucket.head(input.key);
  if (existing !== null) {
    assertMetadata(existing.customMetadata, input.metadata);
    return;
  }

  const written = await bucket.put(input.key, input.body, {
    // Watt: a concurrent creator wins once; the loser observes null and reconciles.
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: input.metadata,
  });
  if (written !== null) return;

  const concurrent = await bucket.head(input.key);
  if (concurrent === null) throw new ImmutableR2ObjectConflictError();
  assertMetadata(concurrent.customMetadata, input.metadata);
}

function assertMetadata(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
): void {
  if (
    actual === undefined ||
    Object.entries(expected).some(([key, value]) => actual[key] !== value)
  ) {
    throw new ImmutableR2ObjectConflictError();
  }
}
