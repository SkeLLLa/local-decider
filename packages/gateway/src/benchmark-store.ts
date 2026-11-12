import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Device } from './engines/descriptor.ts';
import type { Backend } from './engines/selector.ts';

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

  constructor(
    file: string,
    warn: (message: string) => void = () => undefined,
  ) {
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

function readRecords(file: string, warn: (message: string) => void): BenchmarkRecord[] {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return corrupt(file, warn);
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isStoreFile(parsed)) return corrupt(file, warn);
    return parsed.records.slice(-MAX_BENCH_RECORDS);
  } catch (error) {
    if (isMissing(error)) return [];
    return corrupt(file, warn);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isStoreFile(value: unknown): value is { version: number; records: BenchmarkRecord[] } {
  if (typeof value !== 'object' || value === null || !('version' in value) || !('records' in value)) {
    return false;
  }
  return (
    value.version === BENCH_VERSION &&
    Array.isArray(value.records) &&
    value.records.every(isBenchmarkRecord)
  );
}

function isBenchmarkRecord(value: unknown): value is BenchmarkRecord {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'jobId' in value && typeof value.jobId === 'string' &&
    'engine' in value && typeof value.engine === 'string' &&
    'model' in value && typeof value.model === 'string' &&
    'status' in value && (value.status === 'ok' || value.status === 'failed') &&
    'fingerprint' in value && typeof value.fingerprint === 'string' &&
    'sizes' in value && Array.isArray(value.sizes)
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
