import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { LogStore } from './log-store.ts';
import type { Paths } from './paths.ts';
import { runStats, type StatsJob } from './stats-job.ts';
import type { PolicyStats } from './stats.ts';

const STATS_TIMEOUT_MS = 30_000;

export class StatsTimeoutError extends Error {
  constructor() {
    super('stats computation timed out');
  }
}

export class StatsFailedError extends Error {
  constructor() {
    super('stats computation failed');
  }
}

export interface StatsServiceOptions {
  /** Used in-process when there is no database file for a worker to open. */
  readonly log: LogStore;
  /** Data paths of the SQLite file; absent for an injected store, which computes in-process. */
  readonly paths?: Paths | undefined;
  readonly timeoutMs?: number | undefined;
  /** Worker entry override (tests). */
  readonly workerFile?: URL | undefined;
}

function defaultWorkerFile(): URL {
  return new URL(`./stats-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);
}

/** Runs one stats computation at a time, off the event loop; identical requests share a run. */
export class StatsService {
  readonly #options: StatsServiceOptions;
  readonly #shared = new Map<string, Promise<PolicyStats[]>>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: StatsServiceOptions) {
    this.#options = options;
  }

  compute(job: StatsJob): Promise<PolicyStats[]> {
    const { paths } = this.#options;
    if (paths === undefined) {
      return Promise.resolve().then(() => runStats(this.#options.log, job));
    }
    const key = `${String(job.days)}:${job.scope ?? ''}`;
    const existing = this.#shared.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const run = this.#tail.then(() => this.#spawn(paths, job));
    this.#tail = run.catch(() => undefined);
    const settled = run.finally(() => this.#shared.delete(key));
    this.#shared.set(key, settled);
    return settled;
  }

  #spawn(paths: Paths, job: StatsJob): Promise<PolicyStats[]> {
    const timeoutMs = this.#options.timeoutMs ?? STATS_TIMEOUT_MS;
    const worker = new Worker(this.#options.workerFile ?? defaultWorkerFile(), {
      workerData: { ...job, paths },
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new StatsTimeoutError());
        void worker.terminate();
      }, timeoutMs);
      const finish = (error: Error | undefined, result?: PolicyStats[]): void => {
        clearTimeout(timer);
        void worker.terminate();
        if (error === undefined) {
          resolve(result as PolicyStats[]);
        } else {
          reject(error);
        }
      };
      worker.once('message', (m: { ok: boolean; result?: PolicyStats[] }) =>
        finish(m.ok ? undefined : new StatsFailedError(), m.result),
      );
      worker.once('error', () => finish(new StatsFailedError()));
      worker.once('exit', () => finish(new StatsFailedError()));
    });
  }
}
