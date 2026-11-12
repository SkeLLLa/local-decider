export type Priority = 'high' | 'normal' | 'low';

const RANK: Readonly<Record<Priority, number>> = { high: 0, normal: 1, low: 2 };

/** How long a job whose signal fired may keep the slot before the next job starts. */
export const ABANDON_GRACE_MS = 1000;
const ABANDON_WARNING =
  'engine queue: an engine job kept running past its deadline; released its slot (logged once)';

/** Refused at admission or evicted by a high job; the decider reports `engine queue full`. */
export class QueueFullError extends Error {
  override readonly name = 'QueueFullError';
  constructor() {
    super('engine queue full');
  }
}

export interface QueueLimits {
  /** Jobs waiting or running before `low` and `high` ones are refused (`high` evicts first). */
  readonly max: number;
  /** Of `max`, slots `normal` jobs may not take. */
  readonly highReserve: number;
}

/** Jobs of `priority` are admitted while depth is below this. */
export function admissionLimit(priority: Priority, limits: QueueLimits): number {
  return priority === 'normal' ? limits.max - limits.highReserve : limits.max;
}

interface SerialQueueOptions {
  readonly abandonGraceMs?: number;
  readonly warn?: (message: string) => void;
}

interface Waiting {
  readonly rank: number;
  readonly seq: number;
  readonly start: () => void;
  /** Detaches the abort listener and rejects the waiting caller. */
  readonly fail: (error: Error) => void;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError');
}

/**
 * One request in flight per engine (engines answer one at a time). Waiting jobs run highest
 * priority first, FIFO within a priority. A waiter whose signal fires leaves the queue at once.
 * With `limits`, `normal` jobs keep out of the high reserve and a `high` job arriving at the
 * maximum evicts the oldest waiting `low` one. A job that ignores its signal loses the slot
 * `abandonGraceMs` after the signal fires.
 */
export class SerialQueue {
  readonly #waiting: Waiting[] = [];
  readonly #graceMs: number;
  readonly #warn: (message: string) => void;
  #busy = false;
  #seq = 0;
  #warned = false;

  constructor(options: SerialQueueOptions = {}) {
    this.#graceMs = options.abandonGraceMs ?? ABANDON_GRACE_MS;
    // Look console.error up per call, so a test's mock.method(console, 'error') sees it.
    this.#warn =
      options.warn ??
      ((message) => {
        console.error(message);
      });
  }

  get depth(): number {
    return this.#waiting.length + (this.#busy ? 1 : 0);
  }

  run<T>(
    signal: AbortSignal,
    job: () => Promise<T>,
    priority: Priority = 'normal',
    limits?: QueueLimits,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      if (limits !== undefined && !this.#admit(priority, limits)) {
        reject(new QueueFullError());
        return;
      }
      this.#enqueue(signal, priority, job, resolve, reject);
    });
  }

  #enqueue<T>(
    signal: AbortSignal,
    priority: Priority,
    job: () => Promise<T>,
    resolve: (value: T) => void,
    reject: (error: unknown) => void,
  ): void {
    const onAbort = (): void => {
      if (this.#remove(entry)) {
        entry.fail(abortReason(signal));
      }
    };
    this.#seq += 1;
    const entry: Waiting = {
      rank: RANK[priority],
      seq: this.#seq,
      start: () => {
        signal.removeEventListener('abort', onAbort);
        this.#start(signal, job, resolve, reject);
      },
      fail: (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    };
    signal.addEventListener('abort', onAbort, { once: true });
    this.#waiting.push(entry);
    this.#next();
  }

  #start<T>(
    signal: AbortSignal,
    job: () => Promise<T>,
    resolve: (value: T) => void,
    reject: (error: unknown) => void,
  ): void {
    this.#busy = true;
    let released = false;
    let timer: NodeJS.Timeout | undefined;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      this.#busy = false;
      this.#next();
    };
    const onAbort = (): void => {
      reject(abortReason(signal));
      // A job that ignores its signal keeps the engine at most #graceMs longer. An engine that
      // never settles makes every later job do the same; detecting that hang is R2's job.
      timer = setTimeout(() => {
        if (!released) {
          this.#noteAbandoned();
          release();
        }
      }, this.#graceMs);
    };
    if (signal.aborted) {
      // Defensive: waiters leave on abort, so this is normally unreachable.
      reject(abortReason(signal));
      release();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    // Promise.try: a job that throws synchronously still settles and releases the slot.
    Promise.try(job).then(resolve, reject).finally(release);
  }

  /** Logged once per queue; never includes request data. A counter for `/health` is R5's. */
  #noteAbandoned(): void {
    if (!this.#warned) {
      this.#warned = true;
      this.#warn(ABANDON_WARNING);
    }
  }

  #admit(priority: Priority, limits: QueueLimits): boolean {
    if (this.depth < admissionLimit(priority, limits)) {
      return true;
    }
    if (priority !== 'high') {
      return false;
    }
    const oldestLow = this.#waiting.find((w) => w.rank === RANK.low);
    if (oldestLow === undefined) {
      return false;
    }
    this.#remove(oldestLow);
    oldestLow.fail(new QueueFullError());
    return true;
  }

  #remove(entry: Waiting): boolean {
    const index = this.#waiting.indexOf(entry);
    if (index < 0) {
      return false;
    }
    this.#waiting.splice(index, 1);
    return true;
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
