import { MODES, type Mode } from '@local-decider/core';
import { totalmem } from 'node:os';

import { CatalogStatus, type Validation } from './catalog-status.ts';
import {
  DEVICES,
  engineDefaults,
  type Device,
  type EngineConfig,
  type GatewayConfig,
} from './config.ts';
import type { Decider } from './decider.ts';
import { DownloadError, Downloads, type Download } from './downloads.ts';
import { createEngine } from './engines/index.ts';
import { ManagedEngine, type Lifecycle, type LifecycleOptions } from './engines/lazy.ts';
import type { Engine } from './engines/types.ts';
import {
  catalogModel,
  KNOWN_MODELS,
  MEMORY_BUDGET,
  modelFits,
  modelMemoryGb,
  type CatalogEngine,
} from './models.ts';
import type { Paths } from './paths.ts';
import { loadState, saveState, type GatewayState } from './state.ts';
import {
  checkPath,
  PATH_KEYS,
  probe,
  resolveAll,
  resolveEntry,
  toolchain,
  type PathEntry,
  type PathKey,
  type Toolchain,
} from './toolchain.ts';

const SWITCHABLE_ENGINES: readonly CatalogEngine[] = ['strands-decider', 'fastflowlm'];

export interface EngineSelection {
  readonly engine: CatalogEngine;
  readonly model: string;
  /** strands-decider only; null for engines without devices. */
  readonly device: Device | null;
}

/** A switch request; without an engine or device the current ones are kept. */
export interface EngineRequest {
  readonly engine?: CatalogEngine | undefined;
  readonly model: string;
  readonly device?: Device | undefined;
}

export class EngineSwitchError extends Error {
  override readonly name = 'EngineSwitchError';
  readonly status: 400 | 403 | 409;
  constructor(status: 400 | 403 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSelection(body: unknown): EngineRequest {
  const record = isRecord(body) ? body : {};
  const { model, device, engine } = record;
  if (typeof model !== 'string' || model.length === 0 || model.length > 300) {
    throw new EngineSwitchError(400, 'expected {engine?, model, device?}');
  }
  if (engine !== undefined && !(SWITCHABLE_ENGINES as readonly unknown[]).includes(engine)) {
    throw new EngineSwitchError(400, `engine must be one of ${SWITCHABLE_ENGINES.join(', ')}`);
  }
  if (device !== undefined && !(DEVICES as readonly unknown[]).includes(device)) {
    throw new EngineSwitchError(400, `device must be one of ${DEVICES.join(', ')}`);
  }
  return {
    model,
    ...(engine === undefined ? {} : { engine: engine as CatalogEngine }),
    ...(device === undefined ? {} : { device: device as Device }),
  };
}

export function parseLifecycle(body: unknown): LifecycleOptions {
  const record = isRecord(body) ? body : {};
  const lifecycle = record['lifecycle'];
  const minutes = record['idleUnloadMinutes'] ?? 15;
  if (lifecycle !== 'lazy' && lifecycle !== 'eager') {
    throw new EngineSwitchError(400, 'lifecycle must be "lazy" or "eager"');
  }
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new EngineSwitchError(400, 'idleUnloadMinutes must be an integer 1..1440');
  }
  return { lifecycle, idleUnloadMinutes: minutes };
}

export function parseMode(body: unknown): Mode {
  const mode = isRecord(body) ? body['mode'] : undefined;
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) {
    throw new EngineSwitchError(400, `mode must be one of ${MODES.join(', ')}`);
  }
  return mode as Mode;
}

export function parsePathUpdate(body: unknown): { key: PathKey; value: string | null } {
  const record = isRecord(body) ? body : {};
  const { key, value } = record;
  if (typeof key !== 'string' || !(PATH_KEYS as readonly string[]).includes(key)) {
    throw new EngineSwitchError(400, `key must be one of ${PATH_KEYS.join(', ')}`);
  }
  if (value !== null && (typeof value !== 'string' || value.length === 0 || value.length > 1024)) {
    throw new EngineSwitchError(400, 'value must be an absolute path or null');
  }
  return { key: key as PathKey, value };
}

export interface EngineControlOptions {
  readonly config: GatewayConfig;
  readonly paths: Paths;
  readonly env?: NodeJS.ProcessEnv;
  /** False behind a token (remote mode): tool paths can't be changed over the network. */
  readonly pathsEditable?: boolean;
  /** Injected in tests. */
  readonly create?: (config: EngineConfig, paths: Paths, tools: Toolchain) => Engine;
  readonly totalMemory?: number;
  readonly installed?: (models: readonly string[]) => Promise<Map<string, boolean>>;
  readonly persist?: boolean;
}

