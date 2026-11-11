import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RemoteEngineConfig } from '../src/config.ts';
import { DEVICES, type HostInfo } from '../src/engines/descriptor.ts';
import {
  engineDefaults,
  engineDescriptor,
  ENGINES,
  isSelectableEngine,
  SELECTABLE_IDS,
} from '../src/engines/registry.ts';

const linuxHost: HostInfo = {
  platform: 'linux',
  arch: 'x64',
  totalMemoryBytes: 16 * 1024 ** 3,
};

describe('engine registry', () => {
  it('has unique ids and selectable engines in the existing order', () => {
    const ids = ENGINES.map((engine) => engine.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(SELECTABLE_IDS, ['strands-decider', 'fastflowlm']);
    assert.equal(engineDescriptor('fastflowlm')?.id, 'fastflowlm');
    assert.equal(engineDescriptor('missing'), undefined);
    assert.ok(isSelectableEngine('strands-decider'));
    assert.ok(!isSelectableEngine('systemone-remote'));
  });

  it('parses default model configs for every engine', () => {
    for (const engine of ENGINES) {
      // The remote engine has no default URL; supply its required attach target.
      const config =
        engine.id === 'systemone-remote'
          ? engineDefaults(engine.id, undefined, { url: 'http://127.0.0.1:8765' })
          : engineDefaults(engine.id);
      assert.equal(config.type, engine.id);
      assert.ok(config.model.length > 0, `${engine.id} has a default model`);
    }
  });

  it('re-exports the remote config shape from config.ts', () => {
    const config: RemoteEngineConfig = {
      type: 'systemone-remote',
      url: 'http://127.0.0.1:8765',
      model: 'remote',
    };
    assert.equal(config.type, 'systemone-remote');
  });

  it('keeps the current device list available on Linux', () => {
    for (const engine of ENGINES.filter((candidate) => candidate.selectable)) {
      assert.deepEqual(engine.devices?.(linuxHost), DEVICES, engine.id);
      assert.deepEqual(engine.supports(linuxHost), { ok: true }, engine.id);
    }
  });
});
