import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  downloadModel,
  listEngines,
  selectEngine,
  setPath,
  validateEngine,
} from '../server/engines.ts';
import {
  deviceOptions,
  engineOptions,
  enginesPollInterval,
  activeEngineTag,
  engineTag,
  ENGINES_POLL_MS,
  initialEngine,
  modelRowState,
  modelRowView,
  parseEngineCatalog,
  type Download,
  type EngineCatalog,
  type EngineModel,
  type ModelRowView,
  type ModelRowContext,
} from '../shared/engines.ts';
import { deps, fakeGateway, settings } from './fakes.ts';

const STRANDS = 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610';

/** The contract's example response, plus fields the plugin does not know. */
const BODY = {
  active: { engine: 'fastflowlm', model: 'd3:nano', device: null, state: 'ready', detail: null },
  totalMemoryGb: 66,
  future: { anything: true },
  engines: [
    {
      id: 'strands-decider',
      label: 'Strands Decider (PyTorch)',
      installed: true,
      available: true,
      detail: 'venv ~/.local/share/local-decider/venvs/strands-decider',
      devices: ['auto', 'cpu', 'mlx', 'mps', 'cuda'],
      validation: null,
    },
    {
      id: 'fastflowlm',
      label: 'FastFlowLM (AMD NPU)',
      installed: true,
      available: true,
      detail: 'FLM v1.0.12',
      devices: [],
      validation: {
        ok: true,
        checkedAt: '2026-11-10T13:50:00Z',
        summary: 'NPU aie2p, 8 columns, FW 1.1.2.64',
        lines: ['line 1', 2, 'line 3'],
      },
      extra: 'ignored',
    },
  ],
  models: [
    {
      id: 'd3:nano',
      engine: 'fastflowlm',
      label: 'd3 nano · Qwen3.5-2B',
      downloadGb: 2.0,
      memoryGb: 4,
      fits: true,
      installed: true,
      latencyHint: '~0.3 s',
      recommended: true,
    },
    {
      id: STRANDS,
      engine: 'strands-decider',
      label: 'Strands 2B · Qwen3.5',
      downloadGb: 4.8,
      memoryGb: 8,
      fits: true,
      installed: true,
      latencyHint: '~2.4 s on CPU',
      recommended: false,
    },
    { id: 'no-engine' },
    'junk',
  ],
  downloads: [
    {
      id: 'dl-1',
      engine: 'fastflowlm',
      model: 'd3:mini',
      state: 'running',
      startedAt: '2026-11-10T13:51:00Z',
      finishedAt: null,
      error: null,
      progress: 1.7,
    },
    { id: 'dl-2', engine: 'fastflowlm', model: 'x', state: 'paused' },
  ],
};

function model(overrides: Partial<EngineModel> = {}): EngineModel {
  return {
    id: 'd3:mini',
    engine: 'fastflowlm',
    label: 'd3 mini',
    downloadGb: 2,
    memoryGb: 4,
    fits: true,
    installed: true,
    latencyHint: '~0.5 s',
    recommended: false,
    ...overrides,
  };
}

function download(overrides: Partial<Download> = {}): Download {
  return {
    id: 'dl',
    engine: 'fastflowlm',
    model: 'd3:mini',
    state: 'running',
    startedAt: null,
    finishedAt: null,
    error: null,
    progress: null,
    ...overrides,
  };
}

function ctx(overrides: Partial<ModelRowContext> = {}): ModelRowContext {
  return {
    active: {
      engine: 'fastflowlm',
      model: 'd3:nano',
      device: null,
      state: 'ready',
      detail: null,
      lifecycle: null,
      idleUnloadMinutes: null,
      lastUsedAt: null,
      selectionMode: null,
      fallback: null,
    },
    downloads: [],
    engineAvailable: true,
    device: 'auto',
    ...overrides,
  };
}

