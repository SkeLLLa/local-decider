import {
  MODES,
  PolicyError,
  type Mode,
  type PolicyThreshold,
} from '@ziptie-soft/local-decider-core';
import { mkdirSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';

import { authoringPrompt } from './authoring.ts';
import { buildInventory } from './benchmark-inventory.ts';
import {
  BenchmarkError,
  BenchmarkRunner,
  type BenchEngine,
  type BenchSelection,
  type BenchmarkHost,
  type BenchmarkInventory,
  type BenchmarkLease,
} from './benchmark-job.ts';
import {
  JsonBenchmarkStore,
  measurementDetailsFor,
  measurementsFor,
  type BenchmarkStore,
  type MeasurementDetails,
} from './benchmark-store.ts';
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
import { engineConnectionConfigPath, type EngineConnection } from './engine-connection.ts';
import {
  discoveryEndpoint,
  isOpenAILike,
  ModelDiscovery,
  OPENAI_LIKE_ENGINES,
  type DiscoveryEndpoint,
  type OpenAILikeEngine,
} from './engine-discovery.ts';
import { candidateKey, FallbackPolicy, type FallbackOptions } from './engine-fallback.ts';
import { ServerProbe, type DiscoverRequest } from './engine-probe.ts';
import type {
  EngineContext,
  EngineDescriptor,
  HostInfo,
  ModelDescriptor,
  RuntimeStamp,
} from './engines/descriptor.ts';
import { familyOf, familyLabel, formatOf, isKnownFamily } from './engines/families.ts';
import { cachedFlmVersion, FLM_INSTALL_URL } from './engines/fastflowlm/status.ts';
import { hardwareFingerprint } from './engines/fingerprint.ts';
import {
  invalidateHostCapabilities,
  probeHostCapabilities,
  type HostCapabilities,
} from './engines/host-capabilities.ts';
import { hostInfo } from './engines/host.ts';
import { createEngine } from './engines/index.ts';
import { ManagedEngine, type LifecycleOptions } from './engines/lazy.ts';
import { effectiveLlamaBinary, LLAMA_INSTALL_URL } from './engines/llama/server.ts';
import {
  allModels,
  ENGINES,
  engineDescriptor,
  isSelectableEngine,
  SELECTABLE_IDS,
  type EngineId,
} from './engines/registry.ts';
import { rankEngines, type Ranking } from './engines/selector.ts';
import { resolveStrandsDevice, type DeviceResolution } from './engines/strands/mlx.ts';
import { strandsBinary } from './engines/strands/server.ts';
import type { Engine } from './engines/types.ts';
import { catalogModel, MEMORY_BUDGET, modelFits, modelMemoryGb } from './models.ts';
import type { Paths } from './paths.ts';
import { loadPolicies, policyDirs, scopeModes, type LoadedPolicy } from './policies.ts';
import { StampCache, stampKey } from './stamp-cache.ts';
import {
  checkPath,
  PATH_KEYS,
  probe,
  resolveAll,
  resolveEntry,
  STRANDS_INSTALL_URL,
  toolchain,
  type PathEntry,
  type PathKey,
  type Toolchain,
} from './toolchain.ts';

const SWITCHABLE_ENGINES: readonly EngineId[] = SELECTABLE_IDS;

/** The listed keys of `entry` that are set, so absent ones stay out of the response. */
function optionalFields(
  entry: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap((key) => (entry?.[key] === undefined ? [] : [[key, entry[key]]])),
  );
}

interface LlamaAvailability {
  readonly binary: string | undefined;
  readonly urlConfigured: boolean;
}

function llamaEngineDetails(llama: LlamaAvailability): Record<string, unknown> {
  const available = llama.binary !== undefined || llama.urlConfigured;
  return {
    id: 'llama-vulkan',
    installed: available,
    available,
    detail:
      llama.binary ??
      (llama.urlConfigured
        ? 'Attached via engines.llama-vulkan.url'
        : 'llama-server not found on PATH'),
    ...(available ? {} : { installUrl: LLAMA_INSTALL_URL }),
  };
}

export interface EngineSelection {
  readonly engine: EngineId;
  readonly model: string;
  /** strands-decider only; null for engines without devices. */
  readonly device: Device | null;
}

interface BenchmarkSnapshot {
  readonly mode: 'auto' | 'manual';
  readonly selection: EngineSelection;
  readonly family: string | null;
}

/** The control's side of a benchmark lease; the runner sees it as a `BenchmarkLease`. */
class ControlLease implements BenchmarkLease {
  readonly gen: number;
  readonly snapshot: BenchmarkSnapshot;
  readonly done: Promise<void>;
  readonly controller = new AbortController();
  preempted: 'superseded' | 'config-changed' | null = null;
  readonly #resolve: () => void;

  constructor(gen: number, snapshot: BenchmarkSnapshot) {
    this.gen = gen;
    this.snapshot = snapshot;
    const done = Promise.withResolvers<void>();
    this.done = done.promise;
    this.#resolve = done.resolve;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(reason: string): void {
    this.controller.abort(reason);
  }

  /** Resolves `done`. */
  finish(): void {
    this.#resolve();
  }
}

/** A switch request; without an engine or device the current ones are kept. */
export interface EngineRequest {
  readonly engine?: EngineId | undefined;
  readonly model: string;
  readonly device?: Device | undefined;
}

