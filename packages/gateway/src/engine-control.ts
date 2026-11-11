import { MODES, PolicyError, type Mode, type PolicyThreshold } from '@local-decider/core';
import { mkdirSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';

import { authoringPrompt } from './authoring.ts';
import { CatalogStatus, type Validation } from './catalog-status.ts';
import type { ConfigEdit, ConfigStore } from './config-file.ts';
import {
  DEVICES,
  engineDefaults,
  type Device,
  type EngineConfig,
  type GatewayConfig,
  type PresetTarget,
} from './config.ts';
import type { Decider } from './decider.ts';
import { DownloadError, Downloads, type Download } from './downloads.ts';
import {
  discoveryEndpoint,
  isOpenAILike,
  ModelDiscovery,
  OPENAI_LIKE_ENGINES,
  type DiscoveryEndpoint,
  type OpenAILikeEngine,
} from './engine-discovery.ts';
import type {
  EngineContext,
  EngineDescriptor,
  HostInfo,
  ModelDescriptor,
} from './engines/descriptor.ts';
import { cachedFlmVersion } from './engines/fastflowlm/status.ts';
import { hostInfo } from './engines/host.ts';
import { createEngine } from './engines/index.ts';
import { ManagedEngine, type LifecycleOptions } from './engines/lazy.ts';
import {
  allModels,
  ENGINES,
  engineDescriptor,
  SELECTABLE_IDS,
  type EngineId,
} from './engines/registry.ts';
import type { Engine } from './engines/types.ts';
import { catalogModel, MEMORY_BUDGET, modelFits, modelMemoryGb } from './models.ts';
import type { Paths } from './paths.ts';
import { loadPolicies, policyDirs, scopeModes, type LoadedPolicy } from './policies.ts';
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

const SWITCHABLE_ENGINES: readonly EngineId[] = SELECTABLE_IDS;

export interface EngineSelection {
  readonly engine: EngineId;
  readonly model: string;
  /** strands-decider only; null for engines without devices. */
  readonly device: Device | null;
}

/** A switch request; without an engine or device the current ones are kept. */
export interface EngineRequest {
  readonly engine?: EngineId | undefined;
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
    ...(engine === undefined ? {} : { engine: engine as EngineId }),
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

export function parseVariant(body: unknown): string {
  const variant = isRecord(body) ? body['variant'] : undefined;
  if (typeof variant !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(variant)) {
    throw new EngineSwitchError(400, 'variant must be a policy id');
  }
  return variant;
}

const MAX_THRESHOLDS = 64;

/** `{ thresholds: { "<question>.<answer>": 0..1 | null } }`; null removes an override. */
export function parseThresholds(body: unknown): Record<string, number | null> {
  const thresholds = isRecord(body) ? body['thresholds'] : undefined;
  if (!isRecord(thresholds)) {
    throw new EngineSwitchError(400, 'thresholds must be an object of "<question>.<answer>": 0..1');
  }
  const entries = Object.entries(thresholds);
  if (entries.length === 0 || entries.length > MAX_THRESHOLDS) {
    throw new EngineSwitchError(400, `thresholds needs 1..${MAX_THRESHOLDS} entries`);
  }
  for (const [key, value] of entries) {
    const valid =
      value === null ||
      (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
    if (!valid) {
      throw new EngineSwitchError(400, `threshold "${key}" must be a number 0..1 or null`);
    }
  }
  return Object.fromEntries(entries) as Record<string, number | null>;
}

/** Every key must name a rule of the policy, and an `allow` rule's value must reach its floor. */
function checkThresholds(
  id: string,
  rules: readonly PolicyThreshold[],
  thresholds: Readonly<Record<string, number | null>>,
): void {
  const floors = new Map(rules.map((t) => [t.key, t.floor]));
  const unknown = Object.keys(thresholds).filter((key) => !floors.has(key));
  if (unknown.length > 0) {
    const names = unknown.map((k) => `"${k}"`).join(', ');
    const known = [...floors.keys()].join(', ') || 'no rules';
    throw new EngineSwitchError(400, `policy "${id}" has no rule for ${names}; it has ${known}`);
  }
  for (const [key, value] of Object.entries(thresholds)) {
    const floor = floors.get(key) ?? 0;
    if (value !== null && value < floor) {
      throw new EngineSwitchError(
        400,
        `"${key}" auto-allows, so its threshold must be at least ${String(floor)}`,
      );
    }
  }
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
  /** Where settings are read and every settings-page change is written (config.yaml). */
  readonly store: ConfigStore;
  readonly paths: Paths;
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: HostInfo;
  /** False behind a token (remote mode): tool paths can't be changed over the network. */
  readonly pathsEditable?: boolean;
  /** Injected in tests. */
  readonly create?: (config: EngineConfig, paths: Paths, tools: Toolchain) => Engine;
  readonly totalMemory?: number;
  readonly installed?: (models: readonly string[]) => Promise<Map<string, boolean>>;
  /** Injected in tests: model discovery requests. */
  readonly fetch?: typeof fetch;
}

function lifecycleFrom(config: GatewayConfig): LifecycleOptions {
  return {
    lifecycle: config.lifecycle.mode,
    idleUnloadMinutes: config.lifecycle.idleUnloadMinutes,
  };
}

/** The settings a policy reload depends on. */
function policiesKey(config: GatewayConfig): string {
  return JSON.stringify([config.policies, config.policyDirs]);
}

/** Settings that only take effect when the gateway starts. */
function startupKey(config: GatewayConfig): string {
  return JSON.stringify([config.host, config.port, config.engine, config.decisionTimeoutMs]);
}

/**
 * Owns the engine: which one runs (switchable at runtime between strands-decider and
 * FastFlowLM), its lifecycle (lazy or eager), tool paths, model downloads and FLM validation,
 * and policy modes, variants and rule thresholds. Every change is written to config.yaml, and a changed
 * config.yaml is applied with `applyConfig`.
 */
export class EngineControl {
  readonly switchable: boolean;
  readonly pathsEditable: boolean;
  readonly #store: ConfigStore;
  readonly #paths: Paths;
  readonly #env: NodeJS.ProcessEnv;
  readonly #host: HostInfo;
  readonly #create: NonNullable<EngineControlOptions['create']>;
  readonly #memory: number;
  readonly #installedOverride: EngineControlOptions['installed'];
  readonly #downloads = new Downloads();
  readonly #status: CatalogStatus;
  /** The config last applied, to tell what an edit of config.yaml changed. */
  #applied: GatewayConfig;
  #tools: Toolchain;
  #selected: EngineSelection | null;
  #engine: ManagedEngine;
  readonly #discovery: ModelDiscovery;
  #decider: Decider | undefined;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: EngineControlOptions) {
    const { store, paths } = options;
    const config = store.current;
    this.#store = store;
    this.#applied = config;
    this.#paths = paths;
    this.#env = options.env ?? process.env;
    this.#discovery = new ModelDiscovery(this.#env, options.fetch);
    this.#host = options.host ?? hostInfo();
    this.#create = options.create ?? ((c, p, t) => createEngine(c, p, t));
    this.#memory = options.totalMemory ?? totalmem();
    this.#installedOverride = options.installed;
    this.pathsEditable = options.pathsEditable ?? true;
    this.#tools = toolchain(config, paths, this.#env);
    this.#status = new CatalogStatus(this.#context());
    this.switchable =
      config.engine.type !== 'systemone-remote' &&
      (isOpenAILike(config.engine.type) || config.engine.url === undefined);
    this.#selected = this.switchable ? this.#initialSelection() : null;
    this.#engine = this.#build(this.#selected);
  }

  get #config(): GatewayConfig {
    return this.#store.current;
  }

  /** The settings in effect (config.yaml with the settings pages' changes). */
  get settings(): GatewayConfig {
    return this.#store.current;
  }

  /** The engine to serve; replaced on every switch. */
  get engine(): ManagedEngine {
    return this.#engine;
  }

  bind(decider: Decider): void {
    this.#decider = decider;
    this.#applyPolicyState(decider);
    if (this.#tools.flm !== undefined) {
      void this.#status.validate('fastflowlm');
    }
  }

  current(): EngineSelection | null {
    return this.#selected;
  }

  activeTag(): string {
    return this.#tag(this.#engine.id as EngineId);
  }

  allowedModels(engine?: EngineId): string[] {
    const configured = new Set<string>();
    if (engine === undefined || engine === this.#config.engine.type) {
      configured.add(this.#config.engine.model);
    }
    for (const id of OPENAI_LIKE_ENGINES) {
      if (engine !== undefined && engine !== id) {
        continue;
      }
      const endpoint = this.#endpoint(id);
      if (endpoint !== undefined) {
        configured.add(endpoint.model);
        for (const model of this.#discovery.models(id, endpoint)) {
          configured.add(model);
        }
      }
    }
    const known = allModels()
      .filter((model) => engine === undefined || model.engine === engine)
      .map((model) => model.id);
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
    this.#save([{ path: ['policies', id, 'mode'], value: mode }]);
    this.#applied = { ...this.#applied, policies: this.#config.policies };
  }

  /** Answer policy `id` with policy `variant` (`id` itself = the default); persisted. */
  setPolicyVariant(id: string, variant: string): void {
    if (this.#decider === undefined || !this.#decider.setVariant(id, variant)) {
      throw new EngineSwitchError(400, `"${variant}" is not a variant of policy "${id}"`);
    }
    this.#save([
      { path: ['policies', id, 'variant'], value: variant === id ? undefined : variant },
    ]);
    this.#applied = { ...this.#applied, policies: this.#config.policies };
  }

  /**
   * Override rule thresholds of policy `id` by `<question>.<answer>` (null restores the file's
   * value); every key must name one of its rules. Persisted; returns the thresholds in effect.
   */
  setPolicyThresholds(
    id: string,
    thresholds: Readonly<Record<string, number | null>>,
  ): PolicyThreshold[] {
    const decider = this.#decider;
    if (decider?.policies.get(id) === undefined) {
      throw new EngineSwitchError(400, `unknown policy "${id}"`);
    }
    checkThresholds(id, decider.thresholdsOf(id), thresholds);
    this.#save(
      Object.entries(thresholds).map(([key, value]) => ({
        path: ['policies', id, 'thresholds', key],
        value: value ?? undefined,
      })),
    );
    decider.setThresholds(id, this.#savedThresholds(id));
    this.#applied = { ...this.#applied, policies: this.#config.policies };
    return decider.thresholdsOf(id);
  }

  #savedThresholds(id: string): Readonly<Record<string, number>> {
    const { policies } = this.#config;
    return (Object.hasOwn(policies, id) ? policies[id]?.thresholds : undefined) ?? {};
  }

  /** Where the settings live and what they are, for `GET /v1/config`. */
  // fallow-ignore-next-line unused-class-member -- called through the settings-routes table
  describeSettings(): Record<string, unknown> {
    const schemas = join(this.#paths.config, 'schemas');
    return {
      file: this.#store.file ?? null,
      schemas: {
        config: join(schemas, 'config.schema.json'),
        policy: join(schemas, 'policy.schema.json'),
      },
      policyDir: join(this.#paths.config, 'policies'),
      config: this.#config,
    };
  }

  /** Re-read config.yaml after an outside edit and apply it. */
  async reloadConfig(): Promise<{ changed: boolean; notes: string[] }> {
    let changed: boolean;
    try {
      changed = this.#store.reload?.() ?? false;
    } catch (error) {
      throw new EngineSwitchError(400, error instanceof Error ? error.message : String(error));
    }
    return { changed, notes: await this.applyConfig() };
  }

  /** The authoring prompt for a variant of policy `id`, and the directory an agent should work in. */
  // fallow-ignore-next-line unused-class-member -- called through the settings-routes table
  policyPrompt(
    id: string,
    policies: ReadonlyMap<string, LoadedPolicy>,
  ): { prompt: string; cwd: string } {
    let prompt: string;
    try {
      prompt = authoringPrompt(id, policies, this.#paths);
    } catch (error) {
      throw new EngineSwitchError(400, error instanceof Error ? error.message : String(error));
    }
    mkdirSync(join(this.#paths.config, 'policies'), { recursive: true, mode: 0o700 });
    return { prompt, cwd: this.#paths.config };
  }

  /** Point `preset` at `target` for `harness`, or remove it with null; persisted. */
  setRoutingPreset(harness: string, preset: string, target: PresetTarget | null): void {
    // Presets pick the model and mode of new local agents: not from a remote client.
    if (!this.pathsEditable) {
      throw new EngineSwitchError(403, 'routing presets can only be changed on a loopback gateway');
    }
    this.#save([{ path: ['routing', 'presets', harness, preset], value: target ?? undefined }]);
  }

  /** Re-read the policy directories, e.g. after adding a policy; saved modes and variants stay. */
  reloadPolicies(): string[] {
    if (this.#decider === undefined) {
      throw new EngineSwitchError(409, 'the gateway has no policies to reload');
    }
    let next: ReturnType<typeof loadPolicies>;
    try {
      next = loadPolicies(this.#config, policyDirs(this.#config, this.#paths));
    } catch (error) {
      throw new EngineSwitchError(
        400,
        error instanceof PolicyError ? error.message : String(error),
      );
    }
    this.#decider.replacePolicies(next);
    this.#applyPolicyState(this.#decider);
    return [...next.keys()];
  }

  /**
   * Modes come with the loaded policies (config.yaml beats the file). Variants are set for every
   * base policy, so one removed from config.yaml goes back to the default; thresholds likewise
   * for every policy.
   */
  #applyPolicyState(decider: Decider): void {
    const { policies } = this.#config;
    for (const { policy } of decider.policies.values()) {
      const settings = Object.hasOwn(policies, policy.id) ? policies[policy.id] : undefined;
      if (settings?.mode !== undefined) {
        decider.setMode(policy.id, settings.mode);
      }
      decider.setScopeModes(policy.id, scopeModes(settings));
      if (policy.variantOf === undefined) {
        decider.setVariant(policy.id, settings?.variant ?? policy.id);
      }
      decider.setThresholds(policy.id, settings?.thresholds ?? {});
    }
  }

  setLifecycle(options: LifecycleOptions): LifecycleOptions {
    this.#engine.setLifecycle(options);
    this.#save([
      { path: ['lifecycle', 'mode'], value: options.lifecycle },
      { path: ['lifecycle', 'idleUnloadMinutes'], value: options.idleUnloadMinutes },
    ]);
    return options;
  }

  /**
   * Apply a config.yaml that changed on disk: policies, lifecycle, tool paths and the engine
   * selection take effect now. Returns what needs a restart instead (empty when nothing).
   */
  async applyConfig(): Promise<string[]> {
    const previous = this.#applied;
    const config = this.#config;
    const notes = this.#applyPolicies(previous, config);
    // A failed policy reload is retried with the next change.
    this.#applied = notes.length === 0 ? config : { ...config, policies: previous.policies };
    if (JSON.stringify(previous.lifecycle) !== JSON.stringify(config.lifecycle)) {
      this.#engine.setLifecycle(lifecycleFrom(config));
    }
    const toolsChanged =
      JSON.stringify([previous.tools, previous.dirs]) !==
      JSON.stringify([config.tools, config.dirs]);
    if (toolsChanged) {
      this.#retool();
    }
    await this.#applySelectionConfig(previous, config);
    return startupKey(previous) === startupKey(config)
      ? notes
      : [...notes, 'host, port, engine or decisionTimeoutMs changed: restart the gateway to apply'];
  }

  /** Re-read policies when their settings or directories changed; problems become notes. */
  #applyPolicies(previous: GatewayConfig, config: GatewayConfig): string[] {
    if (this.#decider === undefined) {
      return [];
    }
    if (policiesKey(previous) === policiesKey(config)) {
      // Cheap, and catches choices a settings-page save made since the last apply.
      this.#applyPolicyState(this.#decider);
      return [];
    }
    try {
      this.reloadPolicies();
      return [];
    } catch (error) {
      this.#applyPolicyState(this.#decider);
      return [`policies not reloaded: ${error instanceof Error ? error.message : String(error)}`];
    }
  }

  /** Rebuild the toolchain from the config and restart the engine on it. */
  #retool(): void {
    this.#tools = toolchain(this.#config, this.#paths, this.#env);
    this.#status.reset(this.#context());
    if (this.#selected !== null) {
      const sel = this.#selected;
      this.#pending = this.#pending.then(() => this.#apply(sel, true)).catch(() => undefined);
    }
  }

  async setPath(key: PathKey, value: string | null): Promise<PathEntry> {
    if (!this.pathsEditable) {
      throw new EngineSwitchError(403, 'tool paths can only be changed on a loopback gateway');
    }
    if (value !== null) {
      await this.#checkPathValue(key, value);
    }
    this.#save([{ path: key.split('.'), value: value ?? undefined }]);
    this.#applied = this.#config;
    this.#retool();
    return resolveEntry(key, this.#config, this.#paths, this.#env);
  }

  download(engine: string, model: string): Download {
    const entry = catalogModel(model, engine as EngineId);
    if (entry === undefined) {
      throw new DownloadError(400, `unknown ${engine} model "${model}"`);
    }
    return this.#downloads.start(entry, this.#context(), () => this.#status.invalidate());
  }

  validate(engine: string): Promise<Validation> {
    const descriptor = engineDescriptor(engine);
    if (descriptor?.validation === undefined) {
      throw new EngineSwitchError(400, `${engine} does not support validation`);
    }
    return this.#status.validate(descriptor.id);
  }

  /** The `GET /v1/engines` view. */
  async status(): Promise<Record<string, unknown>> {
    await this.#discoverAll();
    const models = this.#catalogModels();
    const installed = await this.#installed(models);
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
      models: models.map((m) => ({
        id: m.id,
        engine: m.engine,
        label: m.label,
        downloadGb: m.downloadGb,
        memoryGb: modelMemoryGb(m, this.#selected?.device),
        cpuMemoryGb: m.memoryGb,
        gpuMemoryGb: m.gpuMemoryGb ?? null,
        fits: modelFits(m.id, this.#memory, this.#selected?.device, m.engine),
        quality: m.quality ?? null,
        source: m.source ?? null,
        installed: installed.get(m.id) ?? false,
        latencyHint: m.latencyHint,
        recommended: m.recommended === true,
      })),
      downloads: this.#downloads.list(),
      paths: resolveAll(this.#config, this.#paths, this.#env, this.#host),
      pathsEditable: this.pathsEditable,
    };
  }

  #engines(): Record<string, unknown>[] {
    const validation = this.#status.validation ?? null;
    const flmInstalled = this.#tools.flm !== undefined;
    const strandsInstalled = this.#tools.strandsDecider !== undefined;
    const details: Record<string, unknown>[] = [
      {
        id: 'strands-decider',
        installed: strandsInstalled,
        available: strandsInstalled,
        detail: strandsInstalled
          ? this.#tools.strandsDecider
          : 'not installed; run `local-decider engine install`',
        validation: null,
      },
      {
        id: 'fastflowlm',
        installed: flmInstalled,
        available: flmInstalled && validation?.ok !== false,
        detail: flmInstalled
          ? (cachedFlmVersion(this.#tools.flm) ?? this.#tools.flm)
          : 'not installed; run `local-decider engine install --engine fastflowlm`',
        validation,
      },
      {
        id: 'openai-compatible',
        installed: this.#endpoint('openai-compatible') !== undefined,
        available: this.#endpoint('openai-compatible') !== undefined,
        detail:
          this.#endpoint('openai-compatible') === undefined
            ? 'set engines.openai-compatible.url/model'
            : this.#endpoint('openai-compatible')?.url,
        validation: null,
      },
    ];
    return ENGINES.filter((engine) => engine.selectable).map((engine) => {
      const support = engine.supports(this.#host);
      const existing = details.find((entry) => entry['id'] === engine.id);
      return {
        id: engine.id,
        label: engine.label,
        description: engine.description,
        tag: this.#tag(engine.id),
        calibrated: engine.calibrated,
        capabilities: { validate: engine.validation !== undefined },
        installed: existing?.['installed'] ?? false,
        available: existing?.['available'] ?? false,
        detail: existing?.['detail'] ?? null,
        devices: [...(engine.devices?.(this.#host) ?? [])],
        validation: existing?.['validation'] ?? null,
        supported: support.ok,
        ...(support.ok ? {} : { unsupportedReason: support.reason }),
      };
    });
  }

  #initialSelection(): EngineSelection {
    const engine = this.#config.engine;
    const fromConfig: EngineSelection = {
      engine: engine.type,
      model: engine.model,
      device: engine.type === 'strands-decider' ? engine.device : null,
    };
    const saved = this.#config.selection;
    const savedEngine = saved?.engine;
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

  #endpoint(id: OpenAILikeEngine): DiscoveryEndpoint | undefined {
    return discoveryEndpoint(id, this.#config);
  }

  #catalogModels(): ModelDescriptor<EngineId>[] {
    const models = allModels();
    for (const id of OPENAI_LIKE_ENGINES) {
      const endpoint = this.#endpoint(id);
      if (endpoint === undefined) {
        continue;
      }
      const found = this.#discovery.models(id, endpoint);
      const ids = found.length > 0 ? found : [endpoint.model];
      models.push(
        ...ids.map((model) => ({
          id: model,
          engine: id,
          label: model,
          downloadGb: null,
          memoryGb: null,
          latencyHint: null,
        })),
      );
    }
    return models;
  }

  async #discoverAll(): Promise<void> {
    await Promise.all(OPENAI_LIKE_ENGINES.map(async (id) => this.#discover(id)));
  }

  async #discover(id: OpenAILikeEngine): Promise<void> {
    await this.#discovery.refresh(id, this.#endpoint(id));
  }

  #engineConfig(sel: EngineSelection): EngineConfig {
    const base =
      this.#config.engine.type === sel.engine
        ? this.#config.engine
        : engineDefaults(sel.engine, sel.model, this.#config.engines?.[sel.engine]);
    if (base.type === 'strands-decider') {
      return { ...base, model: sel.model, device: sel.device ?? base.device };
    }
    return { ...base, model: sel.model };
  }

  #tag(id: EngineId): string {
    try {
      const descriptor = engineDescriptor(id);
      if (descriptor === undefined) {
        return id;
      }
      const typed = descriptor as EngineDescriptor<EngineConfig>;
      return typed.tag(this.#engineConfigFor(id), this.#host);
    } catch {
      return id;
    }
  }

  #engineConfigFor(id: EngineId): EngineConfig {
    if (this.#selected?.engine === id) {
      return this.#engineConfig(this.#selected);
    }
    if (this.#config.engine.type === id) {
      return this.#config.engine;
    }
    return engineDefaults(id, undefined, this.#config.engines?.[id]);
  }

  async #applySelectionConfig(previous: GatewayConfig, config: GatewayConfig): Promise<void> {
    const wanted = this.switchable ? this.#initialSelection() : null;
    if (wanted === null) {
      return;
    }
    if (!this.#same(wanted)) {
      await this.select({
        engine: wanted.engine,
        model: wanted.model,
        ...(wanted.device === null ? {} : { device: wanted.device }),
      });
      return;
    }
    const optionsChanged =
      JSON.stringify(previous.engines?.[wanted.engine]) !==
      JSON.stringify(config.engines?.[wanted.engine]);
    if (optionsChanged) {
      const run = this.#pending.then(() => this.#apply(wanted, true));
      this.#pending = run.catch(() => undefined);
      await run;
    }
  }

  #build(sel: EngineSelection | null): ManagedEngine {
    const config = sel === null ? this.#config.engine : this.#engineConfig(sel);
    const inner = this.#create(config, this.#paths, this.#tools);
    const life =
      sel === null
        ? { lifecycle: 'eager' as const, idleUnloadMinutes: 15 }
        : lifecycleFrom(this.#config);
    return new ManagedEngine(inner, life);
  }

  #requireSwitchable(): EngineSelection {
    if (!this.switchable || this.#selected === null) {
      throw new EngineSwitchError(409, 'this engine cannot switch models at runtime');
    }
    return this.#selected;
  }

  async #checkSelectable(next: EngineSelection): Promise<void> {
    if (isOpenAILike(next.engine)) {
      await this.#discover(next.engine);
    }
    if (!this.allowedModels(next.engine).includes(next.model)) {
      throw new EngineSwitchError(400, `unknown ${next.engine} model "${next.model}"`);
    }
    if (!modelFits(next.model, this.#memory, next.device, next.engine)) {
      const known = catalogModel(next.model, next.engine);
      const needs = known === undefined ? 0 : (modelMemoryGb(known, next.device) ?? 0);
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
    const model = catalogModel(next.model, next.engine);
    const installed =
      model === undefined ? false : ((await this.#installed([model])).get(model.id) ?? false);
    if (!unchanged && model !== undefined && !installed) {
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
    const selection = {
      engine: next.engine,
      model: next.model,
      ...(next.device === null ? {} : { device: next.device }),
    };
    if (JSON.stringify(this.#config.selection) !== JSON.stringify(selection)) {
      this.#save([{ path: ['selection'], value: selection }]);
      this.#applied = this.#config;
    }
    await previous.stop().catch(() => undefined);
    void engine.start();
  }

  async #installed(models: readonly ModelDescriptor[]): Promise<Map<string, boolean>> {
    if (this.#installedOverride !== undefined) {
      return this.#installedOverride(models.map((model) => model.id));
    }
    return this.#status.installed(models);
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

  #context(): EngineContext {
    return { paths: this.#paths, tools: this.#tools, host: this.#host, env: this.#env };
  }

  #save(edits: readonly ConfigEdit[]): void {
    try {
      this.#store.update(edits);
    } catch (error) {
      throw new EngineSwitchError(400, error instanceof Error ? error.message : String(error));
    }
  }
}