describe('GET /v1/engines parsing', () => {
  it('reads the contract example and drops unknown fields and bad entries', () => {
    const catalog = parseEngineCatalog(BODY);
    assert.equal(catalog.reachable, true);
    assert.equal(catalog.totalMemoryGb, 66);
    assert.equal(catalog.active?.model, 'd3:nano');
    assert.equal(catalog.active?.lifecycle, null);
    assert.deepEqual(
      catalog.engines.map((e) => e.id),
      ['strands-decider', 'fastflowlm'],
    );
    assert.equal('extra' in (catalog.engines[1] ?? {}), false);
    assert.deepEqual(catalog.engines[1]?.validation?.lines, ['line 1', 'line 3']);
    assert.deepEqual(
      catalog.models.map((m) => m.id),
      ['d3:nano', STRANDS],
    );
    assert.equal(catalog.downloads.length, 1);
    assert.equal(catalog.downloads[0]?.progress, 1);
    assert.deepEqual(catalog.paths, []);
    assert.equal(catalog.pathsEditable, false);
  });

  it('fills missing fields with safe defaults', () => {
    const catalog = parseEngineCatalog({
      active: { engine: 'fastflowlm', lifecycle: 'lazy', idleUnloadMinutes: 15 },
      engines: [{ id: 'x' }, { id: 'y', installed: true }],
      models: [{ id: 'm', engine: 'x' }],
    });
    assert.deepEqual(catalog.engines[0], {
      id: 'x',
      label: 'x',
      installed: false,
      available: false,
      detail: null,
      devices: [],
      validation: null,
      tag: 'x',
      description: '',
      calibrated: true,
      capabilities: { validate: false },
      supported: true,
      unsupportedReason: null,
      connectable: false,
      connection: null,
    });
    assert.equal(catalog.engines[1]?.available, true);
    assert.deepEqual(catalog.models[0], {
      id: 'm',
      engine: 'x',
      label: 'm',
      downloadGb: null,
      memoryGb: null,
      fits: true,
      installed: false,
      latencyHint: null,
      recommended: false,
    });
    assert.equal(catalog.active?.lifecycle, 'lazy');
    assert.equal(catalog.active?.idleUnloadMinutes, 15);
    assert.equal(catalog.totalMemoryGb, null);
  });

  it('is an unreachable, empty catalog for anything that is not an object', () => {
    for (const body of [null, 'x', [1, 2], 42]) {
      const catalog = parseEngineCatalog(body);
      assert.equal(catalog.reachable, false);
      assert.deepEqual([catalog.engines, catalog.models, catalog.downloads], [[], [], []]);
      assert.equal(catalog.active, null);
    }
  });
});

