export type Priority = 'high' | 'normal' | 'low';

const RANK: Readonly<Record<Priority, number>> = { high: 0, normal: 1, low: 2 };

interface Waiting {
  readonly rank: number;
  readonly seq: number;
  readonly start: () => void;
}

/**
 * One request in flight per engine (engines answer one at a time). Waiting jobs run highest
 * priority first, FIFO within a priority, and keep their caller's abort signal: a job whose
 * signal fired while it waited is skipped.
 */
export class SerialQueue {
  readonly #waiting: Waiting[] = [];
  #busy = false;
  #seq = 0;

  get depth(): number {
    return this.#waiting.length + (this.#busy ? 1 : 0);
  }

  run<T>(signal: AbortSignal, job: () => Promise<T>, priority: Priority = 'normal'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.#busy = true;
        const work = signal.aborted ? Promise.reject(signal.reason as Error) : job();
        work.then(resolve, reject).finally(() => {
          this.#busy = false;
          this.#next();
        });
      };
      this.#seq += 1;
      this.#waiting.push({ rank: RANK[priority], seq: this.#seq, start });
      if (!this.#busy) {
        this.#next();
      }
    });
  }

  #next(): void {
    if (this.#busy || this.#waiting.length === 0) {
      return;
    }
    let best = 0;
    for (let i = 1; i < this.#waiting.length; i++) {
      const a = this.#waiting[i];
      const b = this.#waiting[best];
      if (
        a !== undefined &&
        b !== undefined &&
        (a.rank < b.rank || (a.rank === b.rank && a.seq < b.seq))
      ) {
        best = i;
      }
    }
    const [chosen] = this.#waiting.splice(best, 1);
    chosen?.start();
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
