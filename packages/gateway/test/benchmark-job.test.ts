import type { SystemOneRequest, SystemOneResponse } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BenchmarkError,
  BenchmarkRunner,
  parseBenchmarkRequest,
  resolveTargets,
  type BenchEngine,
  type BenchSelection,
  type BenchmarkHost,
  type BenchmarkInventory,
  type BenchmarkLease,
  type BenchmarkView,
  type BenchmarkRequest,
  type InventoryEngine,
  type InventoryModel,
} from '../src/benchmark-job.ts';
import {
  MemoryBenchmarkStore,
  type BenchmarkRecord,
  type BenchmarkStore,
} from '../src/benchmark-store.ts';
import type { RuntimeStamp } from '../src/engines/descriptor.ts';
import { GATEWAY_VERSION } from '../src/version.ts';

function rejects(body: unknown, status: 400 | 409, pattern: RegExp): void {
  assert.throws(
    () => parseBenchmarkRequest(body),
    (e: unknown) => e instanceof BenchmarkError && e.status === status && pattern.test(e.message),
  );
}

describe('parseBenchmarkRequest', () => {
  it('defaults everything', () => {
    assert.deepEqual(parseBenchmarkRequest(undefined), {
      scope: 'installed',
      family: null,
      targets: null,
      only: null,
      sizes: [1024],
      runs: 5,
      client: 'api',
    });
    assert.deepEqual(parseBenchmarkRequest({}), parseBenchmarkRequest(null));
  });

  it('reads every field', () => {
    const request = parseBenchmarkRequest({
      scope: 'family',
      family: ' vllm-sr/d3-mini ',
      only: 'missing',
      sizes: [3800, 256, 256],
      runs: 2,
      client: 'cli',
      targets: [
        { engine: 'llama-vulkan', model: 'm' },
        { engine: 'strands-decider', model: 's', device: 'cuda' },
      ],
      extra: true,
    });
    assert.equal(request.scope, 'family');
    assert.equal(request.family, 'vllm-sr/d3-mini');
    assert.equal(request.only, 'missing');
    assert.deepEqual(request.sizes, [256, 1024, 3800]);
    assert.equal(request.runs, 2);
    assert.equal(request.client, 'cli');
    assert.deepEqual(request.targets, [
      { engine: 'llama-vulkan', model: 'm', device: null },
      { engine: 'strands-decider', model: 's', device: 'cuda' },
    ]);
  });

  it('maps any other client to api', () => {
    assert.equal(parseBenchmarkRequest({ client: 'paseo' }).client, 'paseo');
    assert.equal(parseBenchmarkRequest({ client: 'curl' }).client, 'api');
    assert.equal(parseBenchmarkRequest({ client: 7 }).client, 'api');
  });

  it('rejects malformed bodies and scopes', () => {
    rejects('x', 400, /JSON object/);
    rejects([], 400, /JSON object/);
    rejects({ scope: 'everything' }, 400, /scope must be/);
    rejects({ family: '' }, 400, /family/);
    rejects({ family: 3 }, 400, /family/);
    rejects({ only: 'all' }, 400, /only must be/);
  });

  it('rejects out-of-range sizes and runs', () => {
    rejects({ sizes: [63] }, 400, /sizes/);
    rejects({ sizes: [8193] }, 400, /sizes/);
    rejects({ sizes: [256.5] }, 400, /sizes/);
    rejects({ sizes: 'x' }, 400, /sizes/);
    rejects({ sizes: [64, 128, 256, 512, 2048, 4096] }, 400, /at most 6 sizes/);
    assert.deepEqual(parseBenchmarkRequest({ sizes: [] }).sizes, [1024]);
    rejects({ runs: 0 }, 400, /runs/);
    rejects({ runs: 21 }, 400, /runs/);
    rejects({ runs: 2.5 }, 400, /runs/);
    rejects({ runs: '5' }, 400, /runs/);
    assert.equal(parseBenchmarkRequest({ runs: 20 }).runs, 20);
  });

  it('rejects bad targets and more than 32', () => {
    rejects({ targets: [] }, 400, /non-empty array/);
    rejects({ targets: 'x' }, 400, /non-empty array/);
    rejects({ targets: ['x'] }, 400, /must be an object/);
    rejects({ targets: [{ engine: 'nope', model: 'm' }] }, 400, /unknown engine "nope"/);
    rejects({ targets: [{ engine: 'llama-vulkan', model: '' }] }, 400, /model/);
    rejects(
      { targets: [{ engine: 'strands-decider', model: 'm', device: 'tpu' }] },
      400,
      /unknown device/,
    );
    rejects(
      { targets: [{ engine: 'strands-decider', model: 'm', device: 'auto' }] },
      400,
      /unknown device/,
    );
    const many = Array.from({ length: 33 }, () => ({ engine: 'llama-vulkan', model: 'm' }));
    rejects({ targets: many }, 400, /at most 32 targets/);
    assert.equal(parseBenchmarkRequest({ targets: many.slice(0, 32) }).targets?.length, 32);
  });
});

