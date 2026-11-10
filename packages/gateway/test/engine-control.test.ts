import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseConfig, type EngineConfig } from '../src/config.ts';
import { Decider } from '../src/decider.ts';
import {
  EngineControl,
  EngineSwitchError,
  parseLifecycle,
  parseMode,
  parsePathUpdate,
  parseSelection,
} from '../src/engine-control.ts';
import type { Engine, EngineHealth } from '../src/engines/types.ts';
import type { Paths } from '../src/paths.ts';
import { loadPolicies } from '../src/policies.ts';
import { startGateway } from '../src/runtime.ts';
import { ShadowLog } from '../src/shadow.ts';
import { loadState } from '../src/state.ts';
import { FakeEngine, tempPaths, testConfig } from './helpers.ts';

class ModelEngine implements Engine {
  readonly id: string;
  readonly model: string;
  readonly config: EngineConfig;
  started = 0;
  stopped = 0;
  constructor(config: EngineConfig) {
    this.config = config;
    this.id = config.type;
    this.model = config.model;
  }
  async start(): Promise<void> {
    this.started += 1;
  }
  health(): EngineHealth {
    return { state: 'starting', model: this.model };
  }
  async decide(): Promise<never> {
    throw new Error('not used');
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

/** A fake `flm` on disk, so the FastFlowLM engine counts as installed. */
function fakeFlm(paths: Paths): string {
  const dir = join(paths.engines, 'fastflowlm', '1.0.12', 'dist');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'flm');
  writeFileSync(file, `#!${process.execPath}\nconsole.log('FLM v1.0.12')\n`);
  chmodSync(file, 0o755);
  return file;
}

function fakeStrands(paths: Paths): void {
  const dir = join(paths.venvs, 'strands-decider', 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'strands-decider'), `#!${process.execPath}\n`);
  chmodSync(join(dir, 'strands-decider'), 0o755);
}

interface Setup {
  readonly control: EngineControl;
  readonly decider: Decider;
  readonly created: ModelEngine[];
  readonly paths: Paths;
}

interface SetupOptions {
  readonly engine?: Record<string, unknown>;
  readonly totalMemory?: number;
  readonly installed?: boolean;
  readonly paths?: Paths;
  readonly persist?: boolean;
}

function setup(options: SetupOptions = {}): Setup {
  const paths = options.paths ?? tempPaths();
  fakeFlm(paths);
  fakeStrands(paths);
  const config = parseConfig({ engine: { type: 'strands-decider', ...options.engine } });
  const created: ModelEngine[] = [];
  const control = new EngineControl({
    config,
    paths,
    env: { PATH: '' },
    totalMemory: options.totalMemory ?? 1e12,
    persist: options.persist ?? false,
    installed: async (ids) => new Map(ids.map((id) => [id, options.installed ?? true])),
    create: (c) => {
      const next = new ModelEngine(c);
      created.push(next);
      return next;
    },
  });
  const decider = new Decider({
    engine: control.engine,
    policies: loadPolicies(config),
    log: new ShadowLog(paths.logs),
    decisionTimeoutMs: 1000,
  });
  control.bind(decider);
  return { control, decider, created, paths };
}

const E2B = 'StrandsAgents/strands-decider-E2B-gemma4-v1-2610';