/** A saved OpenAI-like connection; the token is only ever the name of an environment variable. */
export interface EngineConnectionView {
  readonly url: string;
  readonly model: string;
  readonly tokenEnv?: string;
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

export type SelectionModeName = 'auto' | 'manual';

export interface SelectionModeRequest {
  readonly mode: SelectionModeName;
  readonly family?: string;
}

function validateSelectionFamily(mode: SelectionModeName, family: string | undefined): void {
  if (family !== undefined && mode === 'manual') {
    throw new EngineSwitchError(400, 'family applies to automatic mode only');
  }
  if (family !== undefined && !isKnownFamily(family)) {
    throw new EngineSwitchError(400, `unknown model family "${family}"`);
  }
}

export function parseSelectionMode(body: unknown): SelectionModeRequest {
  const record = isRecord(body) ? body : {};
  const mode = record['mode'];
  if (mode !== 'auto' && mode !== 'manual') {
    throw new EngineSwitchError(400, 'mode must be "auto" or "manual"');
  }
  const family = record['family'];
  if (family !== undefined && typeof family !== 'string') {
    throw new EngineSwitchError(400, 'family must be a string');
  }
  if (typeof family === 'string' && (family.length < 1 || family.length > 400)) {
    throw new EngineSwitchError(400, 'family must be 1..400 characters');
  }
  validateSelectionFamily(mode, family);
  return { mode, ...(family === undefined ? {} : { family }) };
}

/** The engine and device behind a fallback note's `engine|device|model` key. */
function failedCandidate(key: string): { engine: string; device?: string } {
  const [engine = '', device = ''] = key.split('|');
  return { engine, ...(device === '' ? {} : { device }) };
}

function persistedSelection(sel: EngineSelection): Record<string, string> {
  return {
    engine: sel.engine,
    model: sel.model,
    ...(sel.device === null ? {} : { device: sel.device }),
  };
}

function presenceByEngine(
  models: readonly ModelDescriptor[],
  installed: ReadonlyMap<string, boolean>,
): ReadonlyMap<string, boolean> {
  return new Map(
    models.map((model) => [`${model.engine}|${model.id}`, installed.get(model.id) ?? false]),
  );
}

function modelFamily(model: ModelDescriptor): { id: string; label: string } | null {
  const id = familyOf(model.id, model.engine);
  return id === null ? null : { id, label: familyLabel(id) };
}

function stampKeys(candidates: readonly { engine: string; model: string }[]): string[] {
  return [
    ...new Set(
      candidates.flatMap(({ engine, model }) =>
        engineDescriptor(engine)?.runtimeStamp === undefined ||
        catalogModel(model, engine as EngineId) === undefined
          ? []
          : [stampKey(engine, model)],
      ),
    ),
  ];
}

function displayedMeasurements(
  engine: string,
  model: string,
  details: ReadonlyMap<string, MeasurementDetails>,
): Record<string, unknown>[] {
  const prefix = `${engine}|${model}|`;
  return [...details]
    .filter(
      ([key, entry]) => key.startsWith(prefix) && entry.record !== null && entry.view.ok !== null,
    )
    .map(([, entry]) => {
      const record = entry.record!;
      const measured = entry.view.ok!;
      return {
        device: record.device,
        typical: measured.typical,
        long: measured.long,
        sizes: record.sizes.map(({ targetTokens, inputTokens, p50Ms, p95Ms }) => ({
          targetTokens,
          inputTokens,
          p50Ms,
          p95Ms,
        })),
        runs: measured.runs,
        provisional: measured.provisional,
        measuredAt: measured.measuredAt,
        freshness: measured.freshness,
        staleReason: measured.staleReason,
        failed: entry.view.failed,
      };
    });
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

const PREEMPT_CAP_MS = 10_000;

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
  /** Injected in tests: the accelerator probe. */
  readonly capabilities?: (strandsDecider: string) => Promise<HostCapabilities>;
  /** Injected in tests: cooldown clock and backoff for automatic fallback. */
  readonly fallback?: FallbackOptions;
  /** Injected in tests; production reads benchmarks.json once from the data directory. */
  readonly benchmarkStore?: BenchmarkStore;
  /** Injected in tests: how long a preempting change waits for the benchmark to end. */
  readonly preemptCapMs?: number;
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

function engineSettingsKey(config: GatewayConfig): string {
  return JSON.stringify([
    config.selection,
    config.engine,
    config.engines,
    config.tools,
    config.dirs,
  ]);
}

/** Whether an edit touches the engine, its options or the tools it runs on. */
function engineSettingsChanged(previous: GatewayConfig, config: GatewayConfig): boolean {
  return engineSettingsKey(previous) !== engineSettingsKey(config);
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
export class EngineControl implements BenchmarkHost {
  /** Runs benchmark jobs on this control's engines; shares the store the ranking reads. */
  readonly benchmark: BenchmarkRunner;
  readonly switchable: boolean;
  /** False in remote mode (LOCAL_DECIDER_TOKEN set): paths, engine connections, discovery and routing presets stay frozen, so a bearer cannot make the host run binaries or reach new URLs. Loopback writes are guarded by the control token (server.ts). */
  readonly pathsEditable: boolean;
  readonly #store: ConfigStore;
  readonly #paths: Paths;
  readonly #env: NodeJS.ProcessEnv;
  readonly #host: HostInfo;
  readonly #create: NonNullable<EngineControlOptions['create']>;
  readonly #memory: number;
  readonly #installedOverride: EngineControlOptions['installed'];
  readonly #probeCapabilities: NonNullable<EngineControlOptions['capabilities']>;
  #capabilities: HostCapabilities | undefined;
  #probing = false;
  /** Bumped by `#retool()`; a probe started under an older generation is discarded. */
  #generation = 0;
  readonly #fallback: FallbackPolicy;
  readonly #fallbackNow: () => number;
  readonly #benchmarkStore: BenchmarkStore;
  readonly #stamps: StampCache;
  /** Engines whose failure was already handled, so one failure backs off once. */
  readonly #reported = new WeakSet<ManagedEngine>();
  #booted = false;
  #attempting: string | undefined;
  /** Why automatic mode is not on its top choice; null while it is. */
  #fallbackNote: {
    readonly reason: string;
    /** `engine|device|model` of the candidate that failed. */
    readonly key: string;
    readonly retryAt: number | undefined;
  } | null = null;
  #retryTimer: NodeJS.Timeout | undefined;
  readonly #downloads = new Downloads();
  readonly #status: CatalogStatus;
  /** The config last applied, to tell what an edit of config.yaml changed. */
  #applied: GatewayConfig;
  #tools: Toolchain;
  #selected: EngineSelection | null;
  #engine: ManagedEngine;
  #switching = false;
  readonly #discovery: ModelDiscovery;
  readonly #probe: ServerProbe;
  #decider: Decider | undefined;
  #pending: Promise<void> = Promise.resolve();
  #lease: ControlLease | null = null;
  /** Engines built for a benchmark: they never feed fallback accounting. */
  readonly #leasedEngines = new WeakSet<ManagedEngine>();
  readonly #preemptCapMs: number;
  #leaseGen = 0;

  constructor(options: EngineControlOptions) {
    const { store, paths } = options;
    const config = store.current;
    this.#store = store;
    this.#applied = config;
    this.#paths = paths;
    this.#env = options.env ?? process.env;
    this.#discovery = new ModelDiscovery(this.#env, options.fetch);
    this.#probe = new ServerProbe({ fetch: options.fetch });
    this.#host = options.host ?? hostInfo();
    this.#create = options.create ?? ((c, p, t) => createEngine(c, p, t));
    this.#memory = options.totalMemory ?? totalmem();
    this.#installedOverride = options.installed;
    this.#probeCapabilities =
      options.capabilities ?? ((strandsDecider) => probeHostCapabilities({ strandsDecider }));
    this.#fallbackNow = options.fallback?.now ?? Date.now;
    this.#preemptCapMs = options.preemptCapMs ?? PREEMPT_CAP_MS;
    this.#fallback = new FallbackPolicy(options.fallback);
    this.pathsEditable = options.pathsEditable ?? true;
    this.#tools = toolchain(config, paths, this.#env);
    this.#benchmarkStore =
      options.benchmarkStore ??
      new JsonBenchmarkStore(join(paths.data, 'benchmarks.json'), (message) =>
        console.warn(`local-decider: ${message}`),
      );
    this.#stamps = new StampCache((engine, model) => this.#resolveStamp(engine, model));
    this.#status = new CatalogStatus(this.#context());
    this.switchable =
      config.engine.type !== 'systemone-remote' &&
      (isOpenAILike(config.engine.type) || config.engine.url === undefined);
    this.#selected = this.switchable ? this.#initialSelection() : null;
    this.#engine = this.#build(this.#selected);
    this.benchmark = new BenchmarkRunner({ host: this, store: this.#benchmarkStore });
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

  /** True when `selection.mode` is `auto`: the gateway ranks and falls back on its own. */
  get #auto(): boolean {
    return this.switchable && this.#config.selection?.mode === 'auto';
  }

  bind(decider: Decider): void {
    this.#decider = decider;
    decider.onEngineFailure((engine) => this.#engineFailed(engine as ManagedEngine));
    decider.onEngineSuccess((engine) => this.#engineSucceeded(engine as ManagedEngine));
    if (this.#auto) {
      void this.#queueReconcile();
    }
    this.#applyPolicyState(decider);
    if (this.#tools.flm !== undefined) {
      void this.#status.validate('fastflowlm');
    }
  }

  /**
   * Start the initial engine. In automatic mode the first reconcile picks and starts it, so the
   * configured engine is not loaded just to be replaced.
   */
  start(): void {
    this.#booted = true;
    if (!this.#auto) {
      this.#startTracked(this.#engine);
    }
  }

  current(): EngineSelection | null {
    return this.#selected;
  }

  beginBenchmark(): BenchmarkLease {
    const selection = this.#requireSwitchable();
    if (this.#lease !== null) {
      throw new EngineSwitchError(409, 'a benchmark is already running');
    }
    const lease = new ControlLease(++this.#leaseGen, {
      mode: this.#auto ? 'auto' : 'manual',
      selection: { ...selection },
      family: this.#config.selection?.family ?? familyOf(selection.model, selection.engine),
    });
    this.#lease = lease;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#decider?.hold('engine benchmark running');
    return lease;
  }

  /** Installs `target` for the lease and resolves to the engine now serving. */
  benchmarkSwap(lease: BenchmarkLease, target: BenchSelection): Promise<BenchEngine> {
    const run = this.#pending.then(async () => {
      if (this.#lease !== lease || lease.signal.aborted) {
        throw new DOMException('benchmark lease is no longer active', 'AbortError');
      }
      if (!isSelectableEngine(target.engine)) {
        throw new EngineSwitchError(400, `unknown engine "${target.engine}"`);
      }
      await this.#apply({ ...target, engine: target.engine }, false, false, true);
      this.#leasedEngines.add(this.#engine);
      return this.#engine;
    });
    this.#pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async endBenchmark(
    lease: BenchmarkLease,
    options: { readonly restore: boolean },
  ): Promise<{ readonly ok: boolean; readonly error: string | null }> {
    if (this.#lease !== lease || !(lease instanceof ControlLease)) {
      return { ok: false, error: 'benchmark lease is no longer active' };
    }
    let error: string | null = null;
    try {
      if (options.restore && lease.snapshot.mode === 'auto') {
        this.#lease = null;
        await this.reconcileAuto();
      } else if (options.restore) {
        const run = this.#pending.then(() => this.#apply(lease.snapshot.selection, false, false));
        this.#pending = run.catch(() => undefined);
        await run;
      } else {
        this.#lease = null;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (this.#lease === lease) this.#lease = null;
      if (options.restore && this.#lease === null) this.#decider?.hold(null);
      if (options.restore) this.#leasedEngines.delete(this.#engine);
      lease.finish();
    }
    return { ok: error === null, error };
  }

  /** What a benchmark job resolves its targets from; probes the host once if needed. */
  async benchmarkInventory(): Promise<BenchmarkInventory> {
    const { models, installed, ranking } = await this.#inventorySources();
    const device = this.#deviceResolution();
    const memoryDevice = device?.resolved ?? this.#selected?.device;
    return buildInventory({
      engines: this.#engines().map((e) => ({
        id: String(e['id']),
        available: e['available'] === true,
        supported: e['supported'] === true,
        installed: e['installed'] === true,
        openaiLike: isOpenAILike(String(e['id'])),
      })),
      models,
      installed,
      fits: (m) => modelFits(m.id, this.#memory, memoryDevice, m.engine as EngineId),
      candidates: ranking.candidates,
      current:
        this.#selected === null
          ? null
          : { ...this.#selected, resolvedDevice: device?.resolved ?? null },
      preferredFamily: this.#config.selection?.family ?? ranking.machine?.family ?? null,
      measurements: measurementsFor(
        this.#benchmarkStore.records(),
        this.#fingerprint(this.#capabilities),
        (engine, model) => this.#stamps.get(engine, model),
      ),
    });
  }

  /** Throws a 409 `<engine> <model>: <reason>` when the target cannot be benchmarked here. */
  async checkBenchmarkTarget(target: BenchSelection): Promise<void> {
    const name = `${target.engine} ${target.model}`;
    if (!isSelectableEngine(target.engine)) {
      throw new BenchmarkError(409, `${name}: engine is not selectable`);
    }
    const next: EngineSelection = { ...target, engine: target.engine };
    try {
      await this.#checkSelectable(next);
      const { ranking } = await this.#inventorySources();
      const eligible = ranking.candidates.filter((c) => c.engine === next.engine && c.eligible);
      if (next.engine === 'strands-decider' && !eligible.some((c) => c.device === next.device)) {
        throw new EngineSwitchError(409, `device ${next.device ?? 'auto'} is not available here`);
      }
    } catch (error) {
      if (error instanceof EngineSwitchError) {
        throw new BenchmarkError(409, `${name}: ${error.message}`);
      }
      throw error;
    }
  }

  refreshStamps(keys: readonly string[], capMs: number): Promise<void> {
    return this.#stamps.refreshNow(keys, capMs);
  }

  stampFor(engine: string, model: string): RuntimeStamp | undefined {
    return this.#stamps.get(engine, model);
  }

  /** The machine's fingerprint; undefined until the capability probe has finished. */
  fingerprint(): string | undefined {
    return this.#fingerprint(this.#capabilities);
  }

  get host(): HostInfo {
    return { ...this.#host, totalMemoryBytes: this.#memory };
  }

  /** The catalogue, what is downloaded and the ranking, after one capability probe. */
  async #inventorySources(): Promise<{
    models: ModelDescriptor<EngineId>[];
    installed: Map<string, boolean>;
    ranking: Ranking;
  }> {
    await this.#ensureCapabilities();
    const models = this.#catalogModels();
    const installed = await this.#installed(models);
    const ranking = this.#rank(this.#capabilities, null, presenceByEngine(models, installed));
    return { models, installed, ranking };
  }

  /** Engine changes that would fight the job for the engine are refused while it runs. */
  #guardBenchmark(): void {
    if (this.#lease !== null) {
      throw new EngineSwitchError(409, 'an engine benchmark is running; cancel it first');
    }
  }

  /**
   * A user change cancels a running benchmark: abort it, wait (capped) for the runner to end the
   * lease, and drop the lease if it did not, so late benchmark calls become no-ops. Returns the
   * lease that was preempted, if any. The decider hold stays on until the caller releases it.
   */
  async #preemptBenchmark(reason: 'superseded' | 'config-changed'): Promise<ControlLease | null> {
    const lease = this.#lease;
    if (lease === null) {
      return null;
    }
    lease.preempted = reason;
    lease.abort(reason);
    let timer: NodeJS.Timeout | undefined;
    const capped = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#preemptCapMs);
      timer.unref();
    });
    await Promise.race([lease.done, capped]);
    clearTimeout(timer);
    if (this.#lease === lease) {
      this.#lease = null;
    }
    return lease;
  }

