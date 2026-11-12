/**
 * The pure half of the benchmark job: parsing `POST /v1/benchmark` and resolving which
 * `(engine, model, device)` targets to measure. The runner and the engine lease live elsewhere.
 */
import type { SystemOneRequest, SystemOneResponse } from '@ziptie-soft/local-decider-core';

import { measureSize, type BenchCall } from './bench.ts';
import { BENCH_VERSION, type BenchmarkSizeRecord, type BenchmarkStore } from './benchmark-store.ts';
import { DEVICES, type Device, type HostInfo, type RuntimeStamp } from './engines/descriptor.ts';
import { SELECTABLE_IDS } from './engines/registry.ts';
import type { Backend } from './engines/selector.ts';
import { GATEWAY_VERSION } from './version.ts';

export class BenchmarkError extends Error {
  override readonly name = 'BenchmarkError';
  readonly status: 400 | 409;
  constructor(status: 400 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export interface BenchmarkTargetInput {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
}

export interface BenchmarkRequest {
  readonly scope: 'installed' | 'family' | 'active';
  readonly family: string | null;
  /** Explicit targets; `scope` is ignored when present. */
  readonly targets: readonly BenchmarkTargetInput[] | null;
  readonly only: 'missing' | null;
  readonly sizes: readonly number[];
  readonly runs: number;
  readonly client: 'paseo' | 'cli' | 'api';
}

const MAX_TARGETS = 32;
const MAX_SIZES = 6;
const MIN_SIZE = 64;
const MAX_SIZE = 8192;
const TYPICAL_SIZE = 1024;
const DEFAULT_RUNS = 5;
const MAX_RUNS = 20;
const SCOPES = ['installed', 'family', 'active'] as const;
const STRANDS = 'strands-decider';
const CONCRETE_DEVICES: readonly string[] = DEVICES.filter((d) => d !== 'auto');

// ── parsing ──────────────────────────────────────────────────────────────────────────────────

type Fields = Record<string, unknown>;

function bad(message: string): BenchmarkError {
  return new BenchmarkError(400, message);
}

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw bad(`${what} must be a non-empty string`);
  }
  return value.trim();
}

function optional<T>(value: unknown, parse: (v: unknown) => T): T | null {
  return value === undefined || value === null ? null : parse(value);
}

function parseScope(value: unknown): BenchmarkRequest['scope'] {
  if (value === undefined) {
    return 'installed';
  }
  const scope = SCOPES.find((s) => s === value);
  if (scope === undefined) {
    throw bad(`scope must be one of ${SCOPES.join(', ')}`);
  }
  return scope;
}

function parseTarget(value: unknown): BenchmarkTargetInput {
  if (!isFields(value)) {
    throw bad('each target must be an object');
  }
  const engine = nonEmpty(value['engine'], 'target engine');
  if (!(SELECTABLE_IDS as readonly string[]).includes(engine)) {
    throw bad(`unknown engine "${engine}"`);
  }
  const model = nonEmpty(value['model'], 'target model');
  const raw = value['device'];
  if (raw === undefined || raw === null) {
    return { engine, model, device: null };
  }
  if (typeof raw !== 'string' || !CONCRETE_DEVICES.includes(raw)) {
    throw bad(`unknown device ${JSON.stringify(raw)}`);
  }
  return { engine, model, device: raw };
}

function parseTargets(value: unknown): BenchmarkTargetInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw bad('targets must be a non-empty array');
  }
  if (value.length > MAX_TARGETS) {
    throw bad(`at most ${String(MAX_TARGETS)} targets`);
  }
  return value.map(parseTarget);
}

function isSize(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= MIN_SIZE && (n as number) <= MAX_SIZE;
}

function parseSizes(value: unknown): number[] {
  if (value === undefined || value === null) {
    return [TYPICAL_SIZE];
  }
  if (!Array.isArray(value) || !value.every(isSize)) {
    throw bad(`sizes must be whole numbers from ${String(MIN_SIZE)} to ${String(MAX_SIZE)}`);
  }
  const sizes = [...new Set([...value, TYPICAL_SIZE])].toSorted((a, b) => a - b);
  if (sizes.length > MAX_SIZES) {
    throw bad(`at most ${String(MAX_SIZES)} sizes (${String(TYPICAL_SIZE)} is always included)`);
  }
  return sizes;
}

