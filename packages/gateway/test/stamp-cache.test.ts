import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STAMP_TTL_MS, StampCache } from '../src/stamp-cache.ts';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('StampCache', () => {
  it('returns immediately while a background hook is hanging, then caches its value', async () => {
    const wait = deferred<{ runtime: string; model: string }>();
    const cache = new StampCache(() => wait.promise);
    assert.equal(cache.get('llama-vulkan', 'd3-mini-q4_k_m'), undefined);
    wait.resolve({ runtime: 'b123', model: 'sha256:abc' });
    await cache.refreshNow(['llama-vulkan|d3-mini-q4_k_m'], 100);
    assert.deepEqual(cache.get('llama-vulkan', 'd3-mini-q4_k_m'), {
      runtime: 'b123',
      model: 'sha256:abc',
    });
  });

  it('bounds refreshNow and refreshes entries older than 60 seconds', async () => {
    let now = 0;
    let calls = 0;
    const cache = new StampCache(async () => {
      calls++;
      return { runtime: String(calls), model: null };
    }, () => now);
    await cache.refreshNow(['fastflowlm|d3:mini'], 100);
    assert.equal(cache.get('fastflowlm', 'd3:mini')?.runtime, '1');
    now += STAMP_TTL_MS - 1;
    assert.equal(cache.get('fastflowlm', 'd3:mini')?.runtime, '1');
    now += 1;
    assert.equal(cache.get('fastflowlm', 'd3:mini')?.runtime, '1');
    await cache.refreshNow(['fastflowlm|d3:mini'], 100);
    assert.equal(cache.get('fastflowlm', 'd3:mini')?.runtime, '2');

    const slow = new StampCache(() => new Promise(() => undefined));
    const started = Date.now();
    await slow.refreshNow(['slow|model'], 10);
    assert.ok(Date.now() - started < 500);
  });
});
