import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BENCHMARK_POLL_MS,
  benchmarkPollInterval,
  benchmarkSchema,
  type BenchmarkView,
  parseBenchmark,
} from '../shared/benchmark.ts';

const VIEW = {
  state: 'running',
  phase: 'measuring',
  id: 'bench-3',
  startedBy: 'paseo',
  startedAt: '2026-11-12T10:00:00.000Z',
  finishedAt: null,
  sizes: [256, 1024, 3800],
  runs: 5,
  total: 6,
  completed: 3,
  failed: 1,
  current: {
    engine: 'fastflowlm',
    model: 'd3:mini',
    device: null,
    family: 'vllm-sr/d3-mini',
    promptTokens: 3800,
  },
  etaSeconds: 170,
  targets: [
    {
      engine: 'fastflowlm',
      model: 'd3:mini',
      device: null,
      family: 'vllm-sr/d3-mini',
      state: 'done',
      loadMs: 4210,
      error: null,
      sizes: [
        {
          targetTokens: 256,
          inputTokens: 301,
          p50Ms: 721,
          p95Ms: 790,
          answer: 'done',
          error: null,
        },
        { inputTokens: 5 },
      ],
    },
    { engine: 'llama-vulkan', model: 'm', state: 'not-run' },
    { model: 'no-engine' },
    'junk',
  ],
  restore: { mode: 'auto', engine: 'fastflowlm', model: 'd3:nano', device: null, family: null },
  restoredOk: null,
  restoreError: null,
  cancelReason: null,
  error: null,
  preview: { total: 6, etaSeconds: 360, excluded: ['openai-compatible', 3] },
  future: true,
};

describe('benchmark parsing', () => {
  it('reads the contract example and drops bad targets and size rows', () => {
    const view = parseBenchmark(VIEW);
    assert.equal(view?.state, 'running');
    assert.equal(view?.phase, 'measuring');
    assert.deepEqual(view?.sizes, [256, 1024, 3800]);
    assert.equal(view?.current?.promptTokens, 3800);
    assert.deepEqual(
      view?.targets.map((t) => [t.model, t.state, t.sizes.length]),
      [
        ['d3:mini', 'done', 1],
        ['m', 'not-run', 0],
      ],
    );
    assert.equal(view?.targets[0]?.sizes[0]?.p50Ms, 721);
    assert.equal(view?.restore?.mode, 'auto');
    assert.deepEqual(view?.preview, { total: 6, etaSeconds: 360, excluded: ['openai-compatible'] });
    assert.equal('future' in (view ?? {}), false);
    assert.equal(benchmarkSchema.safeParse(view).success, true);
  });

  it('is null for a body that is not an object, and safe for an empty one', () => {
    for (const body of [null, 'x', [1], 3]) {
      assert.equal(parseBenchmark(body), null);
    }
    const view = parseBenchmark({});
    assert.equal(view?.state, null);
    assert.deepEqual(
      [view?.total, view?.completed, view?.failed, view?.targets, view?.sizes],
      [0, 0, 0, [], []],
    );
    assert.equal(benchmarkSchema.safeParse(view).success, true);
  });

  it('turns unknown codes into null', () => {
    const view = parseBenchmark({
      ...VIEW,
      state: 'paused',
      phase: 'x',
      startedBy: 'bot',
      cancelReason: 'why',
      restore: { mode: 'x' },
      targets: [{ engine: 'e', model: 'm', state: 'weird' }],
    });
    assert.deepEqual(
      [view?.state, view?.phase, view?.startedBy, view?.cancelReason, view?.restore?.mode],
      [null, null, null, null, null],
    );
    assert.equal(view?.targets[0]?.state, null);
  });

  it('caps lists and text', () => {
    const target = { engine: 'e', model: 'm', state: 'done' };
    const view = parseBenchmark({
      ...VIEW,
      error: 'x'.repeat(900),
      sizes: Array.from({ length: 40 }, () => 256),
      targets: Array.from({ length: 300 }, () => ({
        ...target,
        sizes: Array.from({ length: 40 }, () => ({ targetTokens: 256 })),
      })),
    });
    assert.equal(view?.error?.length, 500);
    assert.equal(view?.sizes.length, 12);
    assert.equal(view?.targets.length, 200);
    assert.equal(view?.targets[0]?.sizes.length, 12);
  });
});

const state = (s: string): BenchmarkView | null => parseBenchmark({ state: s });

describe('benchmark polling', () => {
  it('polls every second while running or cancelling, else stops', () => {
    assert.equal(BENCHMARK_POLL_MS, 1000);
    assert.equal(benchmarkPollInterval(state('running')), 1000);
    assert.equal(benchmarkPollInterval(state('cancelling')), 1000);
    for (const s of ['idle', 'done', 'cancelled', 'failed', 'bogus']) {
      assert.equal(benchmarkPollInterval(state(s)), false);
    }
    assert.equal(benchmarkPollInterval(null), false);
    assert.equal(benchmarkPollInterval(undefined), false);
  });
});
