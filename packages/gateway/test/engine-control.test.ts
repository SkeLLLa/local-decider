import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseConfig, type StrandsEngineConfig } from '../src/config.ts';
import { Decider } from '../src/decider.ts';
import {
  createEngineControl,
  EngineSwitchError,
  parseSelection,
  type EngineControl,
} from '../src/engine-control.ts';
import type { Engine, EngineHealth } from '../src/engines/types.ts';
import { KNOWN_MODELS } from '../src/models.ts';
import { startGateway } from '../src/runtime.ts';
import { ShadowLog } from '../src/shadow.ts';
import { FakeEngine, tempPaths, testConfig } from './helpers.ts';

class ModelEngine implements Engine {
  readonly id = 'fake';
  readonly model: string;
  readonly config: StrandsEngineConfig;
  started = 0;
  constructor(config: StrandsEngineConfig) {
    this.config = config;
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
  async stop(): Promise<void> {}
}

interface Setup {
  readonly control: EngineControl;
  readonly decider: Decider;
  readonly first: FakeEngine;
  readonly created: ModelEngine[];
}

function setup(engine: Record<string, unknown> = {}, totalMemory = 1e12): Setup {
  const paths = tempPaths();
  const config = parseConfig({ engine: { type: 'strands-decider', ...engine } }).engine;
  const first = new FakeEngine();
  const decider = new Decider({
    engine: first,
    policies: new Map(),
    log: new ShadowLog(paths.logs),
    decisionTimeoutMs: 1000,
  });
  const created: ModelEngine[] = [];
  const control = createEngineControl({
    config,
    paths,
    decider,
    totalMemory,
    create: (c) => {
      const next = new ModelEngine(c);
      created.push(next);
      return next;
    },
  });
  return { control, decider, first, created };
}

const OTHER = KNOWN_MODELS[2]?.id ?? '';

describe('engine control', () => {
  it('swaps in a new engine for an allowed model and stops the old one', async () => {
    const { control, decider, first, created } = setup();
    const result = await control.select({ model: OTHER, device: 'cpu' });
    assert.deepEqual(result, { model: OTHER, device: 'cpu' });
    await control.idle();
    assert.equal(first.state, 'stopped');
    assert.equal(created.length, 1);
    assert.equal(decider.engine.model, OTHER);
    assert.equal(created[0]?.config.device, 'cpu');
    assert.equal(created[0]?.started, 1);
  });

  it('keeps the running engine when nothing changes', async () => {
    const { control, created } = setup();
    const current = control.current();
    assert.ok(current !== null);
    await control.select(current);
    assert.equal(created.length, 0);
  });

  it('rejects models outside the allowlist', async () => {
    const { control } = setup();
    await assert.rejects(control.select({ model: '--evil', device: 'auto' }), EngineSwitchError);
  });

  it('keeps the current device when the request names none', async () => {
    const { control, created } = setup({ device: 'cpu' });
    const current = control.current();
    assert.ok(current !== null);
    assert.deepEqual(await control.select({ model: current.model }), current);
    assert.equal(created.length, 0);
    assert.deepEqual(await control.select({ model: OTHER }), { model: OTHER, device: 'cpu' });
  });

  it('accepts the configured model even when it is not a known one', async () => {
    const { control } = setup({ model: 'me/custom-decider' });
    assert.ok(control.allowedModels().includes('me/custom-decider'));
  });

  it('is not switchable when attached to a running engine', async () => {
    const { control } = setup({ url: 'http://127.0.0.1:9999' });
    assert.equal(control.switchable, false);
    await assert.rejects(control.select({ model: OTHER, device: 'auto' }), /cannot switch/);
  });

  it('parses and validates the request body', () => {
    assert.deepEqual(parseSelection({ model: 'm' }), { model: 'm' });
    assert.deepEqual(parseSelection({ model: 'm', device: 'cpu' }), { model: 'm', device: 'cpu' });
    assert.throws(() => parseSelection({ model: 'm', device: 'gpu' }), EngineSwitchError);
    assert.throws(() => parseSelection({}), EngineSwitchError);
  });

  it('POST /v1/engine answers 409 when the engine cannot switch', async () => {
    const gw = await startGateway({
      config: testConfig(),
      paths: tempPaths(),
      engine: new FakeEngine(),
      env: {},
    });
    try {
      const res = await fetch(`${gw.url}/v1/engine`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: OTHER }),
      });
      assert.equal(res.status, 409);
      const models = (await (await fetch(`${gw.url}/models`)).json()) as Record<string, unknown>;
      assert.equal(models['switchable'], false);
    } finally {
      await gw.close();
    }
  });
});

describe('engine control memory budget', () => {
  it('refuses a model that does not fit in 80% of physical memory', async () => {
    const big = KNOWN_MODELS.find((m) => m.id.includes('26B'))?.id ?? '';
    const { control, created } = setup({}, 64e9);
    await assert.rejects(control.select({ model: big }), (error: unknown) => {
      assert.ok(error instanceof EngineSwitchError);
      assert.equal(error.status, 409);
      assert.match(error.message, /needs ~101 GB; this machine allows ~51 GB/);
      return true;
    });
    assert.equal(created.length, 0);
  });

  it('accepts a model that fits', async () => {
    const { control } = setup({}, 64e9);
    assert.equal((await control.select({ model: OTHER })).model, OTHER);
  });
});
