import type { SystemOneRequest, SystemOneResponse } from '@ziptie-soft/local-decider-core';
import { setTimeout as sleep } from 'node:timers/promises';

import { EngineError, type Engine, type EngineHealth } from './types.ts';

export type Lifecycle = 'lazy' | 'eager';

export interface LifecycleOptions {
  readonly lifecycle: Lifecycle;
  readonly idleUnloadMinutes: number;
  readonly now?: () => number;
}

/**
 * Lifecycle around an engine. `lazy`: load on the first decision (or `load()`), unload after
 * `idleUnloadMinutes` without one, freeing RAM and the NPU. `eager`: load at start, never unload.
 * Either way a decision that arrives while the engine loads waits for it (bounded by its own
 * signal) instead of failing.
 */
export class ManagedEngine implements Engine {
  readonly #inner: Engine;
  #options: LifecycleOptions;
  #lastUsed: number | undefined;
  #loading: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #unloadedIdle = false;

  constructor(inner: Engine, options: LifecycleOptions) {
    this.#inner = inner;
    this.#options = options;
  }

  get id(): string {
    return this.#inner.id;
  }

  get model(): string {
    return this.#inner.model;
  }

  get lifecycle(): LifecycleOptions {
    return this.#options;
  }

  get lastUsedAt(): string | null {
    return this.#lastUsed === undefined ? null : new Date(this.#lastUsed).toISOString();
  }

  setLifecycle(options: LifecycleOptions): void {
    this.#options = options;
    this.#arm();
    if (options.lifecycle === 'eager') {
      void this.load();
    }
  }

  /** Gateway start: eager engines load now, lazy ones wait for the first decision. */
  async start(): Promise<void> {
    if (this.#options.lifecycle === 'eager') {
      await this.load();
    }
  }

  load(): Promise<void> {
    const state = this.#inner.health().state;
    if (state === 'ready') {
      return Promise.resolve();
    }
    if (this.#loading === undefined || state === 'failed' || state === 'stopped') {
      this.#unloadedIdle = false;
      this.#loading = this.#inner.start().finally(() => {
        this.#loading = undefined;
      });
    }
    this.#arm();
    return this.#loading;
  }

  async unload(reason?: 'idle'): Promise<void> {
    clearTimeout(this.#timer);
    this.#unloadedIdle = reason === 'idle';
    await this.#inner.stop();
  }

  health(): EngineHealth {
    const inner = this.#inner.health();
    if (inner.state === 'stopped' && this.#options.lifecycle === 'lazy') {
      const why = this.#unloadedIdle
        ? `unloaded after ${String(this.#options.idleUnloadMinutes)} min idle; `
        : '';
      return { ...inner, onDemand: true, detail: `${why}loads on the next decision` };
    }
    return inner;
  }

  /** Wait until the engine answers; loads it first when it is stopped. */
  async ensureReady(signal: AbortSignal): Promise<void> {
    const state = this.#inner.health().state;
    if (state === 'ready') {
      return;
    }
    if (state === 'stopped' || state === 'failed') {
      void this.load();
    }
    while (this.#inner.health().state !== 'ready') {
      signal.throwIfAborted();
      if (this.#inner.health().state === 'failed' && this.#loading === undefined) {
        throw new EngineError(`engine failed: ${this.#inner.health().detail ?? 'unknown'}`);
      }
      await sleep(100, undefined, { signal });
    }
  }

  async decide(request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse> {
    this.#lastUsed = (this.#options.now ?? Date.now)();
    this.#arm();
    await this.ensureReady(signal);
    return this.#inner.decide(request, signal);
  }

  async stop(): Promise<void> {
    clearTimeout(this.#timer);
    await this.#inner.stop();
  }

  /** (Re)start the idle timer; only lazy engines unload. */
  #arm(): void {
    clearTimeout(this.#timer);
    if (this.#options.lifecycle !== 'lazy') {
      return;
    }
    this.#timer = setTimeout(() => {
      if (this.#inner.health().state === 'ready') {
        void this.unload('idle');
      }
    }, this.#options.idleUnloadMinutes * 60_000);
    this.#timer.unref();
  }
}