describe('EngineControl switching', () => {
  it('swaps in a new engine for an allowed model and stops the old one', async () => {
    const { control, decider, created } = setup();
    const result = await control.select({ model: E2B, device: 'cpu' });
    assert.deepEqual(result, { engine: 'strands-decider', model: E2B, device: 'cpu' });
    await control.idle();
    assert.equal(created.length, 2);
    assert.equal(created[0]?.stopped, 1);
    assert.equal(decider.engine.model, E2B);
    // Lazy lifecycle (the default): the new engine loads on its first decision, not on switch.
    assert.equal(created[1]?.started, 0);
  });

  it('switches engines: strands-decider to FastFlowLM d3', async () => {
    const { control, decider, created } = setup();
    const result = await control.select({ engine: 'fastflowlm', model: 'd3:nano' });
    assert.deepEqual(result, { engine: 'fastflowlm', model: 'd3:nano', device: null });
    assert.equal(created.at(-1)?.config.type, 'fastflowlm');
    assert.equal(decider.engine.id, 'fastflowlm');
  });

  it('refuses a model of another engine, unknown models and undownloaded ones', async () => {
    const { control } = setup();
    await assert.rejects(
      control.select({ engine: 'fastflowlm', model: E2B }),
      /unknown fastflowlm model/,
    );
    await assert.rejects(control.select({ model: '--evil' }), EngineSwitchError);
    const fresh = setup({ installed: false });
    await assert.rejects(fresh.control.select({ model: E2B }), /not downloaded yet/);
  });

  it('keeps the running engine when nothing changes, and the device when none is named', async () => {
    const { control, created } = setup({ engine: { device: 'cpu' } });
    const current = control.current();
    assert.ok(current !== null);
    await control.select({ model: current.model });
    assert.equal(created.length, 1);
    assert.equal((await control.select({ model: E2B })).device, 'cpu');
  });

  it('refuses models that do not fit, by device', async () => {
    const big = 'StrandsAgents/strands-decider-E4B-gemma4-v1-2610';
    const { control } = setup({ totalMemory: 32e9 });
    await assert.rejects(control.select({ model: big, device: 'cpu' }), (error: unknown) => {
      assert.ok(error instanceof EngineSwitchError);
      assert.equal(error.status, 409);
      assert.match(error.message, /needs ~30 GB/);
      return true;
    });
    // bf16 on an accelerator needs ~15 GB, which fits in 80% of 32 GB.
    assert.equal((await control.select({ model: big, device: 'mlx' })).model, big);
  });

  it('accepts the configured model even when it is not in the catalogue', () => {
    const { control } = setup({ engine: { model: 'me/custom-decider' } });
    assert.ok(control.allowedModels('strands-decider').includes('me/custom-decider'));
  });

  it('is not switchable when attached to a running engine', async () => {
    const { control } = setup({ engine: { url: 'http://127.0.0.1:9999' } });
    assert.equal(control.switchable, false);
    await assert.rejects(control.select({ model: E2B }), /cannot switch/);
  });
});

describe('EngineControl state', () => {
  it('persists the selection, lifecycle and policy modes, and restores them', async () => {
    const paths = tempPaths();
    const first = setup({ paths, persist: true });
    await first.control.select({ engine: 'fastflowlm', model: 'd3:nano' });
    first.control.setLifecycle({ lifecycle: 'eager', idleUnloadMinutes: 30 });
    first.control.setPolicyMode('permission', 'act');
    const state = loadState(paths);
    assert.deepEqual(state.selection, { engine: 'fastflowlm', model: 'd3:nano' });
    assert.deepEqual(state.lifecycle, { lifecycle: 'eager', idleUnloadMinutes: 30 });
    assert.deepEqual(state.policyModes, { permission: 'act' });

    const second = setup({ paths, persist: true });
    assert.equal(second.control.current()?.engine, 'fastflowlm');
    assert.equal(second.control.engine.lifecycle.lifecycle, 'eager');
    assert.equal(second.decider.policies.get('permission')?.mode, 'act');
  });

  it('rejects unknown policies for mode changes', () => {
    const { control } = setup();
    assert.throws(() => control.setPolicyMode('nope', 'act'), /unknown policy/);
  });

  it('reports engines, models, paths and downloads', async () => {
    const { control } = setup();
    const status = await control.status();
    const engines = status['engines'] as { id: string; installed: boolean }[];
    assert.deepEqual(
      engines.map((e) => e.id),
      ['strands-decider', 'fastflowlm'],
    );
    assert.equal(engines.find((e) => e.id === 'fastflowlm')?.installed, true);
    const models = status['models'] as { id: string; recommended: boolean; quality: unknown }[];
    assert.ok(models.some((m) => m.id === 'd3:mini' && m.recommended));
    assert.ok(Array.isArray(status['paths']));
    assert.equal((status['active'] as { lifecycle: string }).lifecycle, 'lazy');
  });

  it('validates path updates and refuses them on a remote gateway', async () => {
    const { control, paths } = setup();
    await assert.rejects(control.setPath('tools.flm', 'relative/flm'), /absolute path/);
    await assert.rejects(control.setPath('tools.flm', '/bin/sh'), /named flm/);
    const flm = fakeFlm(paths);
    const entry = await control.setPath('tools.flm', flm);
    assert.equal(entry.source, 'settings');
    assert.equal(entry.ok, true);
    assert.equal((await control.setPath('tools.flm', null)).source, 'managed');
    const remote = new EngineControl({
      config: parseConfig({}),
      paths,
      pathsEditable: false,
      persist: false,
      create: (c) => new ModelEngine(c),
    });
    await assert.rejects(remote.setPath('tools.flm', flm), /loopback/);
  });

  it('refuses downloads of unknown or mismatched models', () => {
    const { control } = setup();
    assert.throws(() => control.download('fastflowlm', E2B), /unknown fastflowlm model/);
    assert.throws(() => control.download('strands-decider', '../etc'), /unknown/);
  });
});

