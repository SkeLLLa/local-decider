import { totalmem } from 'node:os';

import { DEVICES, type Device, type EngineConfig, type StrandsEngineConfig } from './config.ts';
import type { Decider } from './decider.ts';
import { createEngine } from './engines/index.ts';
import type { Engine } from './engines/types.ts';
import { KNOWN_MODELS, MEMORY_BUDGET, modelFits } from './models.ts';
import type { Paths } from './paths.ts';

export interface EngineSelection {
  readonly model: string;
  readonly device: Device;
}

/** A switch request; without a device the current one is kept. */
export interface EngineRequest {
  readonly model: string;
  readonly device?: Device | undefined;
}

export class EngineSwitchError extends Error {
  override readonly name = 'EngineSwitchError';
  readonly status: 400 | 409;
  constructor(status: 400 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Runtime model switching for a spawned strands-decider engine (`POST /v1/engine`). The choice
 * lasts until the gateway restarts; `config.yaml` stays the source of truth. Only models from
 * `KNOWN_MODELS` or the configured one are accepted, so a request never puts an arbitrary
 * string on the `serve` command line.
 */
export interface EngineControl {
  /** False for a remote engine or a strands engine attached to `engine.url`. */
  readonly switchable: boolean;
  current(): EngineSelection | null;
  allowedModels(): readonly string[];
  /** Resolves once the new engine is installed; loading continues in the background. */
  select(request: EngineRequest): Promise<EngineSelection>;
  /** Resolves when no switch is stopping an engine. */
  idle(): Promise<void>;
}

export interface EngineControlOptions {
  readonly config: EngineConfig;
  readonly paths: Paths;
  readonly decider: Decider;
  /** Injected in tests. */
  readonly create?: (config: StrandsEngineConfig, paths: Paths) => Engine;
  /** Physical memory in bytes; injected in tests. */
  readonly totalMemory?: number;
}

export function parseSelection(body: unknown): EngineRequest {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const model = record['model'];
  const device = record['device'];
  if (typeof model !== 'string' || model.length === 0 || model.length > 300) {
    throw new EngineSwitchError(400, 'expected {model, device?}');
  }
  if (device === undefined) {
    return { model };
  }
  if (typeof device !== 'string' || !(DEVICES as readonly string[]).includes(device)) {
    throw new EngineSwitchError(400, `device must be one of ${DEVICES.join(', ')}`);
  }
  return { model, device: device as Device };
}

export function createEngineControl(options: EngineControlOptions): EngineControl {
  const { config, paths, decider } = options;
  if (config.type !== 'strands-decider' || config.url !== undefined) {
    return {
      switchable: false,
      current: () => null,
      allowedModels: () => [],
      select: async () => {
        throw new EngineSwitchError(409, 'this engine cannot switch models at runtime');
      },
      idle: async () => {},
    };
  }
  const strands: StrandsEngineConfig = config;
  const create = options.create ?? ((c: StrandsEngineConfig, p: Paths) => createEngine(c, p));
  const memory = options.totalMemory ?? totalmem();
  const allowed = [...new Set([...KNOWN_MODELS.map((m) => m.id), config.model])];
  let selected: EngineSelection = { model: config.model, device: config.device };
  let pending: Promise<void> = Promise.resolve();

  function apply(next: EngineSelection): Promise<void> {
    if (next.model === selected.model && next.device === selected.device) {
      return Promise.resolve();
    }
    const engine = create({ ...strands, model: next.model, device: next.device }, paths);
    const previous = decider.replaceEngine(engine);
    selected = next;
    // Stop first so two models never share memory. Loading can take minutes; /health reports
    // `degraded` until the new model answers, and nobody waits for it.
    return previous
      .stop()
      .catch(() => undefined)
      .then(() => {
        void engine.start();
      });
  }

  return {
    switchable: true,
    current: () => selected,
    allowedModels: () => allowed,
    async select(request) {
      if (!allowed.includes(request.model)) {
        throw new EngineSwitchError(400, `unknown model "${request.model}"`);
      }
      if (!modelFits(request.model, memory)) {
        const needs = KNOWN_MODELS.find((m) => m.id === request.model)?.memoryGb ?? 0;
        throw new EngineSwitchError(
          409,
          `${request.model} needs ~${String(needs)} GB; this machine allows ~${String(Math.floor((memory * MEMORY_BUDGET) / 1e9))} GB for the decision model`,
        );
      }
      // One switch at a time: a later request waits until the earlier one stopped its engine.
      const run = pending.then(() => {
        const next = { model: request.model, device: request.device ?? selected.device };
        return { next, stopped: apply(next) };
      });
      pending = run.then(async ({ stopped }) => stopped).catch(() => undefined);
      return (await run).next;
    },
    idle: async () => pending,
  };
}
