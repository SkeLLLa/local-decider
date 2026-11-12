/**
 * The pure half of the benchmark job: parsing `POST /v1/benchmark` and resolving which
 * `(engine, model, device)` targets to measure. The runner and the engine lease live elsewhere.
 */
import { DEVICES } from './engines/descriptor.ts';
import { SELECTABLE_IDS } from './engines/registry.ts';

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
