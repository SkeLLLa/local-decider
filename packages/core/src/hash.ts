import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical.ts';

/** Stable SHA-256 of a JSON-like value: the shadow log's input hash and the cache key. */
export function inputHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