function parseRuns(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_RUNS;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_RUNS) {
    throw bad(`runs must be a whole number from 1 to ${String(MAX_RUNS)}`);
  }
  return value;
}

function parseClient(value: unknown): BenchmarkRequest['client'] {
  return value === 'paseo' || value === 'cli' ? value : 'api';
}

function parseOnly(value: unknown): 'missing' {
  if (value !== 'missing') {
    throw bad('only must be "missing"');
  }
  return 'missing';
}

/** Validates a request body; throws `BenchmarkError(400)` on any violation. */
export function parseBenchmarkRequest(body: unknown): BenchmarkRequest {
  if (body !== undefined && body !== null && !isFields(body)) {
    throw bad('body must be a JSON object');
  }
  const v: Fields = body ?? {};
  return {
    scope: parseScope(v['scope']),
    family: optional(v['family'], (f) => nonEmpty(f, 'family')),
    targets: optional(v['targets'], parseTargets),
    only: optional(v['only'], parseOnly),
    sizes: parseSizes(v['sizes']),
    runs: parseRuns(v['runs']),
    client: parseClient(v['client']),
  };
}

// ── resolution ───────────────────────────────────────────────────────────────────────────────

export interface InventoryEngine {
  readonly id: string;
  readonly selectable: boolean;
  readonly available: boolean;
  readonly supported: boolean;
  readonly installed: boolean;
  /** A custom OpenAI-compatible server: never benchmarked. */
  readonly openaiLike: boolean;
}

export interface InventoryModel {
  readonly engine: string;
  readonly id: string;
  /** The verified base checkpoint, else `<engine>:<model>`. */
  readonly family: string;
  readonly downloaded: boolean;
  readonly fits: boolean;
  /** Catalogue position within the engine: lower is the recommended variant. */
  readonly recommendedOrder: number;
  /** Quantisation tag stored with a record, e.g. `Q8_0`. */
  readonly quant?: string | null;
}

export interface BenchmarkInventory {
  /** In ladder order. */
  readonly engines: readonly InventoryEngine[];
  readonly models: readonly InventoryModel[];
  /** The concrete devices of the eligible strands rungs. */
  readonly strandsDevices: readonly string[];
  readonly current: {
    readonly engine: string;
    readonly model: string;
    readonly device: string | null;
    readonly resolvedDevice: string | null;
  } | null;
  readonly preferredFamily: string | null;
  /** The position of `(engine, device)` on the ladder; lower is tried first. */
  ladderIndex(engine: string, device: string | null): number;
  /** Whether a fresh, non-provisional record already exists for this target. */
  rankable(engine: string, model: string, device: string | null): boolean;
}

export interface ResolvedTarget {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
  readonly family: string;
}

export interface ResolvedTargets {
  readonly targets: readonly ResolvedTarget[];
  /** Selectable engines left out because they are custom servers. */
  readonly excluded: readonly string[];
}

function keyOf(t: { engine: string; model: string; device: string | null }): string {
  return `${t.engine}|${t.model}|${t.device ?? ''}`;
}

function nothing(why: string): BenchmarkError {
  return new BenchmarkError(409, `nothing to benchmark: ${why}`);
}

function familyOf(inv: BenchmarkInventory, engine: string, model: string): string {
  return (
    inv.models.find((m) => m.engine === engine && m.id === model)?.family ?? `${engine}:${model}`
  );
}

function devicesOf(inv: BenchmarkInventory, engine: string): (string | null)[] {
  return engine === STRANDS ? [...inv.strandsDevices] : [null];
}

function runnable(e: InventoryEngine): boolean {
  return e.selectable && e.available && e.supported && e.installed && !e.openaiLike;
}

interface Candidate extends ResolvedTarget {
  readonly ladder: number;
  readonly order: number;
}

