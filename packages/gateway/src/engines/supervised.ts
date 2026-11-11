import type { SystemOneRequest, SystemOneResponse } from '@local-decider/core';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Paths } from '../paths.ts';
import { getHealth, postSystemOne } from './http.ts';
import { createEngineLogFilter } from './log-filter.ts';
import { EngineError, type Engine, type EngineHealth, type EngineState } from './types.ts';

const MAX_RESTARTS = 5;
/** Healthy this long before exiting, and the next crash starts a new restart budget. */
const STABLE_MS = 5 * 60_000;
const MAX_ENGINE_LOG_BYTES = 10 * 1024 * 1024;

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

/** How to launch and probe one kind of `/v1/systemone` server. */
export interface ServerSpec {
  readonly id: string;
  readonly model: string;
  /** Attach here instead of spawning. */
  readonly url?: string | undefined;
  readonly startTimeoutSeconds: number;
  /** Path probed for readiness; any 2xx JSON body counts. */
  readonly healthPath: string;
  /** Executable, or undefined with `missing` explaining why. */
  binary(): { readonly path?: string; readonly missing?: string };
  /** argv after the binary. Every element comes from validated config, never from a request. */
  args(port: number): string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Context window from the readiness body, when the server reports one. */
  maxLength?(body: Record<string, unknown>): number | undefined;
}

/**
 * A `/v1/systemone` server spawned on a free loopback port and supervised with restart backoff
 * (or attached to `spec.url`). Output goes to `logs/engine-<id>.log`.
 */
export class SupervisedEngine implements Engine {
  readonly id: string;
  readonly model: string;
  readonly #spec: ServerSpec;
  readonly #paths: Paths;
  #url: string | undefined;
  #child: ChildProcess | undefined;
  #state: EngineState = 'stopped';
  #detail: string | undefined;
  #maxLength: number | undefined;
  #restarts = 0;
  /** When the engine last became ready; a long healthy run resets the restart budget. */
  #readyAt: number | undefined;
  #stopping = false;

  constructor(spec: ServerSpec, paths: Paths) {
    this.#spec = spec;
    this.#paths = paths;
    this.id = spec.id;
    this.model = spec.model;
    this.#url = spec.url;
  }

  async start(): Promise<void> {
    this.#stopping = false;
    this.#state = 'starting';
    if (this.#spec.url === undefined) {
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
    const binary = this.#spec.binary();
    if (binary.path === undefined || !existsSync(binary.path)) {
      this.#fail(binary.missing ?? `${String(binary.path)} not found`);
      return false;
    }
    const port = await freePort();
    this.#url = `http://127.0.0.1:${String(port)}`;
    mkdirSync(this.#paths.logs, { recursive: true });
    const logPath = join(this.#paths.logs, `engine-${this.id}.log`);
    rotateEngineLog(logPath);
    const log = createWriteStream(logPath, { flags: 'a' });
    const child = spawn(binary.path, this.#spec.args(port), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...this.#spec.env },
    });
    child.stdout?.pipe(createEngineLogFilter()).pipe(log, { end: false });
    child.stderr?.pipe(createEngineLogFilter()).pipe(log, { end: false });
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
    // A crash after a long healthy run is a fresh failure, not part of a crash loop.
    if (this.#readyAt !== undefined && Date.now() - this.#readyAt >= STABLE_MS) {
      this.#restarts = 0;
    }
    this.#readyAt = undefined;
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
    const deadline = Date.now() + this.#spec.startTimeoutSeconds * 1000;
    while (!this.#stopping && Date.now() < deadline) {
      const url = this.#url;
      const body = url === undefined ? null : await getHealth(url, 3000, this.#spec.healthPath);
      if (body !== null) {
        this.#ready(body);
        return;
      }
      if (this.#spec.url === undefined && this.#child === undefined) {
        return; // exited; #onExit owns the next step
      }
      await sleep(500);
    }
    if (!this.#stopping && this.#state === 'starting') {
      this.#fail('engine did not become healthy in time');
    }
  }

  #ready(body: Record<string, unknown>): void {
    this.#state = 'ready';
    this.#readyAt = Date.now();
    this.#detail = undefined;
    this.#maxLength = this.#spec.maxLength?.(body);
  }

  #fail(detail: string): void {
    this.#state = 'failed';
    this.#detail = detail;
  }
}

function rotateEngineLog(path: string): void {
  if (!existsSync(path) || statSync(path).size <= MAX_ENGINE_LOG_BYTES) {
    return;
  }
  const previous = `${path}.1`;
  rmSync(previous, { force: true });
  renameSync(path, previous);
}