describe('model row state', () => {
  it('marks the active model in use, or loading', () => {
    assert.deepEqual(modelRowState(model({ id: 'd3:nano' }), ctx()), {
      kind: 'in-use',
      loading: false,
    });
    const loading = ctx({ active: { ...ctx().active!, state: 'starting' } });
    assert.deepEqual(modelRowState(model({ id: 'd3:nano' }), loading), {
      kind: 'in-use',
      loading: true,
    });
  });

  it('offers the active model again on another device', () => {
    const active = { ...ctx().active!, engine: 'strands-decider', model: STRANDS, device: 'cpu' };
    const strands = model({ id: STRANDS, engine: 'strands-decider' });
    assert.equal(modelRowState(strands, ctx({ active, device: 'cuda' })).kind, 'switch-device');
    assert.equal(modelRowState(strands, ctx({ active, device: 'cpu' })).kind, 'in-use');
    assert.equal(modelRowState(strands, ctx({ active, device: 'auto' })).kind, 'in-use');
  });

  it('walks download → downloading → failed → use', () => {
    const missing = model({ installed: false });
    assert.deepEqual(modelRowState(missing, ctx()), { kind: 'download', failed: null });
    assert.deepEqual(modelRowState(missing, ctx({ downloads: [download({ progress: 0.4 })] })), {
      kind: 'downloading',
      progress: 0.4,
    });
    assert.deepEqual(
      modelRowState(
        missing,
        ctx({ downloads: [download({ state: 'failed', error: 'disk full' })] }),
      ),
      { kind: 'download', failed: 'disk full' },
    );
    // A running retry wins over the earlier failure.
    assert.equal(
      modelRowState(
        missing,
        ctx({ downloads: [download({ state: 'failed' }), download({ id: 'dl-2' })] }),
      ).kind,
      'downloading',
    );
    assert.deepEqual(modelRowState(model(), ctx({ downloads: [download({ state: 'done' })] })), {
      kind: 'use',
    });
  });

  it('refuses models that do not fit, and every model of an unavailable engine', () => {
    assert.deepEqual(modelRowState(model({ fits: false, installed: false }), ctx()), {
      kind: 'no-fit',
    });
    assert.deepEqual(modelRowState(model(), ctx({ engineAvailable: false })), {
      kind: 'unavailable',
    });
    // Another engine's download does not count.
    assert.equal(
      modelRowState(model(), ctx({ downloads: [download({ engine: 'strands-decider' })] })).kind,
      'use',
    );
  });

  it('labels each state', () => {
    const options = { device: 'auto', totalMemoryGb: 66 };
    const view = (m: EngineModel, c: ModelRowContext = ctx()): ModelRowView =>
      modelRowView(m, modelRowState(m, c), options);
    assert.deepEqual(view(model({ installed: false, recommended: true })), {
      label: 'd3 mini · Recommended',
      hint: '2 GB download · 4 GB memory · ~0.5 s',
      actionLabel: 'Download (2 GB)',
      action: 'download',
    });
    assert.equal(
      view(model({ downloadGb: 4.8, installed: false })).actionLabel,
      'Download (4.8 GB)',
    );
    assert.equal(view(model()).actionLabel, 'Use');
    assert.equal(view(model({ id: 'd3:nano' })).actionLabel, 'In use');
    assert.equal(view(model({ id: 'd3:nano' })).action, null);
    const tooBig = view(model({ fits: false, memoryGb: 120 }));
    assert.equal(tooBig.actionLabel, 'Needs ~120 GB');
    assert.equal(tooBig.action, null);
    assert.match(tooBig.hint, /this machine has 66 GB/);
    const failed = view(
      model({ installed: false }),
      ctx({ downloads: [download({ state: 'failed', error: 'disk full' })] }),
    );
    assert.equal(failed.actionLabel, 'Retry download (2 GB)');
    assert.match(failed.hint, /Download failed: disk full/);
    assert.equal(view(model({ installed: false }), ctx({ downloads: [download()] })).action, null);
  });
});

describe('engines polling', () => {
  const base: EngineCatalog = parseEngineCatalog(BODY);

  it('polls while a download runs and stops when none do', () => {
    assert.equal(enginesPollInterval(base), ENGINES_POLL_MS);
    const done = {
      ...base,
      downloads: base.downloads.map((d) => ({ ...d, state: 'done' as const })),
    };
    assert.equal(enginesPollInterval(done), false);
    assert.equal(enginesPollInterval(undefined), false);
  });

  it('polls while the model loads', () => {
    const loading = { ...base, downloads: [], active: { ...base.active!, state: 'starting' } };
    assert.equal(enginesPollInterval(loading), ENGINES_POLL_MS);
  });
});

