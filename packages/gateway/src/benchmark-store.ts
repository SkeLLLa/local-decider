import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Device } from './engines/descriptor.ts';
import type { RuntimeStamp } from './engines/descriptor.ts';
import { familyId } from './engines/families.ts';
import type { Measured, MeasurementView, Measurements } from './engines/ranking.ts';
import { TYPICAL_TOKENS, LONG_TOKENS } from './engines/ranking.ts';
import type { EngineId } from './engines/registry.ts';
import type { Backend } from './engines/selector.ts';
import { catalogModel } from './models.ts';

export const BENCH_VERSION = 1;
export const MAX_BENCH_RECORDS = 500;
const MAX_FILE_BYTES = 1024 * 1024;

export interface BenchmarkSizeRecord {
  readonly targetTokens: number;
  readonly inputTokens: number | null;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly answer: string;
  readonly error: string | null;
}

export interface BenchmarkRecord {
  readonly jobId: string;
  readonly engine: string;
  readonly model: string;
  readonly device: Device | null;
  readonly family: string | null;
  readonly quant: string | null;
  readonly status: 'ok' | 'failed';
  readonly error: string | null;
  readonly measuredAt: string;
  readonly benchVersion: number;
  readonly gatewayVersion: string;
  readonly runtime: string | null;
  readonly modelStamp: string | null;
  readonly fingerprint: string;
  readonly backend: Backend | null;
  readonly resolvedDevice: string | null;
  readonly runs: number;
  readonly loadMs: number | null;
  readonly sizes: readonly BenchmarkSizeRecord[];
}

export interface BenchmarkStore {
  append(record: BenchmarkRecord): void;
  records(): readonly BenchmarkRecord[];
}

export type StampLookup = (engine: string, model: string) => RuntimeStamp | undefined;

export interface MeasurementDetails {
  readonly record: BenchmarkRecord | null;
  readonly view: MeasurementView;
}

export class MemoryBenchmarkStore implements BenchmarkStore {
  #records: BenchmarkRecord[] = [];

  append(record: BenchmarkRecord): void {
    this.#records.push(structuredClone(record));
    this.#records = this.#records.slice(-MAX_BENCH_RECORDS);
  }

  records(): readonly BenchmarkRecord[] {
    return this.#records;
  }
}

export class JsonBenchmarkStore implements BenchmarkStore {
  readonly file: string;
  #records: BenchmarkRecord[];

  constructor(file: string, warn: (message: string) => void = () => undefined) {
    this.file = file;
    this.#records = readRecords(file, warn);
  }

