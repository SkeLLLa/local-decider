/**
 * One request in flight per engine (strands-decider's concurrency is unverified upstream).
 * Waiting jobs keep their caller's abort signal and are skipped once it has fired.
 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  get depth(): number {
    return this.#depth;
  }

  run<T>(signal: AbortSignal, job: () => Promise<T>): Promise<T> {
    this.#depth += 1;
    const result = this.#tail.then(async () => {
      signal.throwIfAborted();
      return job();
    });
    const settle = (): void => {
      this.#depth -= 1;
    };
    this.#tail = result.then(settle, settle);
    return result;
  }
}

/** Rolling latency window for p50/p95. */
export class LatencyWindow {
  readonly #size: number;
  readonly #samples: number[] = [];

  constructor(size = 200) {
    this.#size = size;
  }

  add(ms: number): void {
    this.#samples.push(ms);
    if (this.#samples.length > this.#size) {
      this.#samples.shift();
    }
  }

  percentile(p: number): number | undefined {
    if (this.#samples.length === 0) {
      return undefined;
    }
    const sorted = this.#samples.toSorted((a, b) => a - b);
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return sorted[index];
  }
}
