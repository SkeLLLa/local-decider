import type { RuntimeStamp } from './engines/descriptor.ts';

export const STAMP_TTL_MS = 60_000;

export type StampResolver = (engine: string, model: string) => Promise<RuntimeStamp>;

interface StampEntry {
  readonly stamp: RuntimeStamp;
  readonly at: number;
}

export class StampCache {
  #entries = new Map<string, StampEntry>();
  #pending = new Map<string, Promise<void>>();
  readonly #resolve: StampResolver;
  readonly #now: () => number;

  constructor(resolve: StampResolver, now: () => number = Date.now) {
    this.#resolve = resolve;
    this.#now = now;
  }

  get(engine: string, model: string): RuntimeStamp | undefined {
    const key = stampKey(engine, model);
    const entry = this.#entries.get(key);
    if (entry === undefined || this.#now() - entry.at >= STAMP_TTL_MS) void this.#refresh(key);
    return entry?.stamp;
  }

  async refreshNow(keys: readonly string[], capMs: number): Promise<void> {
    const pending = keys.map((key) => this.#refresh(key));
    if (pending.length === 0 || capMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, capMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #refresh(key: string): Promise<void> {
    const existing = this.#pending.get(key);
    if (existing !== undefined) return existing;
    const separator = key.indexOf('|');
    const engine = key.slice(0, separator);
    const model = key.slice(separator + 1);
    const pending = Promise.resolve()
      .then(() => this.#resolve(engine, model))
      .catch((): RuntimeStamp => ({ runtime: null, model: null }))
      .then((stamp) => this.#entries.set(key, { stamp, at: this.#now() }))
      .then(() => undefined)
      .finally(() => this.#pending.delete(key));
    this.#pending.set(key, pending);
    return pending;
  }
}

export function stampKey(engine: string, model: string): string {
  return `${engine}|${model}`;
}