describe('engine selection helpers', () => {
  it('starts on the active engine, else the first available one', () => {
    const catalog = parseEngineCatalog(BODY);
    assert.equal(initialEngine(catalog), 'fastflowlm');
    assert.equal(initialEngine({ ...catalog, active: null }), 'strands-decider');
    assert.equal(initialEngine({ ...catalog, engines: [] }), null);
  });

  it('labels unavailable engines and short engine tags', () => {
    const catalog = parseEngineCatalog({
      engines: [
        { id: 'a', label: 'A', installed: true, available: true },
        { id: 'b', label: 'B', installed: true, available: false },
        { id: 'c', label: 'C' },
      ],
    });
    assert.deepEqual(
      engineOptions(catalog.engines).map((o) => o.label),
      ['A', 'B (unavailable)', 'C (not installed)'],
    );
    assert.deepEqual(deviceOptions(['auto', 'cpu', 'cuda', 'tpu']), [
      { label: 'Gateway default', value: 'auto' },
      { label: 'CPU', value: 'cpu' },
      { label: 'CUDA', value: 'cuda' },
      { label: 'tpu', value: 'tpu' },
    ]);
    assert.equal(deviceOptions(['cpu'])[0]?.value, 'auto');
    assert.equal(engineTag('fastflowlm', 'NPU'), 'NPU');
    assert.equal(engineTag('other'), 'other');
    assert.equal(engineTag('other', ''), 'other');
    assert.equal(engineTag(null, 'NPU'), null);
  });

  it('reads the new engine fields and defaults them for an old gateway', () => {
    const { engines } = parseEngineCatalog({
      engines: [
        {
          id: 'a',
          label: 'A',
          tag: 'NPU',
          description: 'Fast',
          calibrated: false,
          capabilities: { validate: true },
          supported: false,
          unsupportedReason: 'Windows only',
        },
        { id: 'b', validation: { ok: true, lines: [] } },
        { id: 'c' },
      ],
    });
    assert.equal(engines[0]?.tag, 'NPU');
    assert.equal(engines[0]?.description, 'Fast');
    assert.equal(engines[0]?.calibrated, false);
    assert.equal(engines[0]?.capabilities.validate, true);
    assert.equal(engines[0]?.supported, false);
    assert.equal(engines[0]?.unsupportedReason, 'Windows only');
    assert.equal(engines[1]?.capabilities.validate, true);
    assert.equal(engines[2]?.capabilities.validate, false);
    assert.deepEqual(
      [engines[2]?.tag, engines[2]?.description, engines[2]?.supported, engines[2]?.calibrated],
      ['c', '', true, true],
    );
  });

  it('hides unsupported engines unless active and falls back to the id for the tag', () => {
    const catalog = parseEngineCatalog({
      active: { engine: 'b', model: 'm' },
      engines: [
        { id: 'a', label: 'A', installed: true, supported: false },
        { id: 'b', label: 'B', installed: true, supported: false, tag: 'Bee' },
        { id: 'c', label: 'C', installed: true },
      ],
    });
    assert.deepEqual(
      engineOptions(catalog.engines).map((o) => o.value),
      ['c'],
    );
    assert.deepEqual(
      engineOptions(catalog.engines, 'b').map((o) => o.value),
      ['b', 'c'],
    );
    assert.equal(activeEngineTag(catalog), 'Bee');
    assert.equal(activeEngineTag({ ...catalog, active: { ...catalog.active!, engine: 'c' } }), 'c');
  });

  it('does not offer to download discovered models with unknown sizes', () => {
    const found = model({ downloadGb: null, memoryGb: null, installed: false });
    assert.equal(modelRowState(found, ctx()).kind, 'use');
  });

  it('handles the lmstudio engine: order, tag, uncalibrated, discovered labels', async () => {
    const catalog = parseEngineCatalog({
      active: { engine: 'fastflowlm', model: 'x' },
      engines: [
        { id: 'fastflowlm', label: 'FastFlowLM', installed: true, available: true, tag: 'NPU' },
        {
          id: 'lmstudio',
          label: 'LM Studio',
          installed: true,
          available: true,
          tag: 'LM Studio',
          calibrated: false,
          supported: true,
        },
        { id: 'legacy', label: 'Legacy', installed: true },
      ],
      models: [
        { id: 'qwen3', engine: 'lmstudio', label: 'qwen3 (MLX)' },
        { id: 'llama', engine: 'lmstudio', label: 'llama (GGUF · Q4_K_M · 4.5 GB)' },
      ],
    });
    assert.deepEqual(
      engineOptions(catalog.engines).map((o) => o.value),
      ['fastflowlm', 'lmstudio', 'legacy'],
    );
    const lm = catalog.engines[1]!;
    assert.equal(lm.tag, 'LM Studio');
    assert.equal(lm.calibrated, false);
    assert.equal(catalog.engines[2]!.calibrated, true);
    assert.deepEqual(
      catalog.models.map(
        (m) =>
          modelRowView(m, modelRowState(m, ctx()), {
            device: 'auto',
            totalMemoryGb: null,
          }).label,
      ),
      ['qwen3 (MLX)', 'llama (GGUF · Q4_K_M · 4.5 GB)'],
    );
    assert.equal(modelRowState(catalog.models[0]!, ctx()).kind, 'use');
    let sent: unknown = null;
    const gw = {
      ...fakeGateway(() => null),
      selectEngine: async (body: unknown) => {
        sent = body;
        return { ok: true as const, body: {} };
      },
    };
    await selectEngine(deps(settings(), gw), {
      engine: 'lmstudio',
      model: 'qwen3',
      device: 'auto',
    });
    assert.deepEqual(sent, { engine: 'lmstudio', model: 'qwen3', device: 'auto' });
  });
});

