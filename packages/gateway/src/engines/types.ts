import type { SystemOneRequest, SystemOneResponse } from '@local-decider/core';

export type EngineState = 'stopped' | 'starting' | 'ready' | 'failed';

export interface EngineHealth {
  readonly state: EngineState;
  readonly model: string;
  readonly detail?: string;
  /** Context window reported by the engine, in tokens. */
  readonly maxLength?: number;
}

export interface Engine {
  readonly id: string;
  readonly model: string;
  /** Spawn or attach. Resolves once the engine answers health checks; never rejects. */
  start(): Promise<void>;
  health(): EngineHealth;
  decide(request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse>;
  stop(): Promise<void>;
}

export class EngineError extends Error {
  override readonly name = 'EngineError';
}