function candidatesOf(inv: BenchmarkInventory, family: string | null): Candidate[] {
  const out: Candidate[] = [];
  for (const e of inv.engines.filter(runnable)) {
    const models = inv.models
      .filter(
        (m) =>
          m.engine === e.id && m.downloaded && m.fits && (family === null || m.family === family),
      )
      .toSorted((a, b) => a.recommendedOrder - b.recommendedOrder);
    for (const m of models) {
      for (const device of devicesOf(inv, e.id)) {
        const ladder = inv.ladderIndex(e.id, device);
        out.push({
          engine: e.id,
          model: m.id,
          device,
          family: m.family,
          ladder,
          order: out.length,
        });
      }
    }
  }
  return out;
}

function compare(a: Candidate, b: Candidate, rank: (c: Candidate) => number): number {
  if (rank(a) !== rank(b)) {
    return rank(a) - rank(b);
  }
  if (a.family !== b.family) {
    return a.family < b.family ? -1 : 1;
  }
  return a.ladder - b.ladder || a.order - b.order;
}

/** Preferred family first, then families by their best ladder index, then ladder and catalogue order. */
function orderCandidates(list: Candidate[], preferred: string | null): ResolvedTarget[] {
  const best = new Map<string, number>();
  for (const c of list) {
    best.set(c.family, Math.min(best.get(c.family) ?? Number.POSITIVE_INFINITY, c.ladder));
  }
  const rank = (c: Candidate): number =>
    c.family === preferred ? Number.NEGATIVE_INFINITY : (best.get(c.family) ?? 0);
  return list
    .toSorted((a, b) => compare(a, b, rank))
    .map(({ engine, model, device, family }) => ({ engine, model, device, family }));
}

function activeTarget(inv: BenchmarkInventory): ResolvedTarget {
  const c = inv.current;
  if (c === null) {
    throw nothing('no engine is running');
  }
  const device = c.engine === STRANDS ? (c.resolvedDevice ?? 'cpu') : null;
  return { engine: c.engine, model: c.model, device, family: familyOf(inv, c.engine, c.model) };
}

function familyFor(request: BenchmarkRequest, inv: BenchmarkInventory): string {
  const current =
    inv.current === null ? null : familyOf(inv, inv.current.engine, inv.current.model);
  const family = request.family ?? inv.preferredFamily ?? current;
  if (family === null) {
    throw bad('scope "family" needs a family');
  }
  if (!inv.models.some((m) => m.family === family)) {
    throw bad(`unknown model family "${family}"`);
  }
  return family;
}

/** Why an explicit target cannot run, or null. */
function refusal(inv: BenchmarkInventory, t: BenchmarkTargetInput): string | null {
  const engine = inv.engines.find((e) => e.id === t.engine);
  const model = inv.models.find((m) => m.engine === t.engine && m.id === t.model);
  if (engine === undefined || !engine.selectable) return 'engine is not selectable';
  if (engine.openaiLike) return "custom servers aren't benchmarked";
  if (!engine.supported) return 'not supported on this machine';
  if (!engine.installed) return 'not installed';
  if (!engine.available) return 'not available';
  if (model?.downloaded !== true) return 'not downloaded';
  if (!model.fits) return 'does not fit in memory';
  if (t.device !== null && !inv.strandsDevices.includes(t.device)) {
    return `device ${t.device} is not available here`;
  }
  return null;
}

function checkExplicit(inv: BenchmarkInventory, t: BenchmarkTargetInput): ResolvedTarget {
  if (!inv.models.some((m) => m.engine === t.engine && m.id === t.model)) {
    throw bad(`unknown model "${t.model}" for engine ${t.engine}`);
  }
  if (t.engine === STRANDS && t.device === null) {
    throw bad(`${STRANDS} needs a device (${CONCRETE_DEVICES.join(', ')})`);
  }
  if (t.engine !== STRANDS && t.device !== null) {
    throw bad(`a device applies to ${STRANDS} only`);
  }
  const why = refusal(inv, t);
  if (why !== null) {
    throw new BenchmarkError(409, `${t.engine} ${t.model}: ${why}`);
  }
  return { ...t, family: familyOf(inv, t.engine, t.model) };
}

function dedupe(list: readonly ResolvedTarget[]): ResolvedTarget[] {
  return [...new Map(list.map((t) => [keyOf(t), t])).values()];
}

interface Scoped {
  readonly list: ResolvedTarget[];
  readonly excluded: string[];
  readonly why: string;
}

