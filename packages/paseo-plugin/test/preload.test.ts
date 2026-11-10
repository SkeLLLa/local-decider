import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { preloadOnStart } from '../server/preload.ts';
import { deps, fakeGateway, settings } from './fakes.ts';

const signal = (): AbortSignal => new AbortController().signal;

describe('preloadOnStart', () => {
  it('does nothing when the setting is off (the default)', async () => {
    const gw = fakeGateway(() => null);
    assert.equal(await preloadOnStart(deps(settings(), gw), signal()), 'disabled');
    assert.equal(gw.calls.length, 0);
  });

  it('asks an unloaded gateway to load its engine once', async () => {
    const gw = fakeGateway(() => null);
    gw.health = async () => ({ status: 'ok', engineState: 'stopped' });
    const loads: string[] = [];
    gw.engineLoad = async (action) => {
      loads.push(action);
      return { ok: true, error: null, status: 202, body: {} };
    };
    assert.equal(
      await preloadOnStart(deps(settings({ preloadOnStart: true }), gw), signal()),
      'loaded',
    );
    assert.deepEqual(loads, ['load']);
  });

  it('leaves a loaded engine alone', async () => {
    const gw = fakeGateway(() => null);
    gw.health = async () => ({ status: 'ok', engineState: 'ready' });
    assert.equal(
      await preloadOnStart(deps(settings({ preloadOnStart: true }), gw), signal()),
      'already-loaded',
    );
  });

  it('waits for a gateway that starts later, then gives up quietly', async () => {
    const gw = fakeGateway(() => null);
    gw.health = async () => null;
    const d = deps(settings({ preloadOnStart: true }), gw);
    assert.equal(
      await preloadOnStart(d, signal(), { waitMs: 60, pollMs: 10 }),
      'gateway-unreachable',
    );
    assert.match(d.logs.at(-1) ?? '', /loads on the first decision/);
  });
});