  append(record: BenchmarkRecord): void {
    const next = [...this.#records, structuredClone(record)].slice(-MAX_BENCH_RECORDS);
    writeRecords(this.file, next);
    this.#records = next;
  }

  records(): readonly BenchmarkRecord[] {
    return this.#records;
  }
}

/** Latest valid record per runtime, with its latest successful record for display and ranking. */
export function measurementDetailsFor(
  records: readonly BenchmarkRecord[],
  fingerprint: string | undefined,
  stamps: StampLookup,
): ReadonlyMap<string, MeasurementDetails> {
  const latest = new Map<string, BenchmarkRecord>();
  const successful = new Map<string, BenchmarkRecord>();
  for (const record of records) {
    if (!knownRecord(record) || (fingerprint !== undefined && record.fingerprint !== fingerprint)) {
      continue;
    }
    const key = `${record.engine}|${record.model}|${record.device ?? ''}`;
    latest.set(key, record);
    if (record.status === 'ok') successful.set(key, record);
  }
  return new Map(
    [...latest].map(([key, record]) => {
      const okRecord = successful.get(key) ?? null;
      const latestFailure = record.status === 'failed' ? record : null;
      const stamp =
        fingerprint === undefined || okRecord === null
          ? undefined
          : stamps(okRecord.engine, okRecord.model);
      return [
        key,
        {
          record: okRecord,
          view: {
            ok: okRecord === null ? null : measured(okRecord, stamp, fingerprint === undefined),
            failed:
              latestFailure === null
                ? null
                : {
                    error: latestFailure.error ?? 'benchmark failed',
                    at: latestFailure.measuredAt,
                  },
          },
        },
      ];
    }),
  );
}

/** Measurements keyed by `${engine}|${model}|${device ?? ''}` for the selector. */
export function measurementsFor(
  records: readonly BenchmarkRecord[],
  fingerprint: string | undefined,
  stamps: StampLookup,
): Measurements {
  return new Map(
    [...measurementDetailsFor(records, fingerprint, stamps)].map(([key, details]) => [
      key,
      details.view,
    ]),
  );
}

function knownRecord(record: BenchmarkRecord): boolean {
  if (record.benchVersion !== BENCH_VERSION) return false;
  const model = catalogModel(record.model, record.engine as EngineId);
  return model !== undefined && record.family === familyId(model);
}

function measured(
  record: BenchmarkRecord,
  stamp: RuntimeStamp | undefined,
  fingerprintUnknown: boolean,
): Measured | null {
  const typical = record.sizes.find((size) => size.targetTokens === TYPICAL_TOKENS);
  if (typical === undefined) return null;
  const long = record.sizes.find((size) => size.targetTokens === LONG_TOKENS);
  const stale = staleReason(record, stamp, fingerprintUnknown);
  return {
    typical: { p50Ms: typical.p50Ms, p95Ms: typical.p95Ms },
    long: long === undefined ? null : { p50Ms: long.p50Ms, p95Ms: long.p95Ms },
    runs: record.runs,
    measuredAt: record.measuredAt,
    freshness: stale === undefined ? 'fresh' : stale === 'unknown' ? 'unknown' : 'stale',
    staleReason: stale !== undefined && stale !== 'unknown' ? stale : null,
    provisional: record.runs < 3,
  };
}

function staleReason(
  record: BenchmarkRecord,
  stamp: RuntimeStamp | undefined,
  fingerprintUnknown: boolean,
): string | undefined {
  if (fingerprintUnknown || stamp === undefined) return 'unknown';
  // A record saved without a stamp the host can read now cannot be checked against it.
  if (
    (record.runtime === null && stamp.runtime !== null) ||
    (record.modelStamp === null && stamp.model !== null)
  ) {
    return 'unknown';
  }
  if (record.runtime !== null && stamp.runtime !== null && record.runtime !== stamp.runtime) {
    return `${record.runtime} → ${stamp.runtime}`;
  }
  if (record.modelStamp !== null && record.modelStamp !== stamp.model) {
    return 'model files changed';
  }
  return undefined;
}

function readRecords(file: string, warn: (message: string) => void): BenchmarkRecord[] {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return corrupt(file, warn);
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isStoreFile(parsed)) return corrupt(file, warn);
    // A malformed record (a hand edit) is dropped on its own rather than the whole file.
    return parsed.records.filter(isBenchmarkRecord).slice(-MAX_BENCH_RECORDS);
  } catch (error) {
    if (isMissing(error)) return [];
    return corrupt(file, warn);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isStoreFile(value: unknown): value is { version: number; records: unknown[] } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    !('records' in value)
  ) {
    return false;
  }
  return value.version === BENCH_VERSION && Array.isArray(value.records);
}

const RECORD_FIELDS = {
  jobId: 'string',
  engine: 'string',
  model: 'string',
  fingerprint: 'string',
  measuredAt: 'string',
  runs: 'number',
} as const;
const SIZE_FIELDS = { targetTokens: 'number', p50Ms: 'number', p95Ms: 'number' } as const;

/** `value` is an object whose `fields` each have the given `typeof`. */
function hasFields(value: unknown, fields: Readonly<Record<string, string>>): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const entries = value as Readonly<Record<string, unknown>>;
  return Object.entries(fields).every(([key, type]) => typeof entries[key] === type);
}

function isBenchmarkRecord(value: unknown): value is BenchmarkRecord {
  if (!hasFields(value, RECORD_FIELDS)) return false;
  const { status, sizes } = value as { status?: unknown; sizes?: unknown };
  return (
    (status === 'ok' || status === 'failed') &&
    Array.isArray(sizes) &&
    sizes.every((size) => hasFields(size, SIZE_FIELDS))
  );
}

function corrupt(file: string, warn: (message: string) => void): BenchmarkRecord[] {
  try {
    renameSync(file, `${file}.corrupt-${String(Date.now())}`);
  } catch {
    // The store still starts empty if the damaged file cannot be moved.
  }
  warn('benchmark store is invalid; starting with no benchmark records');
  return [];
}

function writeRecords(file: string, records: readonly BenchmarkRecord[]): void {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: BENCH_VERSION, records }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
}
