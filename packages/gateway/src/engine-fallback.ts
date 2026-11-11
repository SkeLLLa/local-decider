export interface FallbackOptions {
  readonly now?: () => number;
  /** Cooldown after the first failure; doubles per consecutive failure. */
  readonly baseMs?: number;
  readonly maxMs?: number;
  /** How long an engine must stay healthy before its failure count is forgiven. */
  readonly stableMs?: number;
}

interface Failure {
  count: number;
  until: number;
  /** Set once the candidate came up healthy; a failure after this time starts the count over. */
  stableAfter: number | undefined;
}

export interface Keyed {
  readonly engine: string;
  readonly device: string | null;
  readonly model: string;
}

export function candidateKey(c: Keyed): string {
  return `${c.engine}|${c.device ?? ''}|${c.model}`;
}

const BASE_MS = 30_000;
const MAX_MS = 15 * 60_000;
const STABLE_MS = 5 * 60_000;

/** Cooldown with exponential backoff per candidate, so a flapping engine is retried ever less. */
export class FallbackPolicy {
  readonly #failures = new Map<string, Failure>();
  readonly #now: () => number;
  readonly #baseMs: number;
  readonly #maxMs: number;
  readonly #stableMs: number;

  constructor(options: FallbackOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#baseMs = options.baseMs ?? BASE_MS;
    this.#maxMs = options.maxMs ?? MAX_MS;
    this.#stableMs = options.stableMs ?? STABLE_MS;
  }

  /** Marks `key` failed; returns when it may be retried. */
  recordFailure(key: string): number {
    const previous = this.#failures.get(key);
    const forgiven = previous?.stableAfter !== undefined && previous.stableAfter <= this.#now();
    const count = (forgiven ? 0 : (previous?.count ?? 0)) + 1;
    const until = this.#now() + Math.min(this.#maxMs, this.#baseMs * 2 ** (count - 1));
    this.#failures.set(key, { count, until, stableAfter: undefined });
    return until;
  }

  /** A healthy start; the backoff resets only if it then stays up for `stableMs`. */
  recordSuccess(key: string): void {
    const failure = this.#failures.get(key);
    if (failure !== undefined && failure.stableAfter === undefined) {
      failure.stableAfter = this.#now() + this.#stableMs;
    }
  }

  blocked(key: string): boolean {
    const failure = this.#failures.get(key);
    return failure !== undefined && failure.until > this.#now();
  }

  /** The earliest time a blocked candidate becomes retryable, if any is blocked. */
  nextRetryAt(): number | undefined {
    const now = this.#now();
    const times = [...this.#failures.values()].map((f) => f.until).filter((t) => t > now);
    return times.length === 0 ? undefined : Math.min(...times);
  }

  /** The first usable candidate (ranking order) that is not cooling down. */
  pick<T extends Keyed & { readonly eligible: boolean; readonly ready: boolean }>(
    candidates: readonly T[],
    present: (candidate: T) => boolean,
  ): T | undefined {
    return candidates.find(
      (c) => c.eligible && c.ready && present(c) && !this.blocked(candidateKey(c)),
    );
  }
}