// ── resolveTargets ───────────────────────────────────────────────────────────────────────────

const LADDER = ['fastflowlm', 'strands-decider:cuda', 'llama-vulkan', 'strands-decider:cpu'];

function engine(id: string, over: Partial<InventoryEngine> = {}): InventoryEngine {
  return {
    id,
    selectable: true,
    available: true,
    supported: true,
    installed: true,
    openaiLike: false,
    ...over,
  };
}

function model(
  engineId: string,
  id: string,
  family: string,
  order: number,
  over: Partial<InventoryModel> = {},
): InventoryModel {
  return {
    engine: engineId,
    id,
    family,
    downloaded: true,
    fits: true,
    recommendedOrder: order,
    ...over,
  };
}

function inventory(over: Partial<BenchmarkInventory> = {}): BenchmarkInventory {
  return {
    engines: [
      engine('fastflowlm'),
      engine('strands-decider'),
      engine('llama-vulkan'),
      engine('openai-compatible', { openaiLike: true }),
    ],
    models: [
      model('fastflowlm', 'd3:lite', 'f/lite', 0),
      model('fastflowlm', 'd3:mini', 'f/mini', 1),
      model('llama-vulkan', 'lite-q4', 'f/lite', 0),
      model('llama-vulkan', 'mini-q4', 'f/mini', 1),
      model('llama-vulkan', 'mini-q8', 'f/mini', 2),
      model('strands-decider', 'strands-2b', 's/2b', 0),
      model('openai-compatible', 'gpt', 'openai-compatible:gpt', 0),
    ],
    strandsDevices: ['cuda', 'cpu'],
    current: { engine: 'fastflowlm', model: 'd3:mini', device: null, resolvedDevice: null },
    preferredFamily: null,
    ladderIndex: (e, d) => {
      const i = LADDER.indexOf(d === null ? e : `${e}:${d}`);
      return i < 0 ? 99 : i;
    },
    rankable: () => false,
    ...over,
  };
}

const request = (over: Partial<BenchmarkRequest> = {}): BenchmarkRequest => ({
  ...parseBenchmarkRequest({}),
  ...over,
});

const keys = (
  list: readonly { engine: string; model: string; device: string | null }[],
): string[] => list.map((t) => `${t.engine}:${t.model}${t.device === null ? '' : `@${t.device}`}`);

function refused(run: () => unknown, status: 400 | 409, pattern: RegExp): void {
  assert.throws(
    run,
    (e: unknown) => e instanceof BenchmarkError && e.status === status && pattern.test(e.message),
  );
}