function lifecycleFrom(config: GatewayConfig, state: GatewayState): LifecycleOptions {
  return {
    lifecycle: (state.lifecycle?.lifecycle ?? config.lifecycle.mode) as Lifecycle,
    idleUnloadMinutes: state.lifecycle?.idleUnloadMinutes ?? config.lifecycle.idleUnloadMinutes,
  };
}

/**
 * Owns the engine: which one runs (switchable at runtime between strands-decider and
 * FastFlowLM, persisted in state.json), its lifecycle (lazy or eager), tool paths, model
 * downloads and FLM validation. config.yaml stays the default the state falls back to.
 */
export class EngineControl {
  readonly switchable: boolean;
  readonly pathsEditable: boolean;
  readonly #config: GatewayConfig;
  readonly #paths: Paths;
  readonly #env: NodeJS.ProcessEnv;
  readonly #create: NonNullable<EngineControlOptions['create']>;
  readonly #memory: number;
  readonly #persist: boolean;
  readonly #installedOverride: EngineControlOptions['installed'];
  readonly #downloads = new Downloads();
  readonly #status: CatalogStatus;
  #state: GatewayState;
  #tools: Toolchain;
  #selected: EngineSelection | null;
  #engine: ManagedEngine;
  #decider: Decider | undefined;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: EngineControlOptions) {
    const { config, paths } = options;
    this.#config = config;
    this.#paths = paths;
    this.#env = options.env ?? process.env;
    this.#create = options.create ?? ((c, p, t) => createEngine(c, p, t));
    this.#memory = options.totalMemory ?? totalmem();
    this.#persist = options.persist ?? true;
    this.#installedOverride = options.installed;
    this.pathsEditable = options.pathsEditable ?? true;
    this.#state = this.#persist ? loadState(paths) : {};
    this.#tools = toolchain(config, this.#state, paths, this.#env);
    this.#status = new CatalogStatus(this.#tools, this.#hfCache());
    this.switchable = config.engine.type !== 'systemone-remote' && config.engine.url === undefined;
    this.#selected = this.switchable ? this.#initialSelection() : null;
    this.#engine = this.#build(this.#selected);
  }

  /** The engine to serve; replaced on every switch. */
  get engine(): ManagedEngine {
    return this.#engine;
  }

  bind(decider: Decider): void {
    this.#decider = decider;
    for (const [id, mode] of Object.entries(this.#state.policyModes ?? {})) {
      decider.setMode(id, mode);
    }
    if (this.#tools.flm !== undefined) {
      void this.#status.validate('fastflowlm');
    }
  }

  current(): EngineSelection | null {
    return this.#selected;
  }

  allowedModels(engine?: CatalogEngine): string[] {
    const configured =
      engine === undefined || engine === this.#config.engine.type
        ? [this.#config.engine.model]
        : [];
    const known = KNOWN_MODELS.filter((m) => engine === undefined || m.engine === engine).map(
      (m) => m.id,
    );
    return [...new Set([...known, ...configured])];
  }

  /** Resolves when no switch is stopping an engine. */
  idle(): Promise<void> {
    return this.#pending;
  }

  async select(request: EngineRequest): Promise<EngineSelection> {
    const current = this.#requireSwitchable();
    const engine = request.engine ?? current.engine;
    const next: EngineSelection = {
      engine,
      model: request.model,
      device: engine === 'strands-decider' ? (request.device ?? current.device ?? 'auto') : null,
    };
    await this.#checkSelectable(next);
    const run = this.#pending.then(() => this.#apply(next, false));
    this.#pending = run.catch(() => undefined);
    await run;
    return next;
  }

  // fallow-ignore-next-line unused-class-member -- called through the CONTROL_ROUTES table
  async load(): Promise<void> {
    void this.#engine.load();
  }

  // fallow-ignore-next-line unused-class-member -- called through the CONTROL_ROUTES table
  async unload(): Promise<void> {
    await this.#engine.unload();
  }

  /** Run a policy `off`, in `shadow` (log only) or `act` (adapters may enforce); persisted. */
  setPolicyMode(id: string, mode: Mode): void {
    if (this.#decider === undefined || !this.#decider.setMode(id, mode)) {
      throw new EngineSwitchError(400, `unknown policy "${id}"`);
    }
    this.#save({ ...this.#state, policyModes: { ...this.#state.policyModes, [id]: mode } });
  }

  setLifecycle(options: LifecycleOptions): LifecycleOptions {
    this.#engine.setLifecycle(options);
    this.#save({ ...this.#state, lifecycle: options });
    return options;
  }

  async setPath(key: PathKey, value: string | null): Promise<PathEntry> {
    if (!this.pathsEditable) {
      throw new EngineSwitchError(403, 'tool paths can only be changed on a loopback gateway');
    }
    if (value !== null) {
      await this.#checkPathValue(key, value);
    }
    const paths = { ...this.#state.paths };
    if (value === null) {
      delete paths[key];
    } else {
      paths[key] = value;
    }
    this.#save({ ...this.#state, paths });
    this.#tools = toolchain(this.#config, this.#state, this.#paths, this.#env);
    this.#status.reset(this.#tools, this.#hfCache());
    if (this.#selected !== null) {
      const sel = this.#selected;
      this.#pending = this.#pending.then(() => this.#apply(sel, true)).catch(() => undefined);
    }
    return resolveEntry(key, this.#config, this.#state, this.#paths, this.#env);
  }

  download(engine: string, model: string): Download {
    const entry = catalogModel(model);
    if (entry === undefined || entry.engine !== engine) {
      throw new DownloadError(400, `unknown ${engine} model "${model}"`);
    }
    return this.#downloads.start(entry, this.#tools, () => this.#status.invalidate());
  }

  validate(engine: string): Promise<Validation> {
    if (engine !== 'fastflowlm') {
      throw new EngineSwitchError(400, 'only fastflowlm can be validated');
    }
    return this.#status.validate('fastflowlm');
  }

  /** The `GET /v1/engines` view. */
  async status(): Promise<Record<string, unknown>> {
    const installed = await this.#installed(KNOWN_MODELS.map((m) => m.id));
    const health = this.#engine.health();
    const life = this.#engine.lifecycle;
    return {
      active: {
        engine: this.#engine.id,
        model: this.#engine.model,
        device: this.#selected?.device ?? null,
        state: health.state,
        detail: health.detail ?? null,
        lifecycle: life.lifecycle,
        idleUnloadMinutes: life.idleUnloadMinutes,
        lastUsedAt: this.#engine.lastUsedAt,
      },
      switchable: this.switchable,
      totalMemoryGb: Math.round(this.#memory / 1e9),
      engines: this.#engines(),
      models: KNOWN_MODELS.map((m) => ({
        id: m.id,
        engine: m.engine,
        label: m.label,
        downloadGb: m.downloadGb,
        memoryGb: modelMemoryGb(m, this.#selected?.device),
        cpuMemoryGb: m.memoryGb,
        gpuMemoryGb: m.gpuMemoryGb ?? null,
        fits: modelFits(m.id, this.#memory, this.#selected?.device),
        quality: m.quality ?? null,
        source: m.source ?? null,
        installed: installed.get(m.id) ?? false,
        latencyHint: m.latencyHint,
        recommended: m.recommended === true,
      })),
      downloads: this.#downloads.list(),
      paths: resolveAll(this.#config, this.#state, this.#paths, this.#env),
      pathsEditable: this.pathsEditable,
    };
  }

  #engines(): Record<string, unknown>[] {
    const validation = this.#status.validation ?? null;
    const flmInstalled = this.#tools.flm !== undefined;
    const strandsInstalled = this.#tools.strandsDecider !== undefined;
    return [
      {
        id: 'strands-decider',
        label: 'Strands Decider (PyTorch)',
        installed: strandsInstalled,
        available: strandsInstalled,
        detail: strandsInstalled
          ? this.#tools.strandsDecider
          : 'not installed; run `local-decider engine install`',
        devices: [...DEVICES],
        validation: null,
      },
      {
        id: 'fastflowlm',
        label: 'FastFlowLM (AMD NPU)',
        installed: flmInstalled,
        available: flmInstalled && validation?.ok !== false,
        detail: flmInstalled
          ? (this.#status.flmVersion ?? this.#tools.flm)
          : 'not installed; run `local-decider engine install --engine fastflowlm`',
        devices: [],
        validation,
      },
    ];
  }

  #initialSelection(): EngineSelection {
    const engine = this.#config.engine;
    const fromConfig: EngineSelection = {
      engine: engine.type as CatalogEngine,
      model: engine.model,
      device: engine.type === 'strands-decider' ? engine.device : null,
    };
    const saved = this.#state.selection;
    const savedEngine = saved?.engine as CatalogEngine | undefined;
    if (
      saved === undefined ||
      savedEngine === undefined ||
      !SWITCHABLE_ENGINES.includes(savedEngine)
    ) {
      return fromConfig;
    }
    if (!this.allowedModels(savedEngine).includes(saved.model)) {
      return fromConfig;
    }
    const device = (DEVICES as readonly string[]).includes(saved.device ?? '')
      ? (saved.device as Device)
      : 'auto';
    return {
      engine: savedEngine,
      model: saved.model,
      device: savedEngine === 'strands-decider' ? device : null,
    };
  }

  #engineConfig(sel: EngineSelection): EngineConfig {
    const base =
      this.#config.engine.type === sel.engine ? this.#config.engine : engineDefaults(sel.engine);
    if (base.type === 'strands-decider') {
      return { ...base, model: sel.model, device: sel.device ?? base.device };
    }
    return { ...base, model: sel.model };
  }

  #build(sel: EngineSelection | null): ManagedEngine {
    const config = sel === null ? this.#config.engine : this.#engineConfig(sel);
    const inner = this.#create(config, this.#paths, this.#tools);
    const life =
      sel === null
        ? { lifecycle: 'eager' as const, idleUnloadMinutes: 15 }
        : lifecycleFrom(this.#config, this.#state);
    return new ManagedEngine(inner, life);
  }

  #requireSwitchable(): EngineSelection {
    if (!this.switchable || this.#selected === null) {
      throw new EngineSwitchError(409, 'this engine cannot switch models at runtime');
    }
    return this.#selected;
  }

  async #checkSelectable(next: EngineSelection): Promise<void> {
    if (!this.allowedModels(next.engine).includes(next.model)) {
      throw new EngineSwitchError(400, `unknown ${next.engine} model "${next.model}"`);
    }
    if (!modelFits(next.model, this.#memory, next.device)) {
      const known = catalogModel(next.model);
      const needs = known === undefined ? 0 : modelMemoryGb(known, next.device);
      const budget = Math.floor((this.#memory * MEMORY_BUDGET) / 1e9);
      throw new EngineSwitchError(
        409,
        `${next.model} needs ~${String(needs)} GB; this machine allows ~${String(budget)} GB for the decision model`,
      );
    }
    const engineInfo = this.#engines().find((e) => e['id'] === next.engine);
    if (engineInfo?.['available'] !== true) {
      throw new EngineSwitchError(
        409,
        `${next.engine} is not available: ${String(engineInfo?.['detail'])}`,
      );
    }
    const unchanged = this.#same(next);
    const installed = (await this.#installed([next.model])).get(next.model) ?? false;
    if (!unchanged && catalogModel(next.model) !== undefined && !installed) {
      throw new EngineSwitchError(400, `${next.model} is not downloaded yet`);
    }
  }

  #same(next: EngineSelection): boolean {
    const cur = this.#selected;
    return (
      cur !== null &&
      cur.engine === next.engine &&
      cur.model === next.model &&
      cur.device === next.device
    );
  }

  /** Swap engines: stop the old one first so two models never share memory. */
  async #apply(next: EngineSelection, force: boolean): Promise<void> {
    if (!force && this.#same(next)) {
      return;
    }
    const engine = this.#build(next);
    const previous = this.#engine;
    this.#engine = engine;
    this.#selected = next;
    this.#decider?.replaceEngine(engine);
    this.#save({
      ...this.#state,
      selection: {
        engine: next.engine,
        model: next.model,
        ...(next.device === null ? {} : { device: next.device }),
      },
    });
    await previous.stop().catch(() => undefined);
    void engine.start();
  }

  async #installed(models: readonly string[]): Promise<Map<string, boolean>> {
    if (this.#installedOverride !== undefined) {
      return this.#installedOverride(models);
    }
    const entries = models.map((id) => catalogModel(id)).filter((m) => m !== undefined);
    return this.#status.installed(entries);
  }

  async #checkPathValue(key: PathKey, value: string): Promise<void> {
    const problem = checkPath(key, value);
    if (problem !== undefined) {
      throw new EngineSwitchError(400, problem);
    }
    const args = key === 'tools.flm' ? ['version'] : key === 'tools.uv' ? ['--version'] : undefined;
    if (args !== undefined) {
      await probe(value, args, {}, 10_000).catch((error: unknown) => {
        throw new EngineSwitchError(400, `${value} did not run: ${(error as Error).message}`);
      });
    }
  }

  #hfCache(): string {
    return (
      resolveEntry('dirs.hfCache', this.#config, this.#state, this.#paths, this.#env).effective ??
      ''
    );
  }

  #save(state: GatewayState): void {
    this.#state = state;
    if (this.#persist) {
      saveState(this.#paths, state);
    }
  }
}
