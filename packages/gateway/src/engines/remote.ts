import { tokenAllowed, type SystemOneRequest, type SystemOneResponse } from '@local-decider/core';

import type { RemoteEngineConfig } from '../config.ts';
import { getHealth, postSystemOne } from './http.ts';
import type { Engine, EngineHealth, EngineState } from './types.ts';

/** Any `/v1/systemone` server: another machine, laya-serve, the GLiClass example server. */
export class SystemOneRemoteEngine implements Engine {
  readonly id = 'systemone-remote';
  readonly model: string;
  readonly #url: string;
  readonly #token: string | undefined;
  #state: EngineState = 'stopped';
  #detail: string | undefined;

  constructor(config: RemoteEngineConfig, env: NodeJS.ProcessEnv = process.env) {
    this.model = config.model;
    this.#url = config.url;
    // Like the gateway client: a token travels only over https or to this machine.
    this.#token =
      config.tokenEnv === undefined || !tokenAllowed(config.url) ? undefined : env[config.tokenEnv];
  }

  async start(): Promise<void> {
    this.#state = 'starting';
    const health = await getHealth(this.#url, 5000);
    this.#state = health === null ? 'failed' : 'ready';
    this.#detail = health === null ? `no /health at ${this.#url}` : undefined;
  }

  health(): EngineHealth {
    return {
      state: this.#state,
      model: this.model,
      ...(this.#detail === undefined ? {} : { detail: this.#detail }),
    };
  }

  async decide(request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse> {
    try {
      const response = await postSystemOne(
        { baseUrl: this.#url, token: this.#token },
        request,
        signal,
      );
      this.#state = 'ready';
      return response;
    } catch (error) {
      if (!signal.aborted) {
        this.#state = 'failed';
        this.#detail = (error as Error).message;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#state = 'stopped';
  }
}
