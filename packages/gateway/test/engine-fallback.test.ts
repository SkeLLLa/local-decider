import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MemoryConfigStore } from '../src/config-file.ts';
import { parseConfig, type EngineConfig } from '../src/config.ts';
import { Decider } from '../src/decider.ts';
import { EngineControl, parseSelectionMode } from '../src/engine-control.ts';
import type { HostInfo } from '../src/engines/descriptor.ts';
import type { HostCapabilities } from '../src/engines/host-capabilities.ts';
import {
  EngineError,
  type Engine,
  type EngineHealth,
  type EngineState,
} from '../src/engines/types.ts';
import type { Paths } from '../src/paths.ts';
import { loadPolicies, policyDirs } from '../src/policies.ts';
import { ShadowLog } from '../src/shadow.ts';
import { FakeEngine, NO_CAPABILITIES, tempPaths } from './helpers.ts';

const LINUX: HostInfo = { platform: 'linux', arch: 'x64', totalMemoryBytes: 64e9 };
const NPU: HostCapabilities = {
  ...NO_CAPABILITIES,
  npu: { status: 'available', evidence: 'accel0: amdxdna' },
};
const INPUT = { project: '/p', tool: 'Bash', request: { command: 'ls' }, history: 'user: ls' };

type Behaviour = 'ok' | 'fail' | 'slow';

interface World {
  behaviour: Record<string, Behaviour>;
  probs: Record<string, number>;
  events: string[];
  loaded: Set<ScriptedEngine>;
  maxLoaded: number;
  now: number;
  engines: ScriptedEngine[];
  /** Engines whose construction throws. */
  unbuildable: Set<string>;
  /** The engine `id` goes bad: new starts fail and a running one dies. */
  fail(id: string): void;
}

class ScriptedEngine implements Engine {
  readonly id: string;
  readonly model: string;
  readonly world: World;
  state: EngineState = 'stopped';

  constructor(config: EngineConfig, world: World) {
    this.id = config.type;
    this.model = config.model;
    this.world = world;
    world.engines.push(this);
  }

  async start(): Promise<void> {
    this.world.events.push(`start:${this.id}`);
    this.world.loaded.add(this);
    this.world.maxLoaded = Math.max(this.world.maxLoaded, this.world.loaded.size);
    const behaviour = this.world.behaviour[this.id] ?? 'ok';
    if (behaviour === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, 5000).unref());
    }
    this.state = behaviour === 'fail' ? 'failed' : 'ready';
  }

  health(): EngineHealth {
    return { state: this.state, model: this.model, detail: this.state === 'failed' ? 'boom' : '' };
  }

  async decide(
    request: Parameters<FakeEngine['decide']>[0],
    signal: AbortSignal,
  ): ReturnType<FakeEngine['decide']> {
    if (this.state !== 'ready') {
      throw new EngineError('engine not ready');
    }
    return new FakeEngine(this.world.probs).decide(request, signal);
  }

  async stop(): Promise<void> {
    this.world.events.push(`stop:${this.id}`);
    this.world.loaded.delete(this);
    this.state = 'stopped';
  }
}

function fakeBinaries(paths: Paths): void {
  const flm = join(paths.engines, 'fastflowlm', '1.0.12', 'dist');
  const strands = join(paths.venvs, 'strands-decider', 'bin');
  for (const [dir, name] of [
    [flm, 'flm'],
    [strands, 'strands-decider'],
  ] as const) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `#!${process.execPath}\n`);
    chmodSync(join(dir, name), 0o755);
  }
}

interface Setup {
  readonly control: EngineControl;
  readonly decider: Decider;
  readonly world: World;
  readonly store: MemoryConfigStore;
  readonly decide: (history?: string) => ReturnType<Decider['decide']>;
}

function setup(raw: Record<string, unknown>, timeoutMs = 1000): Setup {
  const world: World = {
    behaviour: {},
    probs: { allow: 0.97, ask: 0.02, deny: 0.01 },
    events: [],
    loaded: new Set(),
    maxLoaded: 0,
    now: 0,
    engines: [],
    unbuildable: new Set(),
    fail(id) {
      this.behaviour[id] = 'fail';
      for (const engine of this.engines) {
        if (engine.id === id && engine.state === 'ready') {
          engine.state = 'failed';
        }
      }
    },
  };
  const paths = tempPaths();
  fakeBinaries(paths);
  const store = new MemoryConfigStore(parseConfig({ lifecycle: { mode: 'eager' }, ...raw }));
  const control = new EngineControl({
    store,
    paths,
    env: { PATH: '' },
    host: LINUX,
    totalMemory: 64e9,
    installed: async (ids) => new Map(ids.map((id) => [id, true])),
    capabilities: () => Promise.resolve(NPU),
    fallback: { now: () => world.now, baseMs: 1000, maxMs: 8000, stableMs: 60_000 },
    create: (config) => {
      if (world.unbuildable.has(config.type)) {
        throw new Error(`cannot build ${config.type}`);
      }
      return new ScriptedEngine(config, world);
    },
  });
  const decider = new Decider({
    engine: control.engine,
    policies: new Map(
      [...loadPolicies(store.current, policyDirs(store.current, paths))].map(([id, loaded]) => [
        id,
        { ...loaded, policy: { ...loaded.policy, cache: { ttlSeconds: 60 } } },
      ]),
    ),
    log: new ShadowLog(paths.logs),
    decisionTimeoutMs: timeoutMs,
  });
  control.bind(decider);
  const decide = (history = INPUT.history): ReturnType<Decider['decide']> =>
    decider.decide(
      'permission',
      { harness: 'cli', input: { ...INPUT, history } },
      new AbortController().signal,
    );
  return { control, decider, world, store, decide };
}