function scoped(request: BenchmarkRequest, inv: BenchmarkInventory): Scoped {
  if (request.targets !== null) {
    return {
      list: request.targets.map((t) => checkExplicit(inv, t)),
      excluded: [],
      why: 'no targets',
    };
  }
  if (request.scope === 'active') {
    return { list: [activeTarget(inv)], excluded: [], why: 'no engine is running' };
  }
  const family = request.scope === 'family' ? familyFor(request, inv) : null;
  return {
    list: orderCandidates(candidatesOf(inv, family), family ?? inv.preferredFamily),
    excluded: inv.engines.filter((e) => e.selectable && e.openaiLike).map((e) => e.id),
    why:
      family === null
        ? 'no installed model that fits this machine'
        : `no runnable model of family ${family}`,
  };
}

/**
 * The targets of a request, in measuring order, and the engines left out. Throws
 * `BenchmarkError`: 400 for an unknown family or model or a malformed device, 409 for a target
 * that cannot run or when nothing is left to measure. Explicit targets keep their given order.
 */
export function resolveTargets(
  request: BenchmarkRequest,
  inv: BenchmarkInventory,
): ResolvedTargets {
  const { list, excluded, why } = scoped(request, inv);
  const unique = dedupe(list);
  if (unique.length === 0) {
    throw nothing(why);
  }
  const targets =
    request.only === 'missing'
      ? unique.filter((t) => !inv.rankable(t.engine, t.model, t.device))
      : unique;
  if (targets.length === 0) {
    throw nothing('every target already has a result');
  }
  return { targets, excluded };
}

// ── the runner ───────────────────────────────────────────────────────────────────────────────

const BENCH_LOAD_TIMEOUT_MS = 900_000;
const BENCH_CALL_TIMEOUT_MS = 180_000;
const STAMP_CAP_MS = 5000;
const UNKNOWN_TARGET_MS = 60_000;
const MAX_ERROR = 500;
const BACKENDS: readonly string[] = ['NPU', 'CUDA', 'Vulkan', 'MLX', 'MPS', 'CPU'];
const DEVICE_BACKENDS: Readonly<Record<string, Backend>> = {
  mlx: 'MLX',
  mps: 'MPS',
  cuda: 'CUDA',
  cpu: 'CPU',
};

export interface BenchSelection {
  readonly engine: string;
  readonly model: string;
  readonly device: Device | null;
}

