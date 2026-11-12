import type { SystemOneRequest, SystemOneResponse } from '@ziptie-soft/local-decider-core';

export type EngineState = 'stopped' | 'starting' | 'ready' | 'failed';

export interface EngineHealth {
  readonly state: EngineState;
  readonly model: string;
  readonly detail?: string;
  /** Unloaded on purpose (lazy lifecycle): healthy, loads on the next decision. */
  readonly onDemand?: boolean;
  /** Context window reported by the engine, in tokens. */
  readonly maxLength?: number;
  /** Device config as requested (`auto`, `cpu`, ...), for engines with devices. */
  readonly requestedDevice?: string;
  /** Concrete device after resolving `auto`; absent while unknown. */
  readonly resolvedDevice?: string;
  /** Backend tag: `MLX`, `MPS`, `CUDA` or `CPU`; absent while unknown. */
  readonly backend?: string;
}

export interface Engine {
  readonly id: string;
  readonly model: string;
  /** Spawn or attach. Resolves once the engine answers health checks; never rejects. */
  start(): Promise<void>;
  health(): EngineHealth;
  decide(request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse>;
  /** Engines that load on demand: wait (bounded by `signal`) until they can answer. */
  ensureReady?(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

export class EngineError extends Error {
  override readonly name = 'EngineError';
  readonly httpFailure:
    | { readonly status: number; readonly path: string; readonly body: string }
    | undefined;

  constructor(
    message: string,
    httpFailure?: { readonly status: number; readonly path: string; readonly body: string },
  ) {
    super(message);
    this.httpFailure = httpFailure;
  }
}
