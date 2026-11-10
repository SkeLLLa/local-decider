import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { engineLoad, setLifecycle } from '../server/engines.ts';
import { engineStateNote, idleMinutesError, lifecycleLabel } from '../shared/lifecycle.ts';
import { deps, fakeGateway, settings } from './fakes.ts';

const base = { detail: null, model: 'd3:nano', engineTag: 'NPU' };

describe('engine state note', () => {
  it('says plainly what the engine is doing', () => {
    assert.equal(engineStateNote({ ...base, state: 'ready' }), 'Loaded · d3:nano · NPU');
    assert.equal(
      engineStateNote({ ...base, state: 'stopped', lifecycle: 'lazy' }),
      'Unloaded · loads automatically on the next decision',
    );
    assert.match(engineStateNote({ ...base, state: 'stopped', lifecycle: 'eager' }), /Load now/);
    assert.equal(engineStateNote({ ...base, state: 'starting' }), 'Loading…');
    assert.equal(
      engineStateNote({ ...base, state: 'failed', detail: 'NPU busy' }),
      'Failed: NPU busy',
    );
    assert.equal(engineStateNote(undefined), 'Engine state unknown');
    assert.equal(engineStateNote({ ...base, state: 'warming' }), 'warming');
    assert.equal(
      engineStateNote({ state: 'ready', detail: null, model: null, engineTag: null }),
      'Loaded',
    );
  });
});

describe('idle minutes input', () => {
  it('accepts whole minutes from 1 to 1440', () => {
    for (const ok of ['1', '15', ' 1440 ']) {
      assert.equal(idleMinutesError(ok), null, ok);
    }
    for (const bad of ['0', '1441', '1.5', '-3', '', 'ten']) {
      assert.notEqual(idleMinutesError(bad), null, bad);
    }
  });

  it('labels the lifecycle choices', () => {
    assert.equal(lifecycleLabel('lazy', 30), 'Automatic: load on demand, unload after 30 min idle');
    assert.match(lifecycleLabel('lazy', null), /15 min/);
    assert.equal(lifecycleLabel('eager', 30), 'Always loaded');
  });
});

describe('load and lifecycle RPCs', () => {
  it('forwards load, unload and lifecycle', async () => {
    const gw = fakeGateway(() => null);
    const d = deps(settings(), gw);
    await engineLoad(d, 'load');
    await engineLoad(d, 'unload');
    await setLifecycle(d, { lifecycle: 'lazy', idleUnloadMinutes: 30 });
    await setLifecycle(d, { lifecycle: 'eager' });
    assert.deepEqual(gw.posts, [
      { name: 'engineLoad', input: 'load' },
      { name: 'engineLoad', input: 'unload' },
      { name: 'setLifecycle', input: { lifecycle: 'lazy', idleUnloadMinutes: 30 } },
      { name: 'setLifecycle', input: { lifecycle: 'eager' } },
    ]);
  });
});
