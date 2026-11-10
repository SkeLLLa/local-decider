import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { ManagedEngine } from '../src/engines/lazy.ts';
import { SerialQueue } from '../src/queue.ts';
import { FakeEngine } from './helpers.ts';

const REQ = { state: 's', questions: { q: { type: 'noul' as const, instructions: 'i' } } };

/** Starts after `delayMs`, like a real model load. */
class SlowStart extends FakeEngine {
  starts = 0;
  readonly delayMs: number;
  constructor(delayMs: number) {
    super();
    this.delayMs = delayMs;
    this.state = 'stopped';
    this.respond = () => ({ answers: { q: { type: 'noul', noul: 0.9 } } });
  }
  override async start(): Promise<void> {
    this.starts += 1;
    this.state = 'starting';
    await sleep(this.delayMs);
    this.state = 'ready';
  }
}

describe('ManagedEngine', () => {
  it('lazy: does not load at start, loads on the first decision and waits for it', async () => {
    const inner = new SlowStart(50);
    const engine = new ManagedEngine(inner, { lifecycle: 'lazy', idleUnloadMinutes: 15 });
    await engine.start();
    assert.equal(inner.starts, 0);
    assert.equal(engine.health().onDemand, true);
    assert.match(engine.health().detail ?? '', /loads on the next decision/);
    const res = await engine.decide(REQ, AbortSignal.timeout(2000));
    assert.equal(res.answers['q']?.type, 'noul');
    assert.equal(inner.starts, 1);
    assert.ok(engine.lastUsedAt !== null);
    await engine.stop();
  });

  it('lazy: a decision gives up when its own signal fires during the load', async () => {
    const engine = new ManagedEngine(new SlowStart(500), {
      lifecycle: 'lazy',
      idleUnloadMinutes: 15,
    });
    await assert.rejects(engine.decide(REQ, AbortSignal.timeout(50)), /timeout|aborted/i);
    await engine.stop();
  });

  it('eager: loads at start and reports a stopped engine as down, not on demand', async () => {
    const inner = new SlowStart(10);
    const engine = new ManagedEngine(inner, { lifecycle: 'eager', idleUnloadMinutes: 15 });
    await engine.start();
    assert.equal(inner.starts, 1);
    await engine.unload();
    assert.equal(engine.health().onDemand, undefined);
  });

  it('unloads on request and reloads on the next decision', async () => {
    const inner = new SlowStart(10);
    const engine = new ManagedEngine(inner, { lifecycle: 'lazy', idleUnloadMinutes: 15 });
    await engine.load();
    await engine.unload('idle');
    assert.match(engine.health().detail ?? '', /unloaded after 15 min idle/);
    await engine.decide(REQ, AbortSignal.timeout(2000));
    assert.equal(inner.starts, 2);
    await engine.stop();
  });

  it('fails fast when the engine cannot load', async () => {
    const inner = new FakeEngine();
    inner.state = 'stopped';
    inner.start = async (): Promise<void> => {
      inner.state = 'failed';
    };
    const engine = new ManagedEngine(inner, { lifecycle: 'lazy', idleUnloadMinutes: 15 });
    await assert.rejects(engine.decide(REQ, AbortSignal.timeout(2000)), /engine failed/);
  });
});

describe('SerialQueue priorities', () => {
  it('runs one job at a time, high before low, FIFO within a priority', async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    const job =
      (name: string, ms = 10) =>
      async (): Promise<void> => {
        order.push(name);
        await sleep(ms);
      };
    const signal = new AbortController().signal;
    const all = [
      queue.run(signal, job('first', 30), 'low'),
      queue.run(signal, job('low-1'), 'low'),
      queue.run(signal, job('low-2'), 'low'),
      queue.run(signal, job('high-1'), 'high'),
      queue.run(signal, job('normal'), 'normal'),
      queue.run(signal, job('high-2'), 'high'),
    ];
    assert.equal(queue.depth, 6);
    await Promise.all(all);
    assert.deepEqual(order, ['first', 'high-1', 'high-2', 'normal', 'low-1', 'low-2']);
    assert.equal(queue.depth, 0);
  });

  it('skips a job whose signal fired while it waited', async () => {
    const queue = new SerialQueue();
    const controller = new AbortController();
    const blocker = queue.run(new AbortController().signal, () => sleep(30));
    let ran = false;
    const skipped = queue.run(controller.signal, async () => {
      ran = true;
    });
    controller.abort();
    await blocker;
    await assert.rejects(skipped);
    assert.equal(ran, false);
  });
});