/** What the runner needs of a leased engine. */
export interface BenchEngine {
  decide(request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse>;
  ensureReady?(signal: AbortSignal): Promise<void>;
  health(): { readonly backend?: string; readonly resolvedDevice?: string };
}

/** The engine control's claim on the gateway while a job runs. */
export interface BenchmarkLease {
  /** Aborts when the job is cancelled or preempted. */
  readonly signal: AbortSignal;
  abort(reason: string): void;
  /** Set by the host when a user selection or a config change preempts the job. */
  readonly preempted: 'superseded' | 'config-changed' | null;
  /** Resolves once `endBenchmark` has run for this lease. */
  readonly done: Promise<void>;
  /** What the end of the job puts back. */
  readonly snapshot: {
    readonly mode: 'auto' | 'manual';
    readonly selection: BenchSelection;
    readonly family: string | null;
  };
}

export interface BenchmarkHost {
  beginBenchmark(): BenchmarkLease;
  benchmarkSwap(lease: BenchmarkLease, target: BenchSelection): Promise<BenchEngine>;
  endBenchmark(
    lease: BenchmarkLease,
    options: { restore: boolean },
  ): Promise<{ ok: boolean; error: string | null }>;
  benchmarkInventory(): Promise<BenchmarkInventory>;
  checkBenchmarkTarget(target: BenchSelection): Promise<void>;
  refreshStamps(keys: readonly string[], capMs: number): Promise<void>;
  stampFor(engine: string, model: string): RuntimeStamp | undefined;
  fingerprint(): string | undefined;
  readonly host: HostInfo;
}

export type BenchmarkState = 'idle' | 'running' | 'cancelling' | 'done' | 'cancelled' | 'failed';
export type BenchmarkPhase = 'loading' | 'measuring' | 'restoring';
export type TargetState =
  | 'pending'
  | 'loading'
  | 'measuring'
  | 'done'
  | 'failed'
  | 'discarded'
  | 'not-run';
export type CancelReason = 'user' | 'shutdown' | 'superseded' | 'config-changed';

export interface BenchmarkViewSize {
  readonly targetTokens: number;
  readonly inputTokens: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly answer: string | null;
  readonly error: string | null;
}

export interface BenchmarkViewTarget {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
  readonly family: string | null;
  readonly state: TargetState;
  readonly loadMs: number | null;
  readonly error: string | null;
  readonly sizes: readonly BenchmarkViewSize[];
}

/** The body of `GET /v1/benchmark` (plan §4.3). */
export interface BenchmarkView {
  readonly state: BenchmarkState;
  readonly phase: BenchmarkPhase | null;
  readonly id: string | null;
  readonly startedBy: 'paseo' | 'cli' | 'api' | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly sizes: readonly number[];
  readonly runs: number | null;
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly current: {
    readonly engine: string;
    readonly model: string;
    readonly device: string | null;
    readonly family: string | null;
    readonly promptTokens: number | null;
  } | null;
  readonly etaSeconds: number | null;
  readonly targets: readonly BenchmarkViewTarget[];
  readonly restore: {
    readonly mode: 'auto' | 'manual';
    readonly engine: string;
    readonly model: string;
    readonly device: string | null;
    readonly family: string | null;
  } | null;
  readonly restoredOk: boolean | null;
  readonly restoreError: string | null;
  readonly cancelReason: CancelReason | null;
  readonly error: string | null;
  readonly preview: {
    readonly total: number;
    readonly etaSeconds: number | null;
    readonly excluded: readonly string[];
  } | null;
}

interface JobTarget {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
  readonly family: string;
  readonly quant: string | null;
  state: TargetState;
  loadMs: number | null;
  error: string | null;
  sizes: BenchmarkViewSize[];
  /** Successful sizes, as stored. */
  stored: BenchmarkSizeRecord[];
}

interface Job {
  readonly id: string;
  readonly request: BenchmarkRequest;
  readonly lease: BenchmarkLease;
  readonly targets: JobTarget[];
  readonly startedAt: number;
  finishedAt: number | null;
  state: BenchmarkState;
  phase: BenchmarkPhase | null;
  current: JobTarget | null;
  promptTokens: number | null;
  cancelReason: CancelReason | null;
  error: string | null;
  restoredOk: boolean | null;
  restoreError: string | null;
  wallMs: number;
  finished: number;
}

export interface BenchmarkRunnerDeps {
  readonly host: BenchmarkHost;
  readonly store: BenchmarkStore;
  readonly now?: () => number;
  /** Overrides for tests. */
  readonly loadTimeoutMs?: number;
  readonly callTimeoutMs?: number;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_ERROR);
}

function isActive(job: Job | null): job is Job {
  return job !== null && (job.state === 'running' || job.state === 'cancelling');
}

function selectionOf(t: { engine: string; model: string; device: string | null }): BenchSelection {
  return { engine: t.engine, model: t.model, device: t.device as Device | null };
}

function backendFor(engine: BenchEngine, t: JobTarget): Backend | null {
  const tagged = engine.health().backend;
  if (tagged !== undefined && BACKENDS.includes(tagged)) {
    return tagged as Backend;
  }
  if (t.engine === 'fastflowlm') return 'NPU';
  if (t.engine === 'llama-vulkan') return 'Vulkan';
  return t.device === null ? null : (DEVICE_BACKENDS[t.device] ?? null);
}

function errorRow(targetTokens: number, error: string): BenchmarkViewSize {
  return { targetTokens, inputTokens: null, p50Ms: null, p95Ms: null, answer: null, error };
}

function viewTarget(t: JobTarget): BenchmarkViewTarget {
  return {
    engine: t.engine,
    model: t.model,
    device: t.device,
    family: t.family,
    state: t.state,
    loadMs: t.loadMs,
    error: t.error,
    sizes: t.sizes,
  };
}

function restoreView(lease: BenchmarkLease): BenchmarkView['restore'] {
  const { mode, selection, family } = lease.snapshot;
  return {
    mode,
    engine: selection.engine,
    model: selection.model,
    device: selection.device,
    family,
  };
}