const fallbackOf = async (c: EngineControl): Promise<{ reason: string } | undefined> =>
  ((await c.status())['active'] as { fallback?: { reason: string } }).fallback;

const active = (c: EngineControl): string | undefined => c.current()?.engine;

async function settle(control: EngineControl): Promise<void> {
  await control.idle();
  await new Promise((resolve) => setImmediate(resolve));
  await control.idle();
}

describe('automatic runtime fallback', () => {
  it('picks the top-ranked engine at start without persisting a selection', async () => {
    const { control, store } = setup({ selection: { mode: 'auto' } });
    await settle(control);
    assert.equal(active(control), 'fastflowlm');
    assert.deepEqual(store.current.selection, { mode: 'auto' });
  });

  it('falls back on an engine failure, stopping the failed one before the next starts', async () => {
    const { control, world, decide } = setup({ selection: { mode: 'auto' } });
    await settle(control);
    world.fail('fastflowlm');
    await decide();
    await settle(control);
    assert.equal(active(control), 'strands-decider');
    const stop = world.events.lastIndexOf('stop:fastflowlm');
    assert.ok(stop >= 0 && stop < world.events.lastIndexOf('start:strands-decider'));
    assert.equal(world.maxLoaded, 1, 'two models were loaded at once');
    const status = await control.status();
    const info = status['active'] as {
      fallback?: { reason: string; engine?: string };
      selectionMode: string;
    };
    assert.equal(info.selectionMode, 'auto');
    assert.match(info.fallback?.reason ?? '', /fastflowlm failed/);
    assert.equal(info.fallback?.engine, 'fastflowlm');
  });

  it('never falls back from a manual selection', async () => {
    const { control, world, decide } = setup({
      selection: { engine: 'fastflowlm', model: 'd3:mini' },
    });
    world.fail('fastflowlm');
    await decide();
    await settle(control);
    assert.equal(active(control), 'fastflowlm');
    assert.equal(world.events.includes('start:strands-decider'), false);
  });

  it('backs off exponentially and recovers without oscillating', async () => {
    const { control, world, decide } = setup({ selection: { mode: 'auto' } });
    await settle(control);
    world.fail('fastflowlm');
    await decide();
    await settle(control);
    assert.equal(active(control), 'strands-decider');
    // Inside the 1 s cooldown nothing moves, even though FLM is healthy again.
    world.behaviour['fastflowlm'] = 'ok';
    world.now = 500;
    await control.reconcileAuto();
    assert.equal(active(control), 'strands-decider');
    world.now = 1500;
    await control.reconcileAuto();
    await settle(control);
    assert.equal(active(control), 'fastflowlm');
    // It fails again: the cooldown doubles to 2 s.
    world.fail('fastflowlm');
    await decide();
    await settle(control);
    assert.equal(active(control), 'strands-decider');
    world.behaviour['fastflowlm'] = 'ok';
    world.now = 1500 + 1500;
    await control.reconcileAuto();
    assert.equal(active(control), 'strands-decider', 'still cooling down');
    world.now = 1500 + 2100;
    await control.reconcileAuto();
    await settle(control);
    assert.equal(active(control), 'fastflowlm');
  });

  it('clears the decision cache when the engine changes', async () => {
    const { control, decider, world, decide } = setup({ selection: { mode: 'auto' } });
    await settle(control);
    await decide();
    assert.equal((await decide()).cached, true, 'precondition: identical decisions are cached');
    const before = decider.engine;
    world.fail('fastflowlm');
    await decide('a different request, so it reaches the engine');
    await settle(control);
    assert.notEqual(decider.engine, before);
    assert.equal((await decide()).cached, false);
  });

  it('does not treat low confidence as a failure', async () => {
    const { control, world, decide } = setup({ selection: { mode: 'auto' } });
    await settle(control);
    world.probs = { allow: 0.34, ask: 0.33, deny: 0.33 };
    await decide();
    await settle(control);
    assert.equal(active(control), 'fastflowlm');
    assert.equal(world.events.includes('start:strands-decider'), false);
  });

  it('keeps automatic mode on disk and reconciling after a retool', async () => {
    const { control, store, world, decide } = setup({ selection: { mode: 'auto' } });
    await settle(control);
    store.update([{ path: ['tools', 'flm'], value: '/opt/flm' }]);
    await control.applyConfig();
    await settle(control);
    assert.deepEqual(store.current.selection, { mode: 'auto' });
    world.fail('fastflowlm');
    await decide('a request that reaches the engine');
    await settle(control);
    assert.equal(active(control), 'strands-decider');
    assert.deepEqual(store.current.selection, { mode: 'auto' });
  });

  it('starts only the ranked engine, once, when booting in automatic mode', async () => {
    const { control, world } = setup({ selection: { mode: 'auto' } });
    control.start();
    await settle(control);
    assert.deepEqual(
      world.events.filter((e) => e.startsWith('start:')),
      ['start:fastflowlm'],
    );
    assert.equal(active(control), 'fastflowlm');
  });

  it('forgives a lazy engine after a successful decision', async () => {
    const { control, world, decide } = setup({
      selection: { mode: 'auto' },
      lifecycle: { mode: 'lazy' },
    });
    await settle(control);
    world.behaviour['fastflowlm'] = 'fail';
    await decide();
    await settle(control);
    assert.equal(active(control), 'strands-decider');
    world.behaviour['fastflowlm'] = 'ok';
    world.now = 1500;
    await control.reconcileAuto();
    await settle(control);
    assert.equal(active(control), 'fastflowlm');
    await decide('first answer from the recovered engine');
    world.now = 70_000;
    world.fail('fastflowlm');
    await decide('a request that reaches the engine');
    await settle(control);
    assert.equal(active(control), 'strands-decider');
    world.behaviour['fastflowlm'] = 'ok';
    // A forgiven failure waits the base 1 s, not the doubled 2 s.
    world.now = 71_500;
    await control.reconcileAuto();
    await settle(control);
    assert.equal(active(control), 'fastflowlm');
  });

  it('backs off a candidate whose switch throws instead of retrying it forever', async () => {
    const { control, world } = setup({ selection: { mode: 'auto' } });
    world.unbuildable.add('fastflowlm');
    await settle(control);
    assert.match((await fallbackOf(control))?.reason ?? '', /switching to fastflowlm failed/);
    await control.reconcileAuto();
    await settle(control);
    assert.equal(active(control), 'strands-decider');
  });

  it('drops the fallback report once recovered and when leaving automatic mode', async () => {
    const { control, world, decide } = setup({ selection: { mode: 'auto' } });
    await settle(control);
    world.fail('fastflowlm');
    await decide();
    await settle(control);
    assert.ok(await fallbackOf(control));
    world.behaviour['fastflowlm'] = 'ok';
    world.now = 1500;
    await control.reconcileAuto();
    await settle(control);
    assert.equal(await fallbackOf(control), undefined);
    world.fail('fastflowlm');
    await decide('a request that reaches the engine');
    await settle(control);
    assert.ok(await fallbackOf(control));
    const current = control.current();
    await control.select({ engine: 'strands-decider', model: current?.model ?? '' });
    assert.equal(await fallbackOf(control), undefined);
  });

  it('fails open within the decision timeout while a replacement loads', async () => {
    const { control, world, decide } = setup({ selection: { mode: 'auto' } }, 300);
    await settle(control);
    world.behaviour['strands-decider'] = 'slow';
    world.fail('fastflowlm');
    await decide();
    const started = performance.now();
    const response = await decide();
    assert.ok(performance.now() - started < 2000, 'decision was not bounded');
    assert.ok(response.action !== undefined);
    await settle(control);
  });
});

