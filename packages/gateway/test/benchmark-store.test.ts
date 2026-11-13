import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  BENCH_VERSION,
  JsonBenchmarkStore,
  MAX_BENCH_RECORDS,
  MemoryBenchmarkStore,
  measurementDetailsFor,
  measurementsFor,
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
    sizes: [
      {
        targetTokens: 1024,
        inputTokens: 1024,
        p50Ms: 200,
        p95Ms: 250,
        answer: 'done',
        error: null,
      },
    ],
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
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      version: BENCH_VERSION,
      records: [record(1)],
    });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(data, 'nested')).mode & 0o777, 0o700);
    assert.equal(
      readdirSync(join(data, 'nested')).includes(`benchmarks.json.${String(process.pid)}.tmp`),
      false,
    );
  });

  it('renames an unparsable file and warns once', () => {
    const file = join(tempPaths().data, 'benchmarks.json');
    writeFileSync(file, '{broken');
    const warnings: string[] = [];
    const store = new JsonBenchmarkStore(file, (message) => warnings.push(message));
    assert.equal(store.records().length, 0);
    assert.equal(warnings.length, 1);
    assert.ok(
      readdirSync(join(file, '..')).some((name) => name.startsWith('benchmarks.json.corrupt-')),
    );
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
    assert.deepEqual(
      store.records().map(({ status }) => status),
      ['ok', 'failed'],
    );
  });

  it('uses the latest success for ranking and exposes a later failure', () => {
    const store = new MemoryBenchmarkStore();
    store.append(record(1));
    store.append(record(2, 'failed'));
    const view = measurementsFor(store.records(), '0123456789abcdef', () => ({
      runtime: null,
      model: null,
    })).get('llama-vulkan|d3-lite-q8_0|');
    assert.equal(view?.ok?.typical.p50Ms, 200);
    assert.deepEqual(view?.failed, { error: 'failed', at: new Date(2).toISOString() });
  });

  it('marks changed runtime or model stamps stale and leaves unknown fingerprints unranked', () => {
    const prior = {
      ...record(1),
      runtime: 'llama.cpp b1',
      modelStamp: 'sha256:old',
    };
    const stale = measurementDetailsFor([prior], prior.fingerprint, () => ({
      runtime: 'llama.cpp b2',
      model: 'sha256:new',
    })).get('llama-vulkan|d3-lite-q8_0|');
    assert.equal(stale?.view.ok?.freshness, 'stale');
    assert.equal(stale?.view.ok?.staleReason, 'llama.cpp b1 → llama.cpp b2');

    const unknown = measurementDetailsFor([prior], undefined, () => undefined).get(
      'llama-vulkan|d3-lite-q8_0|',
    );
    assert.equal(unknown?.view.ok?.freshness, 'unknown');
    assert.equal(unknown?.view.ok?.provisional, false);
  });

  it('treats a known fingerprint with no stamp read yet as unknown, which does not rank', () => {
    const prior = { ...record(1), runtime: 'llama.cpp b1', modelStamp: null };
    const key = 'llama-vulkan|d3-lite-q8_0|';
    const details = measurementDetailsFor([prior], prior.fingerprint, () => undefined).get(key);
    assert.equal(details?.view.ok?.freshness, 'unknown');
    assert.equal(details?.view.ok?.staleReason, null);
    const fresh = measurementDetailsFor([prior], prior.fingerprint, () => ({
      runtime: 'llama.cpp b1',
      model: null,
    })).get(key);
    assert.equal(fresh?.view.ok?.freshness, 'fresh');
  });

  it('treats a record saved without a stamp the host now reads as unknown', () => {
    const key = 'llama-vulkan|d3-lite-q8_0|';
    const unstamped = record(1);
    const now = { runtime: 'llama.cpp b2', model: 'sha256:new' };
    const details = measurementDetailsFor([unstamped], unstamped.fingerprint, () => now).get(key);
    assert.equal(details?.view.ok?.freshness, 'unknown');
    const noModel = { ...unstamped, runtime: 'llama.cpp b2' };
    const partly = measurementDetailsFor([noModel], noModel.fingerprint, () => now).get(key);
    assert.equal(partly?.view.ok?.freshness, 'unknown');
  });

  it('drops malformed records on their own and keeps the file', () => {
    const file = join(tempPaths().data, 'benchmarks.json');
    const good = record(1);
    const bad = [
      { ...record(2), sizes: [null] },
      { ...record(3), sizes: [{ targetTokens: 1024, p50Ms: 'fast', p95Ms: 1 }] },
      { ...record(4), runs: '3' },
    ];
    writeFileSync(file, JSON.stringify({ version: BENCH_VERSION, records: [good, ...bad] }));
    const warnings: string[] = [];
    const store = new JsonBenchmarkStore(file, (message) => warnings.push(message));
    assert.deepEqual(
      store.records().map(({ jobId }) => jobId),
      ['bench-1'],
    );
    assert.equal(warnings.length, 0);
    assert.ok(existsSync(file));
  });

  it('ignores mismatched fingerprints, unknown bench versions, and unknown catalogue models', () => {
    const accepted = record(1);
    const details = measurementDetailsFor(
      [
        { ...accepted, fingerprint: 'ffffffffffffffff' },
        { ...accepted, benchVersion: BENCH_VERSION + 1 },
        { ...accepted, model: 'missing-model' },
      ],
      accepted.fingerprint,
      () => ({ runtime: null, model: null }),
    );
    assert.equal(details.size, 0);
  });
});
