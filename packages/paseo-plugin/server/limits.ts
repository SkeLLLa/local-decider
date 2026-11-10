/** In-memory dedupe and per-agent rate limiting for hook-driven decisions. */

/** Insertion-ordered set that forgets its oldest keys beyond `max`. */
export class BoundedSet {
  readonly #max: number;
  readonly #keys = new Set<string>();

  constructor(max: number) {
    this.#max = max;
  }

  /** Add `key`; false when it was already present. */
  add(key: string): boolean {
    if (this.#keys.has(key)) {
      return false;
    }
    this.#keys.add(key);
    while (this.#keys.size > this.#max) {
      const oldest = this.#keys.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#keys.delete(oldest);
    }
    return true;
  }
}

/** Insertion-ordered map that forgets its oldest entries beyond `max`. */
export class BoundedMap<V> {
  readonly #max: number;
  readonly #map = new Map<string, V>();

  constructor(max: number) {
    this.#max = max;
  }

  get(key: string): V | undefined {
    return this.#map.get(key);
  }

  take(key: string): V | undefined {
    const value = this.#map.get(key);
    this.#map.delete(key);
    return value;
  }

  set(key: string, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#map.delete(oldest);
    }
  }
}

/** At most `limit` events per `windowMs` per key (sliding window). */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #hits = new BoundedMap<number[]>(500);

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Record an event for `key`; false (and nothing recorded) when over the limit. */
  allow(key: string): boolean {
    const now = this.#now();
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.#windowMs);
    if (recent.length >= this.#limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(key, recent);
    return true;
  }
}