describe('resolveTargets: installed', () => {
  it('lists every runnable triple, strands per device, and excludes custom servers', () => {
    const { targets, excluded } = resolveTargets(request(), inventory());
    assert.deepEqual(keys(targets), [
      'fastflowlm:d3:lite',
      'llama-vulkan:lite-q4',
      'fastflowlm:d3:mini',
      'llama-vulkan:mini-q4',
      'llama-vulkan:mini-q8',
      'strands-decider:strands-2b@cuda',
      'strands-decider:strands-2b@cpu',
    ]);
    assert.deepEqual(excluded, ['openai-compatible']);
    assert.equal(targets[0]?.family, 'f/lite');
  });

  it('puts the preferred family first and orders the rest by best ladder index', () => {
    const { targets } = resolveTargets(request(), inventory({ preferredFamily: 'f/mini' }));
    assert.deepEqual([...new Set(targets.map((t) => t.family))], ['f/mini', 'f/lite', 's/2b']);
    assert.deepEqual(keys(targets).slice(0, 3), [
      'fastflowlm:d3:mini',
      'llama-vulkan:mini-q4',
      'llama-vulkan:mini-q8',
    ]);
  });

  it('skips engines that are not runnable and models that are missing or too big', () => {
    const inv = inventory({
      engines: [
        engine('fastflowlm', { installed: false }),
        engine('strands-decider', { supported: false }),
        engine('llama-vulkan'),
      ],
      models: [
        model('fastflowlm', 'd3:lite', 'f/lite', 0),
        model('strands-decider', 'strands-2b', 's/2b', 0),
        model('llama-vulkan', 'lite-q4', 'f/lite', 0, { downloaded: false }),
        model('llama-vulkan', 'mini-q4', 'f/mini', 1),
        model('llama-vulkan', 'mini-q8', 'f/mini', 2, { fits: false }),
      ],
    });
    assert.deepEqual(keys(resolveTargets(request(), inv).targets), ['llama-vulkan:mini-q4']);
  });

  it('orders quants within a runtime by catalogue order', () => {
    const inv = inventory({
      models: [
        model('llama-vulkan', 'mini-q8', 'f/mini', 2),
        model('llama-vulkan', 'mini-q4', 'f/mini', 1),
      ],
    });
    assert.deepEqual(keys(resolveTargets(request(), inv).targets), [
      'llama-vulkan:mini-q4',
      'llama-vulkan:mini-q8',
    ]);
  });

  it('says why nothing is left', () => {
    const inv = inventory({ models: [] });
    refused(() => resolveTargets(request(), inv), 409, /^nothing to benchmark: no installed model/);
  });
});

describe('resolveTargets: family', () => {
  it('keeps only the family, defaulting to the preferred one', () => {
    const inv = inventory({ preferredFamily: 'f/lite' });
    assert.deepEqual(keys(resolveTargets(request({ scope: 'family' }), inv).targets), [
      'fastflowlm:d3:lite',
      'llama-vulkan:lite-q4',
    ]);
    assert.deepEqual(
      keys(resolveTargets(request({ scope: 'family', family: 'f/mini' }), inv).targets),
      ['fastflowlm:d3:mini', 'llama-vulkan:mini-q4', 'llama-vulkan:mini-q8'],
    );
  });

  it('falls back to the running model family, and rejects unknown ones', () => {
    assert.equal(
      resolveTargets(request({ scope: 'family' }), inventory()).targets[0]?.family,
      'f/mini',
    );
    refused(
      () => resolveTargets(request({ scope: 'family', family: 'nope' }), inventory()),
      400,
      /unknown model family "nope"/,
    );
    refused(
      () => resolveTargets(request({ scope: 'family' }), inventory({ current: null })),
      400,
      /needs a family/,
    );
  });

  it('is a 409 when the family has nothing runnable', () => {
    const inv = inventory({
      engines: [
        engine('fastflowlm', { installed: false }),
        engine('llama-vulkan', { installed: false }),
      ],
    });
    refused(
      () => resolveTargets(request({ scope: 'family', family: 'f/lite' }), inv),
      409,
      /nothing to benchmark: no runnable model of family f\/lite/,
    );
  });
});

const strandsDeviceFor = (resolvedDevice: string | null): string | null =>
  resolveTargets(
    request({ scope: 'active' }),
    inventory({
      current: { engine: 'strands-decider', model: 'strands-2b', device: 'auto', resolvedDevice },
    }),
  ).targets[0]?.device ?? null;

describe('resolveTargets: active', () => {
  it('is the running selection, with any engine allowed', () => {
    const { targets, excluded } = resolveTargets(request({ scope: 'active' }), inventory());
    assert.deepEqual(targets, [
      { engine: 'fastflowlm', model: 'd3:mini', device: null, family: 'f/mini' },
    ]);
    assert.deepEqual(excluded, []);
    const custom = inventory({
      current: { engine: 'openai-compatible', model: 'gpt', device: null, resolvedDevice: null },
    });
    assert.equal(
      resolveTargets(request({ scope: 'active' }), custom).targets[0]?.engine,
      'openai-compatible',
    );
  });

  it('resolves the strands device, defaulting to cpu', () => {
    assert.equal(strandsDeviceFor('cuda'), 'cuda');
    assert.equal(strandsDeviceFor(null), 'cpu');
  });

  it('is a 409 with nothing running', () => {
    refused(
      () => resolveTargets(request({ scope: 'active' }), inventory({ current: null })),
      409,
      /nothing to benchmark: no engine is running/,
    );
  });
});