describe('engine RPC handlers', () => {
  it('lists engines through the gateway', async () => {
    const gw = { ...fakeGateway(() => null), engines: async () => BODY };
    assert.equal((await listEngines(deps(settings(), gw))).models.length, 2);
    assert.equal((await listEngines(deps(settings(), null))).reachable, false);
  });

  it('forwards switches, downloads, validation and paths', async () => {
    const gw = fakeGateway(() => null);
    const d = deps(settings(), gw);
    assert.deepEqual(
      await selectEngine(d, { engine: 'fastflowlm', model: 'd3:nano', device: 'auto' }),
      { ok: true, error: null },
    );
    await downloadModel(d, { engine: 'fastflowlm', model: 'd3:mini' });
    await validateEngine(d, 'fastflowlm');
    await setPath(d, { key: 'tools.flm', value: ' /opt/flm/bin/flm ' });
    assert.deepEqual(gw.posts, [
      { name: 'selectEngine', input: { engine: 'fastflowlm', model: 'd3:nano', device: 'auto' } },
      { name: 'downloadModel', input: { engine: 'fastflowlm', model: 'd3:mini' } },
      { name: 'validateEngine', input: 'fastflowlm' },
      { name: 'setPath', input: { key: 'tools.flm', value: '/opt/flm/bin/flm' } },
    ]);
    assert.ok(d.logs.every((line) => !line.includes('/opt/flm')));
  });

  it('returns what the gateway sent back, and its errors', async () => {
    const gw = {
      ...fakeGateway(() => null),
      downloadModel: async () => ({
        ok: true as const,
        body: {
          download: { id: 'dl-9', engine: 'fastflowlm', model: 'd3:mini', state: 'running' },
        },
      }),
      validateEngine: async () => ({
        ok: true as const,
        body: { validation: { ok: false, summary: 'no NPU', lines: ['x'] } },
      }),
      selectEngine: async () => ({ ok: false as const, error: 'model does not fit' }),
    };
    const d = deps(settings(), gw);
    assert.equal(
      (await downloadModel(d, { engine: 'fastflowlm', model: 'd3:mini' })).download?.id,
      'dl-9',
    );
    assert.equal((await validateEngine(d, 'fastflowlm')).validation?.summary, 'no NPU');
    assert.deepEqual(await selectEngine(d, { engine: 'e', model: 'm', device: 'auto' }), {
      ok: false,
      error: 'model does not fit',
    });
    assert.equal(
      (await selectEngine(deps(settings(), null), { engine: 'e', model: 'm', device: 'auto' })).ok,
      false,
    );
  });
});
