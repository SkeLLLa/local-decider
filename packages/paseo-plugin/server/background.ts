/**
 * Detached decision work. A CPU decision can take far longer than a notification hook should
 * hold (19 s at ~3k tokens, and hooks are aborted at 30 s), so turn and permission hooks return
 * at once and the decision finishes here; its row is appended when it returns.
 */
export class Background {
  readonly #controller = new AbortController();
  readonly #inFlight = new Set<Promise<void>>();
  readonly #max: number;

  constructor(max = 16) {
    this.#max = max;
  }

  /** Start `task`; false (not started) when stopped or at capacity. Never rejects. */
  run(task: (signal: AbortSignal) => Promise<void>, onError: (error: unknown) => void): boolean {
    if (this.#controller.signal.aborted || this.#inFlight.size >= this.#max) {
      return false;
    }
    const promise = task(this.#controller.signal)
      .catch(onError)
      .finally(() => {
        this.#inFlight.delete(promise);
      });
    this.#inFlight.add(promise);
    return true;
  }

  /** Resolves when everything started so far has settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.all(this.#inFlight);
    }
  }

  /** Abort in-flight work (plugin stop). */
  stop(): void {
    this.#controller.abort();
  }
}

/** Run a hook's decision detached, logging failures and refusals under `label`. */
export function detach(
  background: Background,
  log: (message: string) => void,
  label: string,
  task: (signal: AbortSignal) => Promise<void>,
): void {
  const started = background.run(task, (error) =>
    log(`${label} skipped: ${error instanceof Error ? error.message : String(error)}`),
  );
  if (!started) {
    log(`${label} skipped: too many decisions in flight`);
  }
}