const given = (...targets: [string, string, string | null][]): BenchmarkRequest =>
  request({
    scope: 'active',
    targets: targets.map(([engineId, modelId, device]) => ({
      engine: engineId,
      model: modelId,
      device,
    })),
  });

describe('resolveTargets: explicit targets', () => {
  it('ignores the scope, keeps the given order and drops duplicates', () => {
    const { targets } = resolveTargets(
      given(
        ['llama-vulkan', 'mini-q4', null],
        ['fastflowlm', 'd3:lite', null],
        ['llama-vulkan', 'mini-q4', null],
        ['strands-decider', 'strands-2b', 'cuda'],
      ),
      inventory(),
    );
    assert.deepEqual(keys(targets), [
      'llama-vulkan:mini-q4',
      'fastflowlm:d3:lite',
      'strands-decider:strands-2b@cuda',
    ]);
  });

  it('is a 400 for an unknown model, a device on a non-strands engine, or none on strands', () => {
    refused(
      () => resolveTargets(given(['llama-vulkan', 'nope', null]), inventory()),
      400,
      /unknown model "nope"/,
    );
    refused(
      () => resolveTargets(given(['llama-vulkan', 'mini-q4', 'cuda']), inventory()),
      400,
      /device applies/,
    );
    refused(
      () => resolveTargets(given(['strands-decider', 'strands-2b', null]), inventory()),
      400,
      /needs a device/,
    );
  });

  it('is a 409 naming the target when it cannot run', () => {
    const inv = inventory({
      engines: [
        engine('fastflowlm', { installed: false }),
        engine('strands-decider'),
        engine('llama-vulkan'),
        engine('openai-compatible', { openaiLike: true }),
      ],
      models: [
        model('fastflowlm', 'd3:lite', 'f/lite', 0),
        model('llama-vulkan', 'mini-q4', 'f/mini', 0, { downloaded: false }),
        model('llama-vulkan', 'mini-q8', 'f/mini', 1, { fits: false }),
        model('strands-decider', 'strands-2b', 's/2b', 0),
        model('openai-compatible', 'gpt', 'x', 0),
      ],
      strandsDevices: ['cpu'],
    });
    const run = (e: string, m: string, d: string | null) => () =>
      resolveTargets(given([e, m, d]), inv);
    refused(run('fastflowlm', 'd3:lite', null), 409, /^fastflowlm d3:lite: not installed$/);
    refused(run('llama-vulkan', 'mini-q4', null), 409, /^llama-vulkan mini-q4: not downloaded$/);
    refused(run('llama-vulkan', 'mini-q8', null), 409, /does not fit in memory/);
    refused(run('strands-decider', 'strands-2b', 'cuda'), 409, /device cuda is not available here/);
    refused(run('openai-compatible', 'gpt', null), 409, /custom servers/);
  });
});

describe('resolveTargets: only missing', () => {
  it('drops targets that already have a rankable record', () => {
    const inv = inventory({ rankable: (e, m) => e === 'fastflowlm' || m === 'mini-q4' });
    const { targets } = resolveTargets(request({ only: 'missing' }), inv);
    assert.deepEqual(keys(targets), [
      'llama-vulkan:lite-q4',
      'llama-vulkan:mini-q8',
      'strands-decider:strands-2b@cuda',
      'strands-decider:strands-2b@cpu',
    ]);
  });

  it('is a 409 when everything is already measured', () => {
    refused(
      () => resolveTargets(request({ only: 'missing' }), inventory({ rankable: () => true })),
      409,
      /nothing to benchmark: every target already has a result/,
    );
  });
});

// ── BenchmarkRunner ──────────────────────────────────────────────────────────────────────────

const RESPONSE = {
  answers: { outcome: { type: 'choice', choice: 'done' } },
  usage: { input_tokens: 5 },
} as unknown as SystemOneResponse;

interface FakeEngineSpec {
  loadError?: Error;
  ensureReady?: (signal: AbortSignal) => Promise<void>;
  decide?: (request: SystemOneRequest, signal: AbortSignal) => Promise<SystemOneResponse>;
  backend?: string;
}

/** Rejects when `signal` aborts, else never settles until `release` is called. */
function gate(): {
  wait: (signal: AbortSignal) => Promise<SystemOneResponse>;
  entered: Promise<void>;
  release: () => void;
} {
  const open = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: () => {
      open.resolve();
    },
    wait: async (signal) => {
      entered.resolve();
      await new Promise<void>((resolve, reject) => {
        void open.promise.then(resolve);
        signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
      return RESPONSE;
    },
  };
}

function hang(signal: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new Error('timed out'));
    });
  });
}

