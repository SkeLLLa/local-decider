import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseConfig } from '../src/config.ts';
import type { HostInfo } from '../src/engines/descriptor.ts';
import { flmServeArgs, managedFlm } from '../src/engines/fastflowlm/server.ts';
import { modelFits } from '../src/models.ts';
import { checkPath, resolveAll, resolveEntry, toolchain } from '../src/toolchain.ts';
import { tempPaths } from './helpers.ts';

const DARWIN_HOST: HostInfo = {
  platform: 'darwin',
  arch: 'arm64',
  totalMemoryBytes: 64e9,
};

const LINUX_HOST: HostInfo = {
  platform: 'linux',
  arch: 'x64',
  totalMemoryBytes: 64e9,
};

function executable(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
  return path;
}

describe('toolchain discovery', () => {
  it('prefers config over the managed install over PATH', () => {
    const paths = tempPaths();
    const bin = join(paths.data, 'bin');
    const onPath = executable(join(bin, 'flm'));
    const env = { PATH: bin };
    const config = parseConfig({});
    assert.equal(resolveEntry('tools.flm', config, paths, env).source, 'path');
    const managed = executable(join(paths.engines, 'fastflowlm', '1.0.12', 'dist', 'flm'));
    executable(join(paths.engines, 'fastflowlm', '1.0.9', 'dist', 'flm'));
    assert.equal(managedFlm(paths), managed, 'newest version wins');
    assert.equal(resolveEntry('tools.flm', config, paths, env).effective, managed);
    const fromConfig = parseConfig({ tools: { flm: onPath } });
    const entry = resolveEntry('tools.flm', fromConfig, paths, env);
    assert.deepEqual([entry.source, entry.value], ['config', onPath]);
  });

  it('reports missing tools and sets model-store env only for overrides', () => {
    const paths = tempPaths();
    const entry = resolveEntry('tools.uv', parseConfig({}), paths, { PATH: '' });
    assert.deepEqual([entry.source, entry.ok], ['missing', false]);
    const auto = toolchain(parseConfig({}), paths, { PATH: '' });
    assert.deepEqual(auto.env, {});
    const custom = toolchain(
      parseConfig({ dirs: { flmModels: paths.data, hfCache: paths.logs } }),
      paths,
      { PATH: '' },
    );
    assert.deepEqual(custom.env, { FLM_MODEL_PATH: paths.data, HF_HUB_CACHE: paths.logs });
  });

  it('hides paths for engines unsupported on the host', () => {
    const paths = tempPaths();
    const config = parseConfig({});
    const darwinKeys = resolveAll(config, paths, { PATH: '' }, DARWIN_HOST).map(({ key }) => key);
    assert.deepEqual(darwinKeys, ['tools.strandsDecider', 'tools.uv', 'dirs.hfCache']);

    const linuxKeys = resolveAll(config, paths, { PATH: '' }, LINUX_HOST).map(({ key }) => key);
    assert.deepEqual(linuxKeys, [
      'tools.flm',
      'tools.strandsDecider',
      'tools.uv',
      'dirs.flmModels',
      'dirs.hfCache',
    ]);
  });

  it('only accepts absolute paths to the expected tool or an existing directory', () => {
    const paths = tempPaths();
    const flm = executable(join(paths.data, 'x', 'flm'));
    assert.equal(checkPath('tools.flm', flm), undefined);
    assert.match(checkPath('tools.flm', 'flm') ?? '', /absolute/);
    assert.match(checkPath('tools.flm', executable(join(paths.data, 'bash'))) ?? '', /named flm/);
    assert.match(checkPath('tools.uv', join(paths.data, 'uv')) ?? '', /not an executable/);
    assert.equal(checkPath('dirs.hfCache', paths.data), undefined);
    assert.match(checkPath('dirs.hfCache', join(paths.data, 'nope')) ?? '', /not a directory/);
  });
});

describe('model catalogue helpers', () => {
  it('knows model memory by device', () => {
    const e4b = 'StrandsAgents/strands-decider-E4B-gemma4-v1-2610';
    assert.equal(modelFits(e4b, 32e9, 'cpu'), false);
    assert.equal(modelFits(e4b, 32e9, 'mlx'), true);
    assert.equal(modelFits('unknown/model', 1, 'cpu'), true);
  });
});

describe('FastFlowLM serve args', () => {
  it('serves only the decision model on loopback', () => {
    const config = parseConfig({ engine: { type: 'fastflowlm', model: 'd3:mini' } }).engine;
    assert.ok(config.type === 'fastflowlm');
    assert.deepEqual(flmServeArgs(config, 9000), [
      'serve',
      '--decision',
      'd3:mini',
      '--host',
      '127.0.0.1',
      '--port',
      '9000',
      '--pmode',
      'performance',
    ]);
    assert.throws(
      () => parseConfig({ engine: { type: 'fastflowlm', model: '--evil' } }),
      /invalid config/,
    );
  });
});

describe('install links', () => {
  it('gives every entry a fixed https installUrl', () => {
    const entries = resolveAll(parseConfig({}), tempPaths(), { PATH: '' }, DARWIN_HOST);
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.match(entry.installUrl ?? '', /^https:\/\//, entry.key);
    }
    const uv = entries.find((e) => e.key === 'tools.uv');
    assert.equal(uv?.installUrl, 'https://docs.astral.sh/uv/getting-started/installation/');
  });
});
