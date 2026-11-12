import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  BENCH_VERSION,
  JsonBenchmarkStore,
  MAX_BENCH_RECORDS,
  MemoryBenchmarkStore,
  type BenchmarkRecord,
} from '../src/benchmark-store.ts';
import { tempPaths } from './helpers.ts';

function record(index: number, status: 'ok' | 'failed' = 'ok'): BenchmarkRecord {
  return {
    jobId: `bench-${String(index)}`,
    engine: 'llama-vulkan',
    model: 'd3-lite-q8_0',
    device: null,
    family: 'vllm-sr/d3-lite',
    quant: 'Q8_0',
    status,
    error: status === 'failed' ? 'failed' : null,
    measuredAt: new Date(index).toISOString(),
    benchVersion: BENCH_VERSION,
    gatewayVersion: '2.0.0',
    runtime: null,
    modelStamp: null,
    fingerprint: '0123456789abcdef',
    backend: 'Vulkan',
    resolvedDevice: null,
    runs: 3,
    loadMs: 10,
    sizes: [],
  };
}

describe('benchmark stores', () => {
  it('round trips records in the JSON store and keeps the most recent 500', () => {
    const file = join(tempPaths().data, 'benchmarks.json');
    const store = new JsonBenchmarkStore(file);
    for (let index = 0; index < MAX_BENCH_RECORDS + 1; index++) store.append(record(index));
    const reopened = new JsonBenchmarkStore(file);
    assert.equal(reopened.records().length, MAX_BENCH_RECORDS);
    assert.equal(reopened.records()[0]?.jobId, 'bench-1');
    assert.equal(reopened.records().at(-1)?.jobId, 'bench-500');
  });

  it('writes private files atomically in a private directory', () => {
    const data = tempPaths().data;
    const file = join(data, 'nested', 'benchmarks.json');
    const store = new JsonBenchmarkStore(file);
    store.append(record(1));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(data, 'nested')).mode & 0o777, 0o700);
    assert.equal(readdirSync(join(data, 'nested')).includes(`benchmarks.json.${String(process.pid)}.tmp`), false);
    assert.ok(existsSync(file));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      version: BENCH_VERSION,
      records: [record(1)],
    });
  });

  it('renames an unparsable file and warns once', () => {
    const file = join(tempPaths().data, 'benchmarks.json');
    writeFileSync(file, '{broken');
    const warnings: string[] = [];
    const store = new JsonBenchmarkStore(file, (message) => warnings.push(message));
    assert.equal(store.records().length, 0);
    assert.equal(warnings.length, 1);
    assert.ok(readdirSync(join(file, '..')).some((name) => name.startsWith('benchmarks.json.corrupt-')));
  });

  it('renames unknown-version and overlarge files', () => {
    const data = tempPaths().data;
    const unknown = join(data, 'unknown.json');
    writeFileSync(unknown, JSON.stringify({ version: 2, records: [] }));
    assert.equal(new JsonBenchmarkStore(unknown).records().length, 0);
    const large = join(data, 'large.json');
    writeFileSync(large, ' '.repeat(1024 * 1024 + 1));
    assert.equal(new JsonBenchmarkStore(large).records().length, 0);
    assert.ok(readdirSync(data).some((name) => name.startsWith('unknown.json.corrupt-')));
    assert.ok(readdirSync(data).some((name) => name.startsWith('large.json.corrupt-')));
  });

  it('keeps the latest failure available alongside earlier successful records', () => {
    const store = new MemoryBenchmarkStore();
    store.append(record(1));
    store.append(record(2, 'failed'));
    assert.deepEqual(store.records().map(({ status }) => status), ['ok', 'failed']);
  });
});