class FakeHost implements BenchmarkHost {
  readonly calls: string[] = [];
  readonly clock = { t: 1_700_000_000_000 };
  readonly controller = new AbortController();
  readonly engines = new Map<string, FakeEngineSpec>();
  readonly host = { platform: 'linux', arch: 'x64', totalMemoryBytes: 1 } as const;
  readonly flags: { preempted: 'superseded' | 'config-changed' | null } = { preempted: null };
  endResult = { ok: true, error: null as string | null };
  swapHook: (key: string) => Promise<void> | void = () => undefined;
  active = 0;
  maxActive = 0;
  readonly lease: BenchmarkLease;

  constructor() {
    const { flags } = this;
    this.lease = {
      signal: this.controller.signal,
      done: Promise.resolve(),
      abort: (reason) => {
        this.controller.abort(reason);
      },
      get preempted() {
        return flags.preempted;
      },
      snapshot: {
        mode: 'auto',
        selection: { engine: 'fastflowlm', model: 'd3:nano', device: null },
        family: 'f/nano',
      },
    };
  }

  beginBenchmark(): BenchmarkLease {
    this.calls.push('begin');
    return this.lease;
  }

  async benchmarkSwap(_lease: BenchmarkLease, t: BenchSelection): Promise<BenchEngine> {
    const key = `${t.engine}:${t.model}`;
    this.calls.push(`swap ${key}`);
    await this.swapHook(key);
    const spec = this.engines.get(key) ?? {};
    if (spec.loadError !== undefined) {
      throw spec.loadError;
    }
    return {
      decide: async (req, signal) => {
        if (spec.decide !== undefined) {
          return spec.decide(req, signal);
        }
        this.active += 1;
        this.maxActive = Math.max(this.maxActive, this.active);
        await Promise.resolve();
        this.active -= 1;
        return RESPONSE;
      },
      ...(spec.ensureReady === undefined ? {} : { ensureReady: spec.ensureReady }),
      health: () => (spec.backend === undefined ? {} : { backend: spec.backend }),
    };
  }

  async endBenchmark(
    _lease: BenchmarkLease,
    o: { restore: boolean },
  ): Promise<{ ok: boolean; error: string | null }> {
    this.calls.push(`end restore=${String(o.restore)}`);
    return this.endResult;
  }

  async benchmarkInventory(): Promise<BenchmarkInventory> {
    return inventory();
  }

  async checkBenchmarkTarget(t: BenchSelection): Promise<void> {
    this.calls.push(`check ${t.engine}:${t.model}`);
  }

  async refreshStamps(stampKeys: readonly string[]): Promise<void> {
    this.calls.push(`stamps ${stampKeys.join(',')}`);
  }

  stampFor(): RuntimeStamp | undefined {
    return { runtime: 'llama.cpp b1', model: null };
  }

  fingerprint(): string | undefined {
    return 'fp1';
  }
}

const THREE = [
  { engine: 'fastflowlm', model: 'd3:lite', device: null },
  { engine: 'llama-vulkan', model: 'lite-q4', device: null },
  { engine: 'fastflowlm', model: 'd3:mini', device: null },
];

function job(over: Record<string, unknown> = {}): BenchmarkRequest {
  return parseBenchmarkRequest({ targets: THREE, sizes: [256], runs: 1, client: 'cli', ...over });
}

function setup(store: BenchmarkStore = new MemoryBenchmarkStore()): {
  host: FakeHost;
  store: BenchmarkStore;
  runner: BenchmarkRunner;
} {
  const host = new FakeHost();
  const runner = new BenchmarkRunner({ host, store, now: () => host.clock.t });
  return { host, store, runner };
}