function emptyView(preview: BenchmarkView['preview']): BenchmarkView {
  return {
    state: 'idle',
    phase: null,
    id: null,
    startedBy: null,
    startedAt: null,
    finishedAt: null,
    sizes: [],
    runs: null,
    total: 0,
    completed: 0,
    failed: 0,
    current: null,
    etaSeconds: null,
    targets: [],
    restore: null,
    restoredOk: null,
    restoreError: null,
    cancelReason: null,
    error: null,
    preview,
  };
}

export class BenchmarkRunner {
  readonly #host: BenchmarkHost;
  readonly #store: BenchmarkStore;
  readonly #now: () => number;
  readonly #loadTimeoutMs: number;
  readonly #callTimeoutMs: number;
  #job: Job | null = null;
  #seq = 0;
  #starting = false;
  #settled: Promise<void> = Promise.resolve();

  constructor(deps: BenchmarkRunnerDeps) {
    this.#host = deps.host;
    this.#store = deps.store;
    this.#now = deps.now ?? Date.now;
    this.#loadTimeoutMs = deps.loadTimeoutMs ?? BENCH_LOAD_TIMEOUT_MS;
    this.#callTimeoutMs = deps.callTimeoutMs ?? BENCH_CALL_TIMEOUT_MS;
  }

  /** The job's view; `preview` is filled whenever no job is running or cancelling. */
  async view(): Promise<BenchmarkView> {
    const job = this.#job;
    return this.#snapshot(job, isActive(job) ? null : await this.#preview());
  }

  async start(request: BenchmarkRequest): Promise<BenchmarkView> {
    if (isActive(this.#job) || this.#starting) {
      throw new BenchmarkError(
        409,
        `a benchmark is already running (${this.#job?.id ?? 'starting'})`,
      );
    }
    this.#starting = true;
    try {
      const inventory = await this.#host.benchmarkInventory();
      const { targets } = resolveTargets(request, inventory);
      if (request.targets !== null) {
        for (const t of targets) {
          await this.#host.checkBenchmarkTarget(selectionOf(t));
        }
      }
      const job = this.#createJob(request, targets, inventory);
      this.#job = job;
      this.#settled = this.#run(job);
      return this.#snapshot(job, null);
    } finally {
      this.#starting = false;
    }
  }

  cancel(reason: 'user' | 'shutdown'): BenchmarkView {
    const job = this.#job;
    if (!isActive(job)) {
      throw new BenchmarkError(409, 'no benchmark is running');
    }
    job.cancelReason ??= reason;
    job.state = 'cancelling';
    job.lease.abort(reason);
    return this.#snapshot(job, null);
  }

  /** Resolves when the current job has ended and restored (or immediately without one). */
  settled(): Promise<void> {
    return this.#settled;
  }

  progress(): { completed: number; total: number } | null {
    const job = this.#job;
    if (!isActive(job)) {
      return null;
    }
    return { completed: this.#counts(job).completed, total: job.targets.length };
  }

  // ── the job ────────────────────────────────────────────────────────────────────────────────

  #createJob(
    request: BenchmarkRequest,
    targets: readonly ResolvedTarget[],
    inventory: BenchmarkInventory,
  ): Job {
    const lease = this.#host.beginBenchmark();
    this.#seq += 1;
    return {
      id: `bench-${String(this.#seq)}`,
      request,
      lease,
      targets: targets.map((t) => ({
        ...t,
        quant:
          inventory.models.find((m) => m.engine === t.engine && m.id === t.model)?.quant ?? null,
        state: 'pending',
        loadMs: null,
        error: null,
        sizes: [],
        stored: [],
      })),
      startedAt: this.#now(),
      finishedAt: null,
      state: 'running',
      phase: null,
      current: null,
      promptTokens: null,
      cancelReason: null,
      error: null,
      restoredOk: null,
      restoreError: null,
      wallMs: 0,
      finished: 0,
    };
  }

  async #run(job: Job): Promise<void> {
    let unexpected: unknown = null;
    try {
      await this.#loop(job);
    } catch (error) {
      if (!job.lease.signal.aborted) {
        unexpected = error;
      }
    }
    await this.#finish(job, unexpected);
  }