  /**
   * Run a user change that replaces a benchmark's engine. The decider stays held until `mutate`
   * returns (or throws), so decisions never reach the half-swapped gateway; an engine the change
   * kept is no longer leased, so its accounting resumes.
   */
  async #preempting<T>(
    reason: 'superseded' | 'config-changed',
    mutate: (ended: ControlLease | null) => Promise<T>,
  ): Promise<T> {
    const ended = await this.#preemptBenchmark(reason);
    try {
      return await mutate(ended);
    } finally {
      if (ended !== null && this.#lease === null) {
        this.#leasedEngines.delete(this.#engine);
        this.#decider?.hold(null);
      }
    }
  }

  /** Install `selection` for good measure, unpersisted, after the running benchmark's swaps. */
  async #reinstall(selection: EngineSelection): Promise<void> {
    const run = this.#pending.then(() => this.#apply(selection, false, false));
    this.#pending = run.catch(() => undefined);
    await run;
  }

  activeTag(): string {
    return this.#tag(this.#engine.id as EngineId);
  }

  activeHealth(): ReturnType<ManagedEngine['health']> {
    const health = this.#engine.health();
    return this.#switching ? { ...health, state: 'starting' } : health;
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

  /**
   * Turn automatic selection on, or off while keeping the engine that runs now. Persisted like a
   * manual `select`, so it survives a restart.
   */
  async setSelectionMode(
    mode: SelectionModeName,
    requestedFamily?: string,
  ): Promise<SelectionModeName> {
    validateSelectionFamily(mode, requestedFamily);
    this.#requireSwitchable();
    return this.#preempting('superseded', async (ended) => {
      // Going manual keeps what the user had running, not the benchmark's last engine.
      if (ended !== null && mode === 'manual') {
        await this.#reinstall(ended.snapshot.selection);
      }
      return this.#setMode(mode, requestedFamily);
    });
  }

  async #setMode(mode: SelectionModeName, requestedFamily?: string): Promise<SelectionModeName> {
    const current = this.#requireSwitchable();
    if (mode === 'auto') {
      const family = requestedFamily ?? familyOf(current.model, current.engine);
      if (family !== null && family !== undefined) validateSelectionFamily(mode, family);
      this.#save([
        {
          path: ['selection'],
          value: { mode: 'auto', ...(family === null || family === undefined ? {} : { family }) },
        },
      ]);
      this.#applied = this.#config;
      await this.reconcileAuto();
      return 'auto';
    }
    if (this.#auto) {
      this.#save([{ path: ['selection'], value: persistedSelection(current) }]);
      this.#applied = this.#config;
    }
    this.#leaveAuto();
    return 'manual';
  }

  async select(request: EngineRequest): Promise<EngineSelection> {
    this.#requireSwitchable();
    // Defaults come from what the user had selected, not from a benchmark's swap.
    const current = this.#lease?.snapshot.selection ?? this.#requireSwitchable();
    const engine = request.engine ?? current.engine;
    const next: EngineSelection = {
      engine,
      model: request.model,
      device: engine === 'strands-decider' ? (request.device ?? current.device ?? 'auto') : null,
    };
    await this.#checkSelectable(next);
    return this.#preempting('superseded', async () => {
      const run = this.#pending.then(() => this.#apply(next, false));
      this.#pending = run.catch(() => undefined);
      await run;
      if (this.#auto) {
        // Choosing the engine that is already active changes nothing to persist; do it anyway.
        this.#save([{ path: ['selection'], value: persistedSelection(next) }]);
        this.#applied = this.#config;
      }
      this.#leaveAuto();
      return next;
    });
  }

  // fallow-ignore-next-line unused-class-member -- called through the CONTROL_ROUTES table
  async load(): Promise<void> {
    this.#guardBenchmark();
    void this.#engine.load();
  }

  // fallow-ignore-next-line unused-class-member -- called through the CONTROL_ROUTES table
  async unload(): Promise<void> {
    this.#guardBenchmark();
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
      connections: Object.fromEntries(
        OPENAI_LIKE_ENGINES.map((id) => [id, this.#connection(id) ?? null]),
      ),
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

  /**
   * Save the connection of an OpenAI-like engine: `engine.*` when that is the primary engine
   * type (it beats `engines`), else `engines.<id>.*`. Editing the active engine rebuilds it once
   * (its model follows the edit); an inactive engine is only saved, never selected.
   */
  // fallow-ignore-next-line unused-class-member -- called through the settings-routes table
  async saveEngineConnection(connection: EngineConnection): Promise<EngineConnectionView> {
    this.#guardBenchmark();
    // Where the gateway connects (and which env var it reads): not from a remote client.
    if (!this.pathsEditable) {
      throw new EngineSwitchError(
        403,
        'engine connections can only be changed on a loopback gateway',
      );
    }
    const { engine: id, url, model, tokenEnv } = connection;
    const before = JSON.stringify(this.#endpoint(id) ?? null);
    const base = engineConnectionConfigPath(id, this.#config.engine.type);
    this.#save([
      { path: [...base, 'url'], value: url },
      { path: [...base, 'model'], value: model },
      { path: [...base, 'tokenEnv'], value: tokenEnv },
    ]);
    const { engine, engines } = this.#config;
    this.#applied = { ...this.#applied, engine, engines };
    const selected = this.#selected;
    if (selected?.engine === id && JSON.stringify(this.#endpoint(id) ?? null) !== before) {
      const run = this.#pending.then(() => this.#apply({ ...selected, model }, true, !this.#auto));
      this.#pending = run.catch(() => undefined);
      await run;
    }
    return this.#connection(id) ?? { url, model };
  }

  /** The saved connection of an OpenAI-like engine, for a settings page to prefill. */
  #connection(id: OpenAILikeEngine): EngineConnectionView | undefined {
    const endpoint = this.#endpoint(id);
    return endpoint === undefined
      ? undefined
      : {
          url: endpoint.url,
          model: endpoint.model,
          ...(endpoint.tokenEnv === undefined ? {} : { tokenEnv: endpoint.tokenEnv }),
        };
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
    this.#guardBenchmark();
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
    if (this.#lease === null) {
      return this.#applyConfig(false);
    }
    // A policy-only edit leaves a running benchmark alone; anything about the engine ends it.
    if (!engineSettingsChanged(this.#applied, this.#config)) {
      return this.#applyConfig(true);
    }
    return this.#preempting('config-changed', async () => this.#applyConfig(false));
  }

  async #applyConfig(keepSelection: boolean): Promise<string[]> {
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
    if (!keepSelection) {
      await this.#applySelectionConfig(previous, config);
    }
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

  /**
   * Look for the tools again, so one installed (or removed) since the gateway started is picked
   * up without a restart. The engine restarts only when its own binary changed.
   */
  #rediscover(): void {
    const next = toolchain(this.#config, this.#paths, this.#env);
    if (JSON.stringify(next) === JSON.stringify(this.#tools)) {
      return;
    }
    const engine = this.#selected?.engine;
    const restart =
      JSON.stringify(next.env) !== JSON.stringify(this.#tools.env) ||
      (engine === 'fastflowlm' && next.flm !== this.#tools.flm) ||
      (engine === 'strands-decider' && next.strandsDecider !== this.#tools.strandsDecider) ||
      (engine === 'llama-vulkan' &&
        this.#llamaAvailability(next).binary !== this.#llamaAvailability().binary);
    this.#retool(next, restart);
  }

  /** Rebuild the toolchain from the config and restart the engine on it. */
  #retool(next: Toolchain = toolchain(this.#config, this.#paths, this.#env), restart = true): void {
    this.#tools = next;
    invalidateHostCapabilities();
    this.#capabilities = undefined;
    this.#probing = false;
    this.#generation += 1;
    this.#status.reset(this.#context());
    if (restart && this.#selected !== null) {
      const sel = this.#selected;
      this.#pending = this.#pending
        .then(() => this.#apply(sel, true, !this.#auto))
        .catch(() => undefined);
    }
    if (this.#auto) {
      void this.#queueReconcile();
    }
  }

  async setPath(key: PathKey, value: string | null): Promise<PathEntry> {
    this.#guardBenchmark();
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
    this.#rediscover();
    this.#discoverAll();
    const models = this.#catalogModels();
    const installed = await this.#installed(models);
    const health = this.activeHealth();
    const life = this.#engine.lifecycle;
    const device = this.#deviceResolution();
    const memoryDevice = device?.resolved ?? this.#selected?.device;
    const ranking = this.#recommendation(presenceByEngine(models, installed));
    const details = measurementDetailsFor(
      this.#benchmarkStore.records(),
      this.#fingerprint(this.#capabilities),
      (engine, model) => this.#stamps.get(engine, model),
    );
    return {
      active: this.#activeStatus(ranking, health, life, device),
      switchable: this.switchable,
      totalMemoryGb: Math.round(this.#memory / 1e9),
      engines: this.#engines(),
      models: this.#modelStatuses(models, installed, memoryDevice, details),
      recommendation: ranking,
      downloads: this.#downloads.list(),
      paths: resolveAll(this.#config, this.#paths, this.#env, this.#host),
      pathsEditable: this.pathsEditable,
    };
  }

  #activeStatus(
    ranking: Ranking,
    health: ReturnType<ManagedEngine['health']>,
    life: LifecycleOptions,
    device: DeviceResolution | undefined,
  ): Record<string, unknown> {
    return {
      engine: this.#engine.id,
      model: this.#engine.model,
      device: this.#selected?.device ?? null,
      ...(device === undefined
        ? {}
        : {
            requestedDevice: device.requested,
            ...(device.resolved === undefined ? {} : { resolvedDevice: device.resolved }),
            ...(device.backend === undefined ? {} : { backend: device.backend }),
          }),
      state: health.state,
      detail: health.detail ?? null,
      selectionMode: this.#auto ? 'auto' : 'manual',
      preferredFamily: this.#config.selection?.family ?? ranking.machine?.family ?? null,
      benchmark: this.benchmark.progress(),
      ...(this.#fallbackNote === null
        ? {}
        : {
            fallback: {
              reason: this.#fallbackNote.reason,
              ...failedCandidate(this.#fallbackNote.key),
              ...(this.#fallbackNote.retryAt === undefined
                ? {}
                : { retryAt: new Date(this.#fallbackNote.retryAt).toISOString() }),
            },
          }),
      lifecycle: life.lifecycle,
      idleUnloadMinutes: life.idleUnloadMinutes,
      lastUsedAt: this.#engine.lastUsedAt,
    };
  }

  #modelStatuses(
    models: readonly ModelDescriptor<EngineId>[],
    installed: ReadonlyMap<string, boolean>,
    memoryDevice: Device | null | undefined,
    details: ReadonlyMap<string, MeasurementDetails>,
  ): Record<string, unknown>[] {
    return models.map((m) => ({
      id: m.id,
      engine: m.engine,
      label: m.label,
      downloadGb: m.downloadGb,
      memoryGb: modelMemoryGb(m, memoryDevice),
      cpuMemoryGb: m.memoryGb,
      gpuMemoryGb: m.gpuMemoryGb ?? null,
      fits: modelFits(m.id, this.#memory, memoryDevice, m.engine),
      quality: m.quality ?? null,
      source: m.source ?? null,
      installed: installed.get(m.id) ?? false,
      latencyHint: m.latencyHint,
      recommended: m.recommended === true,
      family: modelFamily(m),
      format: formatOf(m.quant),
      measured: displayedMeasurements(m.engine, m.id, details),
    }));
  }

  /** Ranked candidates from cached capabilities; the first call kicks the probe and shows unknowns. */
  #recommendation(present?: ReadonlyMap<string, boolean>): Ranking {
    this.#refreshCapabilities();
    return this.#rank(this.#capabilities, this.#auto ? null : this.#selected, present);
  }

  #rank(
    capabilities: HostCapabilities | undefined,
    explicit: EngineSelection | null,
    present?: ReadonlyMap<string, boolean>,
  ): Ranking {
    const installed = new Set<string>();
    if (this.#tools.strandsDecider !== undefined) {
      installed.add('strands-decider');
    }
    if (this.#tools.flm !== undefined) {
      installed.add('fastflowlm');
    }
    const llama = this.#llamaAvailability();
    if (llama.binary !== undefined || llama.urlConfigured) installed.add('llama-vulkan');
    return rankEngines({
      host: { ...this.#host, totalMemoryBytes: this.#memory },
      capabilities,
      engines: ENGINES,
      installed,
      explicit,
      measurements: measurementsFor(
        this.#benchmarkStore.records(),
        this.#fingerprint(capabilities),
        (engine, model) => this.#stamps.get(engine, model),
      ),
      ...(present === undefined ? {} : { present }),
      preferredFamily: this.#config.selection?.family ?? null,
      active:
        this.#selected === null
          ? null
          : {
              engine: this.#selected.engine,
              model: this.#selected.model,
              device: this.#selected.device,
              resolvedDevice: this.#deviceResolution()?.resolved ?? null,
            },
    });
  }

  async #rankWithFreshStamps(
    capabilities: HostCapabilities | undefined,
    explicit: EngineSelection | null,
  ): Promise<Ranking> {
    const before = this.#rank(capabilities, explicit);
    await this.#stamps.refreshNow(stampKeys(before.candidates), 5000);
    return this.#rank(capabilities, explicit);
  }

  /** Cached capabilities, probing once if needed; unknown (undefined) when the probe fails. */
  async #ensureCapabilities(): Promise<HostCapabilities | undefined> {
    if (this.#capabilities !== undefined) {
      return this.#capabilities;
    }
    const generation = this.#generation;
    const binary = this.#tools.strandsDecider ?? strandsBinary(this.#paths);
    const caps = await this.#probeCapabilities(binary).catch(() => undefined);
    if (caps !== undefined && generation === this.#generation) {
      this.#capabilities = caps;
    }
    return caps;
  }

  /** Outside the request path: never awaited by `status()`. */
  #refreshCapabilities(): void {
    if (this.#capabilities !== undefined || this.#probing) {
      return;
    }
    this.#probing = true;
    const generation = this.#generation;
    const binary = this.#tools.strandsDecider ?? strandsBinary(this.#paths);
    this.#probeCapabilities(binary)
      .then((caps) => {
        if (generation === this.#generation) {
          this.#capabilities = caps;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation === this.#generation) {
          this.#probing = false;
        }
      });
  }

  /** `device: auto` resolved once for the selected Strands engine; undefined for other engines. */
  #deviceResolution(
    selected: EngineSelection | null = this.#selected,
  ): DeviceResolution | undefined {
    if (selected?.engine !== 'strands-decider') {
      return undefined;
    }
    const binary = this.#tools.strandsDecider ?? strandsBinary(this.#paths);
    return resolveStrandsDevice(selected.device ?? 'auto', this.#host, binary);
  }

  #engines(): Record<string, unknown>[] {
    const validation = this.#status.validation ?? null;
    const flmInstalled = this.#tools.flm !== undefined;
    const strandsInstalled = this.#tools.strandsDecider !== undefined;
    const llama = this.#llamaAvailability();
    const details: Record<string, unknown>[] = [
      {
        id: 'strands-decider',
        installed: strandsInstalled,
        available: strandsInstalled,
        detail: strandsInstalled
          ? this.#tools.strandsDecider
          : 'Not found on PATH or in the local-decider venv; run `local-decider engine install`.',
        validation: null,
        ...(strandsInstalled ? {} : { installUrl: STRANDS_INSTALL_URL }),
      },
      {
        id: 'fastflowlm',
        installed: flmInstalled,
        available: flmInstalled && validation?.ok !== false,
        detail: flmInstalled
          ? (cachedFlmVersion(this.#tools.flm) ?? this.#tools.flm)
          : 'FastFlowLM not found on PATH. Install it with your package manager or the upstream installer, or set its path below.',
        validation,
        ...(flmInstalled ? {} : { installUrl: FLM_INSTALL_URL }),
      },
      llamaEngineDetails(llama),
      ...OPENAI_LIKE_ENGINES.map((id) => this.#openAIDetails(id)),
    ];
    return ENGINES.filter((engine) => engine.selectable).map((engine) => {
      const support = engine.supports(this.#host);
      const existing = details.find((entry) => entry['id'] === engine.id);
      return {
        id: engine.id,
        label: engine.label,
        description: engine.description,
        tag: this.#tag(engine.id),
        version: this.#engineVersion(engine.id),
        calibrated: engine.calibrated,
        capabilities: { validate: engine.validation !== undefined },
        installed: existing?.['installed'] ?? false,
        available: existing?.['available'] ?? false,
        detail: existing?.['detail'] ?? null,
        devices: [...(engine.devices?.(this.#host) ?? [])],
        validation: existing?.['validation'] ?? null,
        ...optionalFields(existing, ['installUrl', 'connection']),
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
      saved?.model === undefined ||
      savedEngine === undefined ||
      !SWITCHABLE_ENGINES.includes(savedEngine)
    ) {
      return fromConfig;
    }
    // A discovered model is not known before discovery runs: trust the saved choice for
    // OpenAI-like engines; a model the server lacks then fails on use, with the server's error.
    if (!isOpenAILike(savedEngine) && !this.allowedModels(savedEngine).includes(saved.model)) {
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

  #openAIDetails(id: OpenAILikeEngine): Record<string, unknown> {
    const endpoint = this.#endpoint(id);
    return {
      id,
      installed: endpoint !== undefined,
      available: endpoint !== undefined,
      detail:
        endpoint === undefined
          ? "Not configured. Enter your server's API base URL and choose or type a model below. Nothing to install."
          : endpoint.url,
      validation: null,
      connection: this.#connection(id) ?? null,
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
        ...ids.map((model) => {
          const detail = this.#discovery.detail(id, endpoint, model);
          return {
            id: model,
            engine: id,
            label: detail === undefined ? model : `${model} (${detail})`,
            downloadGb: null,
            memoryGb: null,
            latencyHint: null,
          };
        }),
      );
    }
    return models;
  }

  /** Starts due refreshes in the background; status and catalog reads use only what is cached. */
  #discoverAll(): void {
    for (const id of OPENAI_LIKE_ENGINES) {
      this.#discovery.kick(id, this.#endpoint(id));
    }
  }

  /** Resolves when background model discovery has finished; for tests and callers that need it. */
  refreshDiscovery(): Promise<void> {
    return this.#discovery.settled();
  }

  /** `POST /v1/engines/discover`: nearby servers, or the models of one URL. Persists nothing. */
  // fallow-ignore-next-line unused-class-member -- called through the settings-routes table
  async discoverServers(request: DiscoverRequest): Promise<Record<string, unknown>> {
    if (!this.pathsEditable) {
      throw new EngineSwitchError(403, 'server discovery is only available on a loopback gateway');
    }
    return this.#probe.discover(request);
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
      return typed.tag(this.#engineConfigFor(id), this.#host, {
        paths: this.#paths,
        tools: this.#tools,
      });
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

  #configuredModel(id: EngineId): string | undefined {
    if (this.#selected?.engine === id) return this.#selected.model;
    if (this.#config.engine.type === id) return this.#config.engine.model;
    const model = this.#config.engines?.[id]?.model;
    if (typeof model === 'string') return model;
    const descriptor = engineDescriptor(id);
    return (
      descriptor?.models.find((entry) => entry.recommended === true)?.id ??
      descriptor?.models[0]?.id
    );
  }

  #engineVersion(id: EngineId): string | null {
    const descriptor = engineDescriptor(id);
    const model = this.#configuredModel(id);
    if (descriptor?.runtimeStamp === undefined || model === undefined) return null;
    return this.#stamps.get(id, model)?.runtime ?? null;
  }

  /** The llama-server the engine would spawn: engine `binary` override, else tools.llamaServer. */
  #llamaAvailability(tools: Toolchain = this.#tools): LlamaAvailability {
    const config = this.#engineConfigFor('llama-vulkan');
    return config.type === 'llama-vulkan'
      ? { binary: effectiveLlamaBinary(config, tools), urlConfigured: config.url !== undefined }
      : { binary: undefined, urlConfigured: false };
  }

  async #applySelectionConfig(previous: GatewayConfig, config: GatewayConfig): Promise<void> {
    if (this.#auto) {
      await this.reconcileAuto();
      return;
    }
    this.#leaveAuto();
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
    this.#checkFits(next);
    const engineInfo = this.#engines().find((e) => e['id'] === next.engine);
    if (engineInfo?.['available'] !== true) {
      throw new EngineSwitchError(
        409,
        `${next.engine} is not available: ${String(engineInfo?.['detail'])}`,
      );
    }
    const unchanged = this.#same(next);
    const model = catalogModel(next.model, next.engine);
    const attached = next.engine === 'llama-vulkan' && this.#llamaAvailability().urlConfigured;
    const installed =
      attached ||
      (model !== undefined && ((await this.#installed([model])).get(model.id) ?? false));
    if (!unchanged && model !== undefined && !installed) {
      throw new EngineSwitchError(400, `${next.model} is not downloaded yet`);
    }
  }

  /** Rejects a model that would not fit the memory budget on its resolved device. */
  #checkFits(next: EngineSelection): void {
    const memoryDevice = this.#deviceResolution(next)?.resolved ?? next.device;
    if (modelFits(next.model, this.#memory, memoryDevice, next.engine)) {
      return;
    }
    const known = catalogModel(next.model, next.engine);
    const needs = known === undefined ? 0 : (modelMemoryGb(known, memoryDevice) ?? 0);
    const budget = Math.floor((this.#memory * MEMORY_BUDGET) / 1e9);
    throw new EngineSwitchError(
      409,
      `${next.model} needs ~${String(needs)} GB; this machine allows ~${String(budget)} GB for the decision model`,
    );
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
  async #apply(
    next: EngineSelection,
    force: boolean,
    persist = true,
    leased = false,
  ): Promise<void> {
    if (!force && this.#same(next)) {
      return;
    }
    const engine = this.#build(next);
    if (leased) this.#leasedEngines.add(engine);
    const previous = this.#engine;
    this.#engine = engine;
    this.#switching = true;
    this.#selected = next;
    this.#decider?.replaceEngine(engine);
    const selection = persistedSelection(next);
    if (persist && JSON.stringify(this.#config.selection) !== JSON.stringify(selection)) {
      this.#save([{ path: ['selection'], value: selection }]);
      this.#applied = this.#config;
    }
    await previous.stop().catch(() => undefined);
    this.#switching = false;
    this.#startTracked(engine);
  }

  #startTracked(engine: ManagedEngine): void {
    void engine.start().then(() => this.#started(engine));
  }

  /** A lazy engine never reports ready on start; its first answer proves it is healthy. */
  #engineSucceeded(engine: ManagedEngine): void {
    if (this.#leasedEngines.has(engine)) {
      return;
    }
    if (engine === this.#engine && this.#selected !== null) {
      this.#fallback.recordSuccess(candidateKey(this.#selected));
    }
  }

  /** Leaving automatic mode drops its fallback report and retry timer. */
  #leaveAuto(): void {
    this.#fallbackNote = null;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  /** An eager engine finished loading: a failure backs off, a healthy start clears the slate. */
  #started(engine: ManagedEngine): void {
    if (this.#leasedEngines.has(engine) || engine !== this.#engine || this.#selected === null) {
      return;
    }
    if (engine.health().state === 'ready') {
      this.#fallback.recordSuccess(candidateKey(this.#selected));
    } else {
      this.#engineFailed(engine);
    }
  }

  /** Automatic mode only: an infrastructure failure of the active engine starts a fallback. */
  #engineFailed(engine: ManagedEngine): void {
    const health = engine.health();
    if (
      this.#leasedEngines.has(engine) ||
      !this.#auto ||
      engine !== this.#engine ||
      this.#selected === null ||
      health.state !== 'failed' ||
      this.#reported.has(engine)
    ) {
      return;
    }
    this.#reported.add(engine);
    const key = candidateKey(this.#selected);
    const retryAt = this.#fallback.recordFailure(key);
    this.#fallbackNote = {
      reason: `${engine.id} failed: ${health.detail ?? 'unknown'}`,
      key,
      retryAt,
    };
    void this.#queueReconcile();
  }

  #queueReconcile(): Promise<void> {
    const run = this.#pending.then(() => this.#reconcile());
    this.#pending = run.catch(() => undefined);
    return run.catch(() => undefined);
  }

  /** Re-rank now (also what the retry timer calls); a no-op outside automatic mode. */
  reconcileAuto(): Promise<void> {
    return this.#queueReconcile();
  }

  /** Move to the best installed, eligible candidate that is not cooling down. Never downloads. */
  async #reconcile(): Promise<void> {
    if (this.#lease !== null) {
      return;
    }
    if (!this.#auto) {
      this.#leaveAuto();
      return;
    }
    try {
      await this.#moveToBest();
    } catch (error) {
      this.#recordSwitchFailure(error);
    } finally {
      this.#armRetry();
    }
  }

  async #moveToBest(): Promise<void> {
    this.#attempting = undefined;
    const capabilities = await this.#ensureCapabilities();
    const ranking = await this.#rankWithFreshStamps(capabilities, null);
    const models = ranking.candidates.flatMap(
      (c) => catalogModel(c.model, c.engine as EngineId) ?? [],
    );
    const present = await this.#installed(models);
    const here = (c: { readonly model: string }): boolean => present.get(c.model) ?? false;
    const wanted = this.#fallback.pick(ranking.candidates, here);
    if (wanted === undefined) {
      return;
    }
    this.#attempting = candidateKey(wanted);
    const next: EngineSelection = {
      engine: wanted.engine as EngineId,
      model: wanted.model,
      device: wanted.device,
    };
    const failed = this.#engine.health().state === 'failed';
    const first = !this.#booted;
    this.#booted = true;
    if (failed || !this.#same(next)) {
      await this.#apply(next, failed, false);
    } else if (first) {
      this.#startTracked(this.#engine);
    }
    // The report stays only while a better candidate is cooling down.
    const best = ranking.candidates.find((c) => c.eligible && c.ready && here(c));
    if (best !== undefined && candidateKey(best) === candidateKey(wanted)) {
      this.#fallbackNote = null;
    }
  }

  /** The switch itself threw: back that candidate off so it is not picked again at once. */
  #recordSwitchFailure(error: unknown): void {
    const key = this.#attempting;
    if (key === undefined) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.#fallbackNote = {
      reason: `switching to ${key.split('|')[0] ?? key} failed: ${message}`,
      key,
      retryAt: this.#fallback.recordFailure(key),
    };
  }

  /** Wake up when the earliest cooldown ends, so a recovered engine is retried without polling. */
  #armRetry(): void {
    if (this.#lease !== null) {
      return;
    }
    clearTimeout(this.#retryTimer);
    const at = this.#fallback.nextRetryAt();
    if (at === undefined) {
      return;
    }
    const delay = Math.min(Math.max(at - this.#fallbackNow(), 0) + 1, 2 ** 30);
    this.#retryTimer = setTimeout(() => void this.reconcileAuto(), delay);
    this.#retryTimer.unref();
  }

  async #installed(models: readonly ModelDescriptor[]): Promise<Map<string, boolean>> {
    if (this.#installedOverride !== undefined) {
      return this.#installedOverride(models.map((model) => model.id));
    }
    return this.#status.installed(models);
  }

  #fingerprint(capabilities: HostCapabilities | undefined): string | undefined {
    return hardwareFingerprint({ ...this.#host, totalMemoryBytes: this.#memory }, capabilities);
  }

  async #resolveStamp(engine: string, model: string): Promise<RuntimeStamp> {
    const descriptor = engineDescriptor(engine);
    const modelDescriptor = catalogModel(model, engine as EngineId);
    if (descriptor === undefined || modelDescriptor === undefined) {
      return { runtime: null, model: null };
    }
    const typed = descriptor as EngineDescriptor<EngineConfig>;
    const resolve = typed.runtimeStamp;
    if (resolve === undefined) return { runtime: null, model: null };
    const id = engine as EngineId;
    const config =
      this.#config.engine.type === id
        ? this.#config.engine
        : engineDefaults(id, model, this.#config.engines?.[id]);
    const tools =
      config.type === 'llama-vulkan'
        ? {
            ...this.#tools,
            llamaServer:
              config.url === undefined ? effectiveLlamaBinary(config, this.#tools) : undefined,
          }
        : config.type === 'fastflowlm'
          ? { ...this.#tools, flm: config.binary ?? this.#tools.flm }
          : this.#tools;
    const stamp = await resolve(modelDescriptor as ModelDescriptor<EngineConfig['type']>, {
      ...this.#context(),
      tools,
    });
    const attached =
      (config.type === 'llama-vulkan' || config.type === 'strands-decider') &&
      config.url !== undefined;
    return attached ? { ...stamp, runtime: null } : stamp;
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