describe('BenchmarkRunner: a run', () => {
  it('measures one target at a time, in order, and stores one record each', async () => {
    const { host, store, runner } = setup();
    host.engines.set('fastflowlm:d3:lite', { backend: 'NPU' });
    const started = await runner.start(job());
    assert.equal(started.state, 'running');
    assert.equal(started.id, 'bench-1');
    await runner.settled();
    assert.equal(host.maxActive, 1);
    assert.deepEqual(host.calls, [
      'check fastflowlm:d3:lite',
      'check llama-vulkan:lite-q4',
      'check fastflowlm:d3:mini',
      'begin',
      'swap fastflowlm:d3:lite',
      'stamps fastflowlm|d3:lite',
      'swap llama-vulkan:lite-q4',
      'stamps llama-vulkan|lite-q4',
      'swap fastflowlm:d3:mini',
      'stamps fastflowlm|d3:mini',
      'end restore=true',
    ]);
    const records = store.records();
    assert.equal(records.length, 3);
    const first = records[0];
    assert.equal(first?.jobId, 'bench-1');
    assert.equal(first?.engine, 'fastflowlm');
    assert.equal(first?.family, 'f/lite');
    assert.equal(first?.status, 'ok');
    assert.equal(first?.runs, 1);
    assert.equal(first?.benchVersion, 1);
    assert.equal(first?.gatewayVersion, GATEWAY_VERSION);
    assert.equal(first?.runtime, 'llama.cpp b1');
    assert.equal(first?.fingerprint, 'fp1');
    assert.equal(first?.backend, 'NPU');
    assert.equal(records[1]?.backend, 'Vulkan');
    assert.deepEqual(
      first?.sizes.map((x) => x.targetTokens),
      [256, 1024],
    );
    assert.equal(first?.sizes[0]?.inputTokens, 5);
    assert.equal(first?.sizes[0]?.answer, 'done');
    assert.equal(typeof first?.loadMs, 'number');
    const view = await runner.view();
    assert.equal(view.state, 'done');
    assert.equal(view.completed, 3);
    assert.equal(view.failed, 0);
    assert.equal(view.restoredOk, true);
    assert.equal(view.cancelReason, null);
    assert.ok(view.finishedAt !== null);
    assert.deepEqual(
      view.targets.map((t) => t.state),
      ['done', 'done', 'done'],
    );
    assert.equal(runner.progress(), null);
  });

  it('skips larger sizes after a size fails, and keeps the sizes that worked', async () => {
    const { host, store, runner } = setup();
    host.engines.set('fastflowlm:d3:lite', {
      decide: async (req) => {
        if ((req.state as string).length > 10_000) throw new Error('context overflow');
        return RESPONSE;
      },
    });
    await runner.start(job({ targets: [THREE[0]], sizes: [256, 1024, 3800, 4096] }));
    await runner.settled();
    const view = await runner.view();
    const sizes = view.targets[0]?.sizes ?? [];
    assert.deepEqual(
      sizes.map((s) => [s.targetTokens, s.p50Ms === null ? s.error : 'ok']),
      [
        [256, 'ok'],
        [1024, 'ok'],
        [3800, 'context overflow'],
        [4096, 'skipped after failure at 3800 tokens'],
      ],
    );
    assert.equal(view.targets[0]?.state, 'done');
    assert.deepEqual(
      store.records()[0]?.sizes.map((s) => s.targetTokens),
      [256, 1024],
    );
  });

  it('marks a target failed when every size fails', async () => {
    const { host, store, runner } = setup();
    host.engines.set('fastflowlm:d3:lite', {
      decide: async () => {
        throw new Error('boom');
      },
    });
    await runner.start(job({ targets: [THREE[0]] }));
    await runner.settled();
    const view = await runner.view();
    assert.equal(view.targets[0]?.state, 'failed');
    assert.equal(view.targets[0]?.error, 'boom');
    assert.equal(store.records()[0]?.status, 'failed');
    assert.equal(store.records()[0]?.error, 'boom');
    assert.equal(view.failed, 1);
    assert.equal(view.state, 'done');
  });

  it('continues after a load failure and after a load timeout', async () => {
    const { host, store } = setup();
    host.engines.set('fastflowlm:d3:lite', { loadError: new Error('engine would not start') });
    host.engines.set('llama-vulkan:lite-q4', { ensureReady: hang });
    const timed = new BenchmarkRunner({ host, store, now: () => host.clock.t, loadTimeoutMs: 20 });
    await timed.start(job());
    await timed.settled();
    const view = await timed.view();
    assert.deepEqual(
      view.targets.map((t) => [t.state, t.error]),
      [
        ['failed', 'engine would not start'],
        ['failed', 'timed out'],
        ['done', null],
      ],
    );
    assert.equal(view.failed, 2);
    assert.deepEqual(
      store.records().map((r) => r.status),
      ['failed', 'failed', 'ok'],
    );
    assert.equal(store.records()[0]?.loadMs, null);
  });

  it('fails only the target whose result cannot be saved, and goes on', async () => {
    class Full extends MemoryBenchmarkStore {
      calls = 0;
      override append(record: BenchmarkRecord): void {
        this.calls += 1;
        if (this.calls === 1) throw new Error('disk full');
        super.append(record);
      }
    }
    const { runner, store } = setup(new Full());
    await runner.start(job());
    await runner.settled();
    const view = await runner.view();
    assert.equal(view.state, 'done');
    assert.deepEqual(
      view.targets.map((t) => [t.state, t.error]),
      [
        ['failed', 'could not save the result: disk full'],
        ['done', null],
        ['done', null],
      ],
    );
    assert.equal(store.records().length, 2);
  });

  it('ends failed, and restores, when something unexpected throws', async () => {
    const { host, runner } = setup();
    host.stampFor = () => {
      throw new Error('stamp cache broke');
    };
    await runner.start(job());
    await runner.settled();
    const view = await runner.view();
    assert.equal(view.state, 'failed');
    assert.equal(view.error, 'stamp cache broke');
    assert.equal(view.restoredOk, true);
    assert.equal(host.calls.at(-1), 'end restore=true');
  });

  it('reports a restore that failed', async () => {
    const { host, runner } = setup();
    host.endResult = { ok: false, error: 'engine would not start' };
    await runner.start(job({ targets: [THREE[0]] }));
    await runner.settled();
    const view = await runner.view();
    assert.equal(view.state, 'done');
    assert.equal(view.restoredOk, false);
    assert.equal(view.restoreError, 'engine would not start');
    assert.deepEqual(view.restore, {
      mode: 'auto',
      engine: 'fastflowlm',
      model: 'd3:nano',
      device: null,
      family: 'f/nano',
    });
  });
});

