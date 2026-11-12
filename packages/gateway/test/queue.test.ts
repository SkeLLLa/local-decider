import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { QueueFullError, SerialQueue, type QueueLimits } from '../src/queue.ts';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const LIMITS: QueueLimits = { max: 4, highReserve: 2 };
const never = (): Promise<void> => new Promise<void>(() => undefined);

function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

describe('SerialQueue', () => {
  afterEach(() => {
    mock.timers.reset();
  });

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
    const rejected = assert.rejects(skipped);
    controller.abort();
    assert.equal(queue.depth, 1);
    await blocker;
    await rejected;
    assert.equal(ran, false);
  });

  it('drops an aborted waiter at once', async () => {
    const queue = new SerialQueue();
    const g = gate();
    const blocker = queue.run(new AbortController().signal, () => g.promise);
    const controller = new AbortController();
    let ran = false;
    const waiter = queue.run(controller.signal, async () => {
      ran = true;
    });
    const rejected = assert.rejects(waiter, { name: 'AbortError' });
    assert.equal(queue.depth, 2);
    controller.abort();
    assert.equal(queue.depth, 1);
    await rejected;
    g.open();
    await blocker;
    assert.equal(ran, false);
  });

  it('rejects an already-aborted signal without queueing', async () => {
    const queue = new SerialQueue();
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const refused = queue.run(controller.signal, async () => {
      ran = true;
    });
    const rejected = assert.rejects(refused, { name: 'AbortError' });
    assert.equal(queue.depth, 0);
    await rejected;
    assert.equal(ran, false);
    let started = false;
    const later = queue.run(new AbortController().signal, async () => {
      started = true;
    });
    assert.equal(started, true);
    await later;
  });

  it('normal jobs keep out of the high reserve; low and high fill the queue', async () => {
    const queue = new SerialQueue();
    const g = gate();
    const signal = new AbortController().signal;
    const held = (priority: 'low' | 'normal' | 'high'): Promise<void> =>
      queue.run(signal, () => g.promise, priority, LIMITS);
    const accepted = [held('low'), held('low')];
    assert.equal(queue.depth, 2);
    const normal = held('normal');
    const normalRefused = assert.rejects(normal, QueueFullError);
    accepted.push(held('low'), held('low'));
    assert.equal(queue.depth, 4);
    const lowE = held('low');
    const lowRefused = assert.rejects(lowE, QueueFullError);
    const normalM = held('normal');
    const normalMRefused = assert.rejects(normalM, QueueFullError);
    assert.equal(queue.depth, 4);
    await Promise.all([normalRefused, lowRefused, normalMRefused]);
    g.open();
    await Promise.all(accepted);
  });

  it('a high job at max evicts the oldest waiting low, never the running one', async () => {
    const queue = new SerialQueue();
    const signal = new AbortController().signal;
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof gate>>();
    const add = (name: string, priority: 'low' | 'high'): Promise<void> => {
      const g = gate();
      gates.set(name, g);
      return queue.run(
        signal,
        async () => {
          order.push(name);
          await g.promise;
        },
        priority,
        LIMITS,
      );
    };
    const a = add('A', 'low');
    const b = add('B', 'low');
    const c = add('C', 'low');
    const d = add('D', 'low');
    const refused = [
      assert.rejects(b, QueueFullError),
      assert.rejects(c, QueueFullError),
      assert.rejects(d, QueueFullError),
    ];
    assert.equal(queue.depth, 4);
    const h1 = add('H1', 'high');
    assert.equal(queue.depth, 4);
    const h2 = add('H2', 'high');
    const h3 = add('H3', 'high');
    const h4 = add('H4', 'high');
    const h4Refused = assert.rejects(h4, QueueFullError);
    await Promise.all([...refused, h4Refused]);
    assert.deepEqual(order, ['A']);
    for (const name of ['A', 'H1', 'H2', 'H3']) {
      gates.get(name)?.open();
      await flush();
    }
    await Promise.all([a, h1, h2, h3]);
    assert.deepEqual(order, ['A', 'H1', 'H2', 'H3']);
  });

  it('without limits nothing is refused', async () => {
    const queue = new SerialQueue();
    const signal = new AbortController().signal;
    const all = Array.from({ length: 20 }, () => queue.run(signal, async () => undefined));
    await Promise.all(all);
    assert.equal(queue.depth, 0);
  });

  it('releases the slot after the grace period when a job ignores its signal, warning once', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const warnings: string[] = [];
    const queue = new SerialQueue({ abandonGraceMs: 1000, warn: (m) => warnings.push(m) });
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    let started2 = false;
    let started3 = false;
    const j1 = queue.run(ctrl1.signal, never);
    const r1 = assert.rejects(j1, { name: 'AbortError' });
    const j2 = queue.run(ctrl2.signal, () => {
      started2 = true;
      return never();
    });
    const r2 = assert.rejects(j2, { name: 'AbortError' });
    const j3 = queue.run(new AbortController().signal, async () => {
      started3 = true;
    });
    ctrl1.abort();
    await flush();
    await r1;
    assert.equal(queue.depth, 3);
    assert.equal(started2, false);
    mock.timers.tick(999);
    await flush();
    assert.equal(started2, false);
    mock.timers.tick(1);
    await flush();
    assert.equal(started2, true);
    assert.equal(queue.depth, 2);
    ctrl2.abort();
    await flush();
    mock.timers.tick(1000);
    await flush();
    await r2;
    await j3;
    assert.equal(started3, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /past its deadline/);
  });

  it("a late-settling abandoned job does not free the next job's slot", async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const queue = new SerialQueue({ abandonGraceMs: 1000, warn: () => undefined });
    const g1 = gate();
    const g2 = gate();
    const ctrl1 = new AbortController();
    let started3 = false;
    const j1 = queue.run(ctrl1.signal, () => g1.promise);
    const r1 = assert.rejects(j1, { name: 'AbortError' });
    let started2 = false;
    const j2 = queue.run(new AbortController().signal, () => {
      started2 = true;
      return g2.promise;
    });
    const j3 = queue.run(new AbortController().signal, async () => {
      started3 = true;
    });
    ctrl1.abort();
    mock.timers.tick(1000);
    await flush();
    await r1;
    assert.equal(started2, true);
    assert.equal(queue.depth, 2);
    g1.open();
    await flush();
    assert.equal(queue.depth, 2);
    assert.equal(started3, false);
    g2.open();
    await flush();
    await Promise.all([j2, j3]);
    assert.equal(started3, true);
  });

  it('a job that honours abort frees the slot at once and warns nothing', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const warnings: string[] = [];
    const queue = new SerialQueue({ abandonGraceMs: 1000, warn: (m) => warnings.push(m) });
    const ctrl1 = new AbortController();
    const j1 = queue.run(
      ctrl1.signal,
      () =>
        new Promise<void>((_resolve, reject) => {
          ctrl1.signal.addEventListener('abort', () => {
            reject(new Error('stopped'));
          });
        }),
    );
    const r1 = assert.rejects(j1, { name: 'AbortError' });
    let started2 = false;
    const j2 = queue.run(new AbortController().signal, async () => {
      started2 = true;
    });
    ctrl1.abort();
    await flush();
    await r1;
    assert.equal(started2, true);
    await j2;
    mock.timers.tick(1000);
    assert.equal(warnings.length, 0);
  });

  it('a job that throws synchronously rejects and frees the slot', async () => {
    const queue = new SerialQueue();
    const signal = new AbortController().signal;
    const bad = queue.run(signal, () => {
      throw new Error('sync');
    });
    const rejected = assert.rejects(bad, /sync/);
    let ran = false;
    const next = queue.run(signal, async () => {
      ran = true;
    });
    await rejected;
    await next;
    await flush();
    assert.equal(ran, true);
    assert.equal(queue.depth, 0);
  });
});
