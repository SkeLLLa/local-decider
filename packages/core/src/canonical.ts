/**
 * Deterministic serialisation. Key order changes decision-model outputs (the Amazon study saw
 * shifts of up to 0.19), so every object sent to an engine or hashed for the log is key-sorted.
 */
export function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => sortKeysDeep(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, sortKeysDeep(item)] as const);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

/** JSON with keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}