describe('request parsing', () => {
  it('parses selections', () => {
    assert.deepEqual(parseSelection({ model: 'm' }), { model: 'm' });
    assert.deepEqual(parseSelection({ engine: 'fastflowlm', model: 'd3:nano' }), {
      engine: 'fastflowlm',
      model: 'd3:nano',
    });
    assert.throws(() => parseSelection({ model: 'm', device: 'gpu' }), EngineSwitchError);
    assert.throws(
      () => parseSelection({ model: 'm', engine: 'systemone-remote' }),
      EngineSwitchError,
    );
    assert.throws(() => parseSelection({}), EngineSwitchError);
  });

  it('parses lifecycle, mode and path updates', () => {
    assert.deepEqual(parseLifecycle({ lifecycle: 'lazy' }), {
      lifecycle: 'lazy',
      idleUnloadMinutes: 15,
    });
    assert.throws(() => parseLifecycle({ lifecycle: 'lazy', idleUnloadMinutes: 0 }), /1\.\.1440/);
    assert.throws(() => parseLifecycle({ lifecycle: 'sometimes' }), EngineSwitchError);
    assert.equal(parseMode({ mode: 'act' }), 'act');
    assert.throws(() => parseMode({ mode: 'yolo' }), EngineSwitchError);
    assert.deepEqual(parsePathUpdate({ key: 'tools.flm', value: null }), {
      key: 'tools.flm',
      value: null,
    });
    assert.throws(
      () => parsePathUpdate({ key: 'tools.bash', value: '/bin/bash' }),
      EngineSwitchError,
    );
  });
});

describe('control routes', () => {
  it('answer 409 when the engine cannot switch', async () => {
    const gw = await startGateway({
      config: testConfig(),
      paths: tempPaths(),
      engine: new FakeEngine(),
      env: {},
    });
    try {
      for (const path of ['/v1/engine', '/v1/engine/load', '/v1/policies/permission/mode']) {
        const res = await fetch(`${gw.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: E2B, mode: 'act' }),
        });
        assert.equal(res.status, 409, path);
      }
    } finally {
      await gw.close();
    }
  });

  it('serve engines status, switching, lifecycle and policy modes', async () => {
    const { control, paths } = setup();
    const gw = await startGateway({ config: testConfig(), paths, engineControl: control, env: {} });
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${gw.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const status = (await (await fetch(`${gw.url}/v1/engines`)).json()) as Record<
        string,
        unknown
      >;
      assert.ok(Array.isArray(status['models']));
      assert.equal(
        (await post('/v1/engine', { engine: 'fastflowlm', model: 'd3:nano' })).status,
        200,
      );
      assert.equal(
        (await post('/v1/engine/lifecycle', { lifecycle: 'lazy', idleUnloadMinutes: 5 })).status,
        200,
      );
      assert.equal((await post('/v1/policies/permission/mode', { mode: 'act' })).status, 200);
      assert.equal((await post('/v1/policies/nope/mode', { mode: 'act' })).status, 400);
      assert.equal(
        (await post('/v1/models/download', { engine: 'fastflowlm', model: 'nope' })).status,
        400,
      );
      assert.equal((await post('/v1/engine/unload', {})).status, 200);
      const health = (await (await fetch(`${gw.url}/health`)).json()) as Record<string, unknown>;
      assert.equal(health['engine'], 'fastflowlm');
    } finally {
      await gw.close();
    }
  });
});