  async #loop(job: Job): Promise<void> {
    const { signal } = job.lease;
    for (const [i, target] of job.targets.entries()) {
      if (signal.aborted) {
        this.#skipFrom(job, i);
        return;
      }
      try {
        await this.#measureTarget(job, target);
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
        target.state = 'discarded';
        target.sizes = [];
        target.stored = [];
        this.#skipFrom(job, i + 1);
        return;
      }
    }
  }

  #skipFrom(job: Job, from: number): void {
    for (const t of job.targets.slice(from)) {
      if (t.state === 'pending') t.state = 'not-run';
    }
  }

  async #measureTarget(job: Job, t: JobTarget): Promise<void> {
    const { signal } = job.lease;
    const began = this.#now();
    job.current = t;
    job.promptTokens = null;
    const engine = await this.#load(job, t);
    if (engine !== null) {
      await this.#measureSizes(job, t, engine);
    }
    signal.throwIfAborted();
    await this.#persist(job, t, engine);
    signal.throwIfAborted();
    job.wallMs += this.#now() - began;
    job.finished += 1;
  }

  /** Swaps to the target and waits for it; null (and a failed target) when it will not load. */
  async #load(job: Job, t: JobTarget): Promise<BenchEngine | null> {
    const { signal } = job.lease;
    t.state = 'loading';
    job.phase = 'loading';
    try {
      const engine = await this.#host.benchmarkSwap(job.lease, selectionOf(t));
      const began = this.#now();
      const loading = AbortSignal.any([signal, AbortSignal.timeout(this.#loadTimeoutMs)]);
      await engine.ensureReady?.(loading);
      t.loadMs = this.#now() - began;
      return engine;
    } catch (error) {
      signal.throwIfAborted();
      t.state = 'failed';
      t.error = errorText(error);
      return null;
    }
  }

  async #measureSizes(job: Job, t: JobTarget, engine: BenchEngine): Promise<void> {
    const { signal } = job.lease;
    const call: BenchCall = async (request, s) => engine.decide(request, s);
    t.state = 'measuring';
    job.phase = 'measuring';
    let failedAt: number | null = null;
    for (const tokens of job.request.sizes) {
      if (failedAt !== null) {
        t.sizes.push(errorRow(tokens, `skipped after failure at ${String(failedAt)} tokens`));
        continue;
      }
      job.promptTokens = tokens;
      try {
        const r = await measureSize(call, tokens, {
          runs: job.request.runs,
          signal,
          timeoutMs: this.#callTimeoutMs,
        });
        const row = {
          targetTokens: tokens,
          inputTokens: r.inputTokens ?? null,
          p50Ms: r.p50Ms,
          p95Ms: r.p95Ms,
          answer: r.answer,
          error: null,
        };
        t.sizes.push(row);
        t.stored.push(row);
      } catch (error) {
        signal.throwIfAborted();
        failedAt = tokens;
        t.error ??= errorText(error);
        t.sizes.push(errorRow(tokens, errorText(error)));
      }
    }
    t.state = t.stored.length > 0 ? 'done' : 'failed';
  }

  /** Stores a finished target unless the job was aborted meanwhile. */
  async #persist(job: Job, t: JobTarget, engine: BenchEngine | null): Promise<void> {
    try {
      await this.#host.refreshStamps([`${t.engine}|${t.model}`], STAMP_CAP_MS);
    } catch {
      // A stamp that cannot be read only makes the record's freshness unknown.
    }
    if (job.lease.signal.aborted) {
      return;
    }
    const stamp = this.#host.stampFor(t.engine, t.model);
    this.#store.append({
      jobId: job.id,
      engine: t.engine,
      model: t.model,
      device: t.device as Device | null,
      family: t.family,
      quant: t.quant,
      status: t.state === 'done' ? 'ok' : 'failed',
      error: t.error,
      measuredAt: new Date(this.#now()).toISOString(),
      benchVersion: BENCH_VERSION,
      gatewayVersion: GATEWAY_VERSION,
      runtime: stamp?.runtime ?? null,
      modelStamp: stamp?.model ?? null,
      fingerprint: this.#host.fingerprint() ?? 'unknown',
      backend: engine === null ? null : backendFor(engine, t),
      resolvedDevice: engine?.health().resolvedDevice ?? null,
      runs: job.request.runs,
      loadMs: t.loadMs,
      sizes: t.stored,
    });
  }

  async #finish(job: Job, unexpected: unknown): Promise<void> {
    const reason = job.cancelReason ?? job.lease.preempted;
    const restore = reason === null || reason === 'user';
    job.phase = restore ? 'restoring' : null;
    job.current = null;
    let result: { ok: boolean; error: string | null };
    try {
      result = await this.#host.endBenchmark(job.lease, { restore });
    } catch (error) {
      result = { ok: false, error: errorText(error) };
    }
    job.restoredOk = restore ? result.ok : null;
    job.restoreError = restore && !result.ok ? (result.error ?? 'restore failed') : null;
    job.cancelReason = reason;
    job.error = unexpected === null ? null : errorText(unexpected);
    job.phase = null;
    job.finishedAt = this.#now();
    job.state = job.lease.signal.aborted ? 'cancelled' : unexpected === null ? 'done' : 'failed';
  }

  // ── the view ───────────────────────────────────────────────────────────────────────────────

  #counts(job: Job): { completed: number; failed: number } {
    const finished = job.targets.filter((t) => t.state === 'done' || t.state === 'failed');
    return {
      completed: finished.length,
      failed: finished.filter((t) => t.state === 'failed').length,
    };
  }

  /** The last stored run time of a target, else a minute. */
  #estimateMs(t: { engine: string; model: string; device: string | null }, runs: number): number {
    const last = this.#store
      .records()
      .findLast((r) => r.engine === t.engine && r.model === t.model && r.device === t.device);
    if (last === undefined) {
      return UNKNOWN_TARGET_MS;
    }
    const sum = last.sizes.reduce((total, s) => total + s.p50Ms * (runs + 1), 0);
    return (last.loadMs ?? 0) + sum;
  }

  #etaSeconds(job: Job): number | null {
    if (!isActive(job)) {
      return null;
    }
    const open = new Set<TargetState>(['pending', 'loading', 'measuring']);
    const remaining = job.targets.filter((t) => open.has(t.state));
    const ms =
      job.finished > 0
        ? remaining.length * (job.wallMs / job.finished)
        : remaining.reduce((sum, t) => sum + this.#estimateMs(t, job.request.runs), 0);
    return Math.round(ms / 1000);
  }

  async #preview(): Promise<NonNullable<BenchmarkView['preview']>> {
    const inventory = await this.#host.benchmarkInventory();
    const request = parseBenchmarkRequest({});
    try {
      const { targets, excluded } = resolveTargets(request, inventory);
      const ms = targets.reduce((sum, t) => sum + this.#estimateMs(t, request.runs), 0);
      return { total: targets.length, etaSeconds: Math.round(ms / 1000), excluded };
    } catch (error) {
      if (!(error instanceof BenchmarkError)) throw error;
      const excluded = inventory.engines
        .filter((e) => e.selectable && e.openaiLike)
        .map((e) => e.id);
      return { total: 0, etaSeconds: 0, excluded };
    }
  }

  #snapshot(job: Job | null, preview: BenchmarkView['preview']): BenchmarkView {
    if (job === null) {
      return emptyView(preview);
    }
    const { completed, failed } = this.#counts(job);
    const cur = job.current;
    return {
      state: job.state === 'running' && job.lease.signal.aborted ? 'cancelling' : job.state,
      phase: job.phase,
      id: job.id,
      startedBy: job.request.client,
      startedAt: new Date(job.startedAt).toISOString(),
      finishedAt: job.finishedAt === null ? null : new Date(job.finishedAt).toISOString(),
      sizes: job.request.sizes,
      runs: job.request.runs,
      total: job.targets.length,
      completed,
      failed,
      current:
        cur === null
          ? null
          : {
              engine: cur.engine,
              model: cur.model,
              device: cur.device,
              family: cur.family,
              promptTokens: job.promptTokens,
            },
      etaSeconds: this.#etaSeconds(job),
      targets: job.targets.map(viewTarget),
      restore: restoreView(job.lease),
      restoredOk: job.restoredOk,
      restoreError: job.restoreError,
      cancelReason: job.cancelReason ?? (job.state === 'running' ? null : job.lease.preempted),
      error: job.error,
      preview: isActive(job) ? null : preview,
    };
  }
}