describe('BenchmarkRunner: cancel and preempt', () => {
  it('cancelling mid-target discards it, keeps finished ones and restores', async () => {
    const { host, store, runner } = setup();
    const hold = gate();
    host.engines.set('llama-vulkan:lite-q4', { decide: async (_r, signal) => hold.wait(signal) });
    await runner.start(job());
    await hold.entered;
    const cancelling = runner.cancel('user');
    assert.equal(cancelling.state, 'cancelling');
    await runner.settled();
    const view = await runner.view();
    assert.equal(view.state, 'cancelled');
    assert.equal(view.cancelReason, 'user');
    assert.deepEqual(
      view.targets.map((t) => t.state),
      ['done', 'discarded', 'not-run'],
    );
    assert.deepEqual(view.targets[1]?.sizes, []);
    assert.equal(store.records().length, 1);
    assert.equal(host.calls.at(-1), 'end restore=true');
    assert.equal(view.restoredOk, true);
    assert.equal(view.completed, 1);
  });

  it('a preempted job ends cancelled without restoring', async () => {
    const { host, store, runner } = setup();
    const hold = gate();
    host.engines.set('fastflowlm:d3:lite', { decide: async (_r, signal) => hold.wait(signal) });
    await runner.start(job());
    await hold.entered;
    host.flags.preempted = 'superseded';
    host.lease.abort('superseded');
    assert.equal((await runner.view()).state, 'cancelling');
    await runner.settled();
    const view = await runner.view();
    assert.equal(view.state, 'cancelled');
    assert.equal(view.cancelReason, 'superseded');
    assert.equal(view.restoredOk, null);
    assert.deepEqual(
      view.targets.map((t) => t.state),
      ['discarded', 'not-run', 'not-run'],
    );
    assert.equal(store.records().length, 0);
    assert.equal(host.calls.at(-1), 'end restore=false');
  });

  it('a shutdown cancel does not restore', async () => {
    const { host, runner } = setup();
    const hold = gate();
    host.engines.set('fastflowlm:d3:lite', { decide: async (_r, signal) => hold.wait(signal) });
    await runner.start(job());
    await hold.entered;
    runner.cancel('shutdown');
    await runner.settled();
    assert.equal(host.calls.at(-1), 'end restore=false');
    assert.equal((await runner.view()).cancelReason, 'shutdown');
  });

  it('refuses a second start and a cancel with nothing running', async () => {
    const { host, runner } = setup();
    assert.throws(
      () => runner.cancel('user'),
      (e: unknown) =>
        e instanceof BenchmarkError &&
        e.status === 409 &&
        /no benchmark is running/.test(e.message),
    );
    const hold = gate();
    host.engines.set('fastflowlm:d3:lite', { decide: async (_r, signal) => hold.wait(signal) });
    const first = runner.start(job());
    await assert.rejects(runner.start(job()), /already running/);
    await first;
    await hold.entered;
    await assert.rejects(runner.start(job()), /already running \(bench-1\)/);
    hold.release();
    await runner.settled();
    assert.equal((await runner.view()).state, 'done');
    const second = await runner.start(job({ targets: [THREE[0]] }));
    assert.equal(second.id, 'bench-2');
    await runner.settled();
  });

  it('does not begin a lease when no target resolves', async () => {
    const { host, runner } = setup();
    await assert.rejects(
      runner.start(job({ targets: [{ engine: 'llama-vulkan', model: 'nope' }] })),
      /unknown model "nope"/,
    );
    assert.deepEqual(host.calls, []);
    assert.equal((await runner.view()).state, 'idle');
  });
});

