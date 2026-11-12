/**
 * The gateway's per-machine view of one model family (`recommendation.machine` in
 * `GET /v1/engines`) and the measurements behind it (`models[].measured`): lenient parsers.
 * Older gateways send none of it, so every field may be missing; unknown codes become null.
 */
import { z } from 'zod';

import { parseCode } from './recommendation.ts';

const text0 = z.string().nullable();

const percentilesSchema = z.object({ p50Ms: z.number(), p95Ms: z.number() });

const failureSchema = z.object({ error: z.string(), at: text0 });

/** One device's benchmark of a model. */
export const measuredSchema = z.object({
  device: text0,
  typical: percentilesSchema.nullable(),
  long: percentilesSchema.nullable(),
  sizes: z.array(
    percentilesSchema.extend({ targetTokens: z.number(), inputTokens: z.number().nullable() }),
  ),
  runs: z.number().nullable(),
  /** Too few runs to rank on (1-2). */
  provisional: z.boolean(),
  measuredAt: text0,
  freshness: z.enum(['fresh', 'stale', 'unknown']).nullable(),
  staleReason: text0,
  failed: failureSchema.nullable(),
});

const optionSchema = z.object({
  engine: z.string(),
  model: z.string(),
  device: text0,
  backend: text0,
  code: z
    .enum([
      'available',
      'no-hardware',
      'not-confirmed',
      'unsupported-platform',
      'no-memory',
      'uncalibrated',
    ])
    .nullable(),
  eligible: z.boolean(),
  supported: z.boolean(),
  ready: z.boolean(),
  reason: z.string(),
  family: z.string(),
  quant: text0,
  downloaded: z.boolean(),
  calibrated: z.boolean(),
  active: z.boolean(),
  measured: measuredSchema.nullable(),
  failed: failureSchema.nullable(),
});

const runtimeSchema = z.object({
  engine: z.string(),
  device: text0,
  backend: text0,
  /** The representative variant. */
  pick: optionSchema.nullable(),
  variants: z.array(optionSchema),
});

export const machineSchema = z.object({
  family: z.string(),
  familyLabel: z.string(),
  source: z.enum(['manual', 'preferred', 'default']).nullable(),
  availability: z.enum(['ok', 'family-unavailable']).nullable(),
  best: optionSchema.nullable(),
  runnerUp: optionSchema.nullable(),
  ratio: z.number().nullable(),
  reason: z
    .enum([
      'fastest-measured',
      'tie-dedicated',
      'tie-steadier',
      'tie-ladder',
      'only-measured',
      'estimated',
      'only-option',
    ])
    .nullable(),
  action: z.enum(['none', 'use', 'download', 'install']).nullable(),
  /** A ready, downloaded runtime lacks a rankable measurement, or one failed. */
  partial: z.boolean(),
  stale: z.boolean(),
  staleReason: text0,
  runtimes: z.array(runtimeSchema),
  fasterFamily: z
    .object({
      family: z.string(),
      label: z.string(),
      best: optionSchema.nullable(),
      ratio: z.number().nullable(),
    })
    .nullable(),
});

export const familySchema = z.object({ id: z.string(), label: z.string() });
export const formatSchema = z.object({ short: z.string(), label: z.string() });
export const progressSchema = z.object({ completed: z.number(), total: z.number() });

export type Measured = z.output<typeof measuredSchema>;
export type MachineOption = z.output<typeof optionSchema>;
export type RuntimeGroup = z.output<typeof runtimeSchema>;
export type MachineRecommendation = z.output<typeof machineSchema>;
export type MachineReason = NonNullable<MachineRecommendation['reason']>;
export type MachineAction = NonNullable<MachineRecommendation['action']>;
export type Freshness = NonNullable<Measured['freshness']>;
export type Labeled = z.output<typeof familySchema>;

type Fields = Record<string, unknown>;

const MAX_ITEMS = 50;
const MAX_SIZES = 12;
const MAX_TEXT = 500;

function fields(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : null;
}

