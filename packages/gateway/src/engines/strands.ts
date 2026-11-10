import type { SystemOneRequest, SystemOneResponse } from '@local-decider/core';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { StrandsEngineConfig } from '../config.ts';
import type { Paths } from '../paths.ts';
import { getHealth, postSystemOne } from './http.ts';
import { EngineError, type Engine, type EngineHealth, type EngineState } from './types.ts';

const STRANDS_VENV = 'strands-decider';
const MAX_RESTARTS = 5;

export function strandsBinary(paths: Paths): string {
  return join(paths.venvs, STRANDS_VENV, 'bin', 'strands-decider');
}

/** `serve` argv. Every element comes from validated config, never from a request. */
export function serveArgs(config: StrandsEngineConfig, port: number): string[] {
  const args = ['serve', config.model, '--host', '127.0.0.1', '--port', String(port)];
  if (config.device !== 'auto') {
    args.push('--device', config.device);
  }
  args.push('--max-batch', String(config.maxBatch), ...config.extraArgs);
  return args;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * strands-decider: spawned from the managed venv (`local-decider engine install`) on a free
 * loopback port and supervised with restart backoff, or attached to `config.url`.
 */
export class StrandsDeciderEngine implements Engine {
  readonly id = 'strands-decider';
  readonly model: string;
  readonly #config: StrandsEngineConfig;
  readonly #paths: Paths;
  #url: string | undefined;
  #child: ChildProcess | undefined;
  #state: EngineState = 'stopped';
  #detail: string | undefined;
  #maxLength: number | undefined;
  #restarts = 0;
  #stopping = false;

  constructor(config: StrandsEngineConfig, paths: Paths) {
    this.#config = config;
    this.#paths = paths;
    this.model = config.model;
    this.#url = config.url;
  }

  async start(): Promise<void> {
    this.#stopping = false;
    this.#state = 'starting';
    if (this.#config.url === undefined) {
      const spawned = await this.#spawn();
      if (!spawned) {
        return;
      }
    }
    await this.#waitHealthy();
  }

  health(): EngineHealth {
    return {
      state: this.#state,
      model: this.model,
      ...(this.#detail === undefined ? {} : { detail: this.#detail }),
      ...(this.#maxLength === undefined ? {} : { maxLength: this.#maxLength }),
    };
  }

  async decide(request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse> {
    if (this.#state !== 'ready' || this.#url === undefined) {
      throw new EngineError(`engine ${this.#state}`);
    }
    return postSystemOne({ baseUrl: this.#url }, request, signal);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#state = 'stopped';
    const child = this.#child;
    this.#child = undefined;
    if (child === undefined || child.exitCode !== null) {
      return;
    }
    child.kill('SIGTERM');
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const timer = sleep(10_000).then(() => child.kill('SIGKILL'));
    await Promise.race([exited, timer]);
  }

  async #spawn(): Promise<boolean> {
    const binary = strandsBinary(this.#paths);
    if (!existsSync(binary)) {
      this.#fail(`${binary} not found; run \`local-decider engine install\``);
      return false;
    }
    const port = await freePort();
    this.#url = `http://127.0.0.1:${String(port)}`;
    mkdirSync(this.#paths.logs, { recursive: true });
    const log = createWriteStream(join(this.#paths.logs, 'engine-strands-decider.log'), {
      flags: 'a',
    });
    const child = spawn(binary, serveArgs(this.#config, port), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    child.once('exit', (code, signal) => {
      log.end();
      this.#onExit(code, signal);
    });
    this.#child = child;
    return true;
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#stopping) {
      return;
    }
    this.#child = undefined;
    const reason = `engine exited (${signal ?? `code ${String(code)}`})`;
    if (this.#restarts >= MAX_RESTARTS) {
      this.#fail(`${reason}; giving up after ${String(MAX_RESTARTS)} restarts`);
      return;
    }
    this.#restarts += 1;
    this.#state = 'starting';
    this.#detail = `${reason}; restart ${String(this.#restarts)}`;
    void sleep(1000 * 2 ** this.#restarts).then(async () => {
      if (!this.#stopping) {
        await this.start();
      }
    });
  }

  async #waitHealthy(): Promise<void> {
    const deadline = Date.now() + this.#config.startTimeoutSeconds * 1000;
    while (!this.#stopping && Date.now() < deadline) {
      const url = this.#url;
      const body = url === undefined ? null : await getHealth(url, 3000);
      if (body !== null) {
        this.#ready(body);
        return;
      }
      if (this.#config.url === undefined && this.#child === undefined) {
        return; // exited; #onExit owns the next step
      }
      await sleep(1000);
    }
    if (!this.#stopping && this.#state === 'starting') {
      this.#fail('engine did not become healthy in time');
    }
  }

  #ready(body: Record<string, unknown>): void {
    this.#state = 'ready';
    this.#detail = undefined;
    const maxLength = body['max_length'];
    this.#maxLength = typeof maxLength === 'number' ? maxLength : undefined;
  }

  #fail(detail: string): void {
    this.#state = 'failed';
    this.#detail = detail;
  }
}