describe('BenchmarkRunner: view, progress and ETA', () => {
  it('has an idle view with a preview of an installed run', async () => {
    const { runner } = setup();
    const view = await runner.view();
    assert.equal(view.state, 'idle');
    assert.equal(view.id, null);
    assert.equal(view.total, 0);
    assert.deepEqual(view.preview, { total: 7, etaSeconds: 420, excluded: ['openai-compatible'] });
    assert.equal(runner.progress(), null);
  });

  it('shows the live phase, current target and prompt size, with no preview', async () => {
    const { host, runner } = setup();
    const box: { seen: BenchmarkView | null } = { seen: null };
    host.engines.set('fastflowlm:d3:lite', {
      decide: async () => {
        box.seen ??= await runner.view();
        return RESPONSE;
      },
    });
    const started = await runner.start(job({ targets: [THREE[0]] }));
    assert.equal(started.startedBy, 'cli');
    assert.deepEqual(started.sizes, [256, 1024]);
    await runner.settled();
    const seen = box.seen;
    assert.equal(seen?.state, 'running');
    assert.equal(seen?.phase, 'measuring');
    assert.deepEqual(seen?.current, {
      engine: 'fastflowlm',
      model: 'd3:lite',
      device: null,
      family: 'f/lite',
      promptTokens: 256,
    });
    assert.equal(seen?.preview, null);
    assert.deepEqual(
      seen?.targets.map((t) => t.state),
      ['measuring'],
    );
    const done = await runner.view();
    assert.equal(done.phase, null);
    assert.equal(done.current, null);
    assert.equal(done.etaSeconds, null);
    assert.ok(done.preview !== null);
  });

  it('estimates from the last record before a target finishes, then from the mean wall time', async () => {
    const store = new MemoryBenchmarkStore();
    const { host, runner } = setup(store);
    store.append({
      jobId: 'bench-0',
      engine: 'fastflowlm',
      model: 'd3:lite',
      device: null,
      family: 'f/lite',
      quant: null,
      status: 'ok',
      error: null,
      measuredAt: '2026-11-01T00:00:00.000Z',
      benchVersion: 1,
      gatewayVersion: GATEWAY_VERSION,
      runtime: null,
      modelStamp: null,
      fingerprint: 'fp1',
      backend: 'NPU',
      resolvedDevice: null,
      runs: 5,
      loadMs: 4000,
      sizes: [
        { targetTokens: 256, inputTokens: 1, p50Ms: 1000, p95Ms: 1, answer: 'done', error: null },
        { targetTokens: 1024, inputTokens: 1, p50Ms: 2000, p95Ms: 1, answer: 'done', error: null },
      ],
    });
    const etas: (number | null)[] = [];
    const progress: ({ completed: number; total: number } | null)[] = [];
    host.swapHook = async () => {
      etas.push((await runner.view()).etaSeconds);
      progress.push(runner.progress());
      host.clock.t += 10_000;
    };
    await runner.start(job());
    await runner.settled();
    // Target one: 4 s load + (1 s + 2 s) × (1 run + 1 warm-up) = 10 s, plus a minute for each other.
    assert.equal(etas[0], 130);
    // Targets two and three remain, each taking the mean of 10 s.
    assert.equal(etas[1], 20);
    assert.equal(etas[2], 10);
    assert.deepEqual(progress, [
      { completed: 0, total: 3 },
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
    ]);
  });
});