function text(value: unknown): string | null {
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

function parsePercentiles(value: unknown): { p50Ms: number; p95Ms: number } | null {
  const v = fields(value);
  const p50Ms = num(v?.['p50Ms']);
  const p95Ms = num(v?.['p95Ms']);
  return p50Ms === null || p95Ms === null ? null : { p50Ms, p95Ms };
}

function parseSize(value: unknown): Measured['sizes'][number] | null {
  const v = fields(value);
  const targetTokens = num(v?.['targetTokens']);
  const p = parsePercentiles(v);
  if (v === null || targetTokens === null || p === null) {
    return null;
  }
  return { targetTokens, inputTokens: num(v['inputTokens']), ...p };
}

function parseFailure(value: unknown): Measured['failed'] {
  const v = fields(value);
  const error = text(v?.['error']);
  return v === null || error === null ? null : { error, at: text(v['at']) };
}

const FRESHNESS: readonly Freshness[] = ['fresh', 'stale', 'unknown'];

/** Lenient read of one `models[].measured[]` entry (or a machine option's `measured`). */
export function parseMeasured(value: unknown): Measured | null {
  const v = fields(value);
  if (v === null) {
    return null;
  }
  return {
    device: text(v['device']),
    typical: parsePercentiles(v['typical']),
    long: parsePercentiles(v['long']),
    sizes: items(v['sizes'], MAX_SIZES, parseSize),
    runs: num(v['runs']),
    provisional: v['provisional'] === true,
    measuredAt: text(v['measuredAt']),
    freshness: oneOf(v['freshness'], FRESHNESS),
    staleReason: text(v['staleReason']),
    failed: parseFailure(v['failed']),
  };
}

export function parseMeasuredList(value: unknown): Measured[] {
  return items(value, MAX_ITEMS, parseMeasured);
}

function parseOption(value: unknown): MachineOption | null {
  const v = fields(value);
  const engine = text(v?.['engine']);
  const model = text(v?.['model']);
  if (v === null || engine === null || model === null) {
    return null;
  }
  return {
    engine,
    model,
    device: text(v['device']),
    backend: text(v['backend']),
    code: parseCode(v['code']),
    eligible: v['eligible'] === true,
    supported: v['supported'] !== false,
    ready: v['ready'] === true,
    reason: text(v['reason']) ?? '',
    family: text(v['family']) ?? '',
    quant: text(v['quant']),
    downloaded: v['downloaded'] === true,
    calibrated: v['calibrated'] !== false,
    active: v['active'] === true,
    measured: parseMeasured(v['measured']),
    failed: parseFailure(v['failed']),
  };
}

function parseRuntime(value: unknown): RuntimeGroup | null {
  const v = fields(value);
  const engine = text(v?.['engine']);
  if (v === null || engine === null) {
    return null;
  }
  return {
    engine,
    device: text(v['device']),
    backend: text(v['backend']),
    pick: parseOption(v['pick']),
    variants: items(v['variants'], MAX_ITEMS, parseOption),
  };
}

function parseFasterFamily(value: unknown): MachineRecommendation['fasterFamily'] {
  const v = fields(value);
  const family = text(v?.['family']);
  if (v === null || family === null) {
    return null;
  }
  return {
    family,
    label: text(v['label']) ?? family,
    best: parseOption(v['best']),
    ratio: num(v['ratio']),
  };
}

const REASONS: readonly MachineReason[] = [
  'fastest-measured',
  'tie-dedicated',
  'tie-steadier',
  'tie-ladder',
  'only-measured',
  'estimated',
  'only-option',
];

/** Lenient read of `recommendation.machine`; null when absent or without a family. */
export function parseMachine(value: unknown): MachineRecommendation | null {
  const v = fields(value);
  const family = text(v?.['family']);
  if (v === null || family === null) {
    return null;
  }
  return {
    family,
    familyLabel: text(v['familyLabel']) ?? family,
    source: oneOf(v['source'], ['manual', 'preferred', 'default']),
    availability: oneOf(v['availability'], ['ok', 'family-unavailable']),
    best: parseOption(v['best']),
    runnerUp: parseOption(v['runnerUp']),
    ratio: num(v['ratio']),
    reason: oneOf(v['reason'], REASONS),
    action: oneOf(v['action'], ['none', 'use', 'download', 'install']),
    partial: v['partial'] === true,
    stale: v['stale'] === true,
    staleReason: text(v['staleReason']),
    runtimes: items(v['runtimes'], MAX_ITEMS, parseRuntime),
    fasterFamily: parseFasterFamily(v['fasterFamily']),
  };
}

/** `models[].family`: the id is required, the label falls back to it. */
export function parseFamily(value: unknown): Labeled | null {
  const v = fields(value);
  const id = text(v?.['id']);
  return v === null || id === null ? null : { id, label: text(v['label']) ?? id };
}

/** `models[].format`: `short` is required, `label` falls back to it. */
export function parseFormat(value: unknown): { short: string; label: string } | null {
  const v = fields(value);
  const short = text(v?.['short']);
  return v === null || short === null ? null : { short, label: text(v['label']) ?? short };
}

/** `active.benchmark`: progress of a running benchmark job. */
export function parseProgress(value: unknown): { completed: number; total: number } | null {
  const v = fields(value);
  const completed = num(v?.['completed']);
  const total = num(v?.['total']);
  return completed === null || total === null ? null : { completed, total };
}
