import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BenchmarkError,
  parseBenchmarkRequest,
  resolveTargets,
  type BenchmarkInventory,
  type BenchmarkRequest,
  type InventoryEngine,
  type InventoryModel,
} from '../src/benchmark-job.ts';

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
