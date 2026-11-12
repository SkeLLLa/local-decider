/**
 * The gateway's benchmark job (`GET /v1/benchmark`): the RPC schema, a lenient parser and the
 * poll rule. Unknown codes become null, lists are capped and a malformed target is dropped.
 */
import { z } from 'zod';

const text = z.string().nullable();
const count = z.number().nullable();

const STATES = ['idle', 'running', 'cancelling', 'done', 'cancelled', 'failed'] as const;
const PHASES = ['loading', 'measuring', 'restoring'] as const;
const STARTERS = ['paseo', 'cli', 'api'] as const;
const TARGET_STATES = [
  'pending',
  'loading',
  'measuring',
  'done',
  'failed',
  'discarded',
  'not-run',
] as const;
const CANCEL_REASONS = ['user', 'superseded', 'config-changed', 'shutdown'] as const;
const MODES = ['auto', 'manual'] as const;

const sizeRowSchema = z.object({
  targetTokens: z.number(),
  inputTokens: count,
  p50Ms: count,
  p95Ms: count,
  /** `done` or a short failure code; kept as sent. */
  answer: text,
  error: text,
});

const targetSchema = z.object({
  engine: z.string(),
  model: z.string(),
  device: text,
  family: text,
  state: z.enum(TARGET_STATES).nullable(),
  loadMs: count,
  error: text,
  sizes: z.array(sizeRowSchema),
});

export const benchmarkSchema = z.object({
  state: z.enum(STATES).nullable(),
  phase: z.enum(PHASES).nullable(),
  id: text,
  startedBy: z.enum(STARTERS).nullable(),
  startedAt: text,
  finishedAt: text,
  sizes: z.array(z.number()),
  runs: count,
  total: z.number(),
  completed: z.number(),
  failed: z.number(),
  current: z
    .object({
      engine: z.string(),
      model: z.string(),
      device: text,
      family: text,
      promptTokens: count,
    })
    .nullable(),
  etaSeconds: count,
  targets: z.array(targetSchema),
  /** What the gateway puts back after the run. */
  restore: z
    .object({
      mode: z.enum(MODES).nullable(),
      engine: text,
      model: text,
      device: text,
      family: text,
    })
    .nullable(),
  restoredOk: z.boolean().nullable(),
  restoreError: text,
  cancelReason: z.enum(CANCEL_REASONS).nullable(),
  error: text,
  /** What a run would do; filled whenever no job is running or cancelling. */
  preview: z
    .object({ total: z.number(), etaSeconds: count, excluded: z.array(z.string()) })
    .nullable(),
});

export type BenchmarkView = z.output<typeof benchmarkSchema>;
export type BenchmarkTarget = z.output<typeof targetSchema>;
export type BenchmarkState = NonNullable<BenchmarkView['state']>;

const MAX_ITEMS = 200;
const MAX_SIZES = 12;
const MAX_TEXT = 500;

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, MAX_TEXT) : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function items<T>(value: unknown, max: number, parse: (entry: unknown) => T | null): T[] {
  const out: T[] = [];
  for (const entry of Array.isArray(value) ? (value as unknown[]).slice(0, max) : []) {
    const parsed = parse(entry);
    if (parsed !== null) {
      out.push(parsed);
    }
  }
  return out;
}

function parseSizeRow(value: unknown): BenchmarkTarget['sizes'][number] | null {
  const v = fields(value);
  const targetTokens = num(v?.['targetTokens']);
  if (v === null || targetTokens === null) {
    return null;
  }
  return {
    targetTokens,
    inputTokens: num(v['inputTokens']),
    p50Ms: num(v['p50Ms']),
    p95Ms: num(v['p95Ms']),
    answer: str(v['answer']),
    error: str(v['error']),
  };
}

function parseTarget(value: unknown): BenchmarkTarget | null {
  const v = fields(value);
  const engine = str(v?.['engine']);
  const model = str(v?.['model']);
  if (v === null || engine === null || model === null) {
    return null;
  }
  return {
    engine,
    model,
    device: str(v['device']),
    family: str(v['family']),
    state: oneOf(v['state'], TARGET_STATES),
    loadMs: num(v['loadMs']),
    error: str(v['error']),
    sizes: items(v['sizes'], MAX_SIZES, parseSizeRow),
  };
}

function parseCurrent(value: unknown): BenchmarkView['current'] {
  const v = fields(value);
  const engine = str(v?.['engine']);
  const model = str(v?.['model']);
  if (v === null || engine === null || model === null) {
    return null;
  }
  return {
    engine,
    model,
    device: str(v['device']),
    family: str(v['family']),
    promptTokens: num(v['promptTokens']),
  };
}

function parseRestore(value: unknown): BenchmarkView['restore'] {
  const v = fields(value);
  if (v === null) {
    return null;
  }
  return {
    mode: oneOf(v['mode'], MODES),
    engine: str(v['engine']),
    model: str(v['model']),
    device: str(v['device']),
    family: str(v['family']),
  };
}

function parsePreview(value: unknown): BenchmarkView['preview'] {
  const v = fields(value);
  const total = num(v?.['total']);
  if (v === null || total === null) {
    return null;
  }
  return {
    total,
    etaSeconds: num(v['etaSeconds']),
    excluded: items(v['excluded'], MAX_ITEMS, str),
  };
}

/** Lenient read of `GET /v1/benchmark`; null when the body is not an object. */
export function parseBenchmark(body: unknown): BenchmarkView | null {
  const v = fields(body);
  if (v === null) {
    return null;
  }
  return {
    state: oneOf(v['state'], STATES),
    phase: oneOf(v['phase'], PHASES),
    id: str(v['id']),
    startedBy: oneOf(v['startedBy'], STARTERS),
    startedAt: str(v['startedAt']),
    finishedAt: str(v['finishedAt']),
    sizes: items(v['sizes'], MAX_SIZES, num),
    runs: num(v['runs']),
    total: num(v['total']) ?? 0,
    completed: num(v['completed']) ?? 0,
    failed: num(v['failed']) ?? 0,
    current: parseCurrent(v['current']),
    etaSeconds: num(v['etaSeconds']),
    targets: items(v['targets'], MAX_ITEMS, parseTarget),
    restore: parseRestore(v['restore']),
    restoredOk: typeof v['restoredOk'] === 'boolean' ? v['restoredOk'] : null,
    restoreError: str(v['restoreError']),
    cancelReason: oneOf(v['cancelReason'], CANCEL_REASONS),
    error: str(v['error']),
    preview: parsePreview(v['preview']),
  };
}

/** Poll `GET /v1/benchmark` this often while a job runs or is being cancelled. */
export const BENCHMARK_POLL_MS = 1000;

export function benchmarkPollInterval(view: BenchmarkView | null | undefined): number | false {
  return view?.state === 'running' || view?.state === 'cancelling' ? BENCHMARK_POLL_MS : false;
}