describe('selection mode switch', () => {
  it('goes automatic: persists the mode and moves to the best engine', async () => {
    const { control, store } = setup({
      selection: { engine: 'strands-decider', model: 'strands-decider-2b' },
    });
    await settle(control);
    assert.equal(active(control), 'strands-decider');
    assert.equal(await control.setSelectionMode('auto'), 'auto');
    await settle(control);
    assert.deepEqual(store.current.selection, { mode: 'auto' });
    assert.equal(active(control), 'fastflowlm');
    const status = await control.status();
    assert.equal((status['active'] as { selectionMode: string }).selectionMode, 'auto');
  });

  it('goes manual: keeps the running engine, persists it and drops the fallback note', async () => {
    const { control, world, decide, store } = setup({ selection: { mode: 'auto' } });
    await settle(control);
    world.fail('fastflowlm');
    await decide();
    await settle(control);
    assert.ok(await fallbackOf(control));
    assert.equal(await control.setSelectionMode('manual'), 'manual');
    await settle(control);
    assert.equal(active(control), 'strands-decider');
    assert.equal(store.current.selection?.mode, undefined);
    assert.equal(store.current.selection?.engine, 'strands-decider');
    assert.equal(await fallbackOf(control), undefined);
    const status = await control.status();
    assert.equal((status['active'] as { selectionMode: string }).selectionMode, 'manual');
  });

  it('validates the requested mode', () => {
    assert.equal(parseSelectionMode({ mode: 'auto' }), 'auto');
    assert.equal(parseSelectionMode({ mode: 'manual' }), 'manual');
    for (const bad of [null, {}, { mode: 'x' }, { mode: 1 }, 'auto']) {
      assert.throws(() => parseSelectionMode(bad), /mode must be/);
    }
  });
});
