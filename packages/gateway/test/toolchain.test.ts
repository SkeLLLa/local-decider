import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { hfCached, parseFlmList, summariseValidate } from '../src/catalog-status.ts';
import { parseConfig } from '../src/config.ts';
import { downloadSteps, lastPercent } from '../src/downloads.ts';
import { flmServeArgs, managedFlm } from '../src/engines/fastflowlm/server.ts';
import { catalogModel, modelFits } from '../src/models.ts';
import { checkPath, resolveEntry, toolchain } from '../src/toolchain.ts';
import { tempPaths } from './helpers.ts';

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

describe('catalogue status helpers', () => {
  it('parses `flm list`', () => {
    const tags = parseFlmList('Models:\n  - d3:edge ⏬\n  - d3:lite ✅\n  - d3:nano ✅\n');
    assert.deepEqual([...tags], ['d3:lite', 'd3:nano']);
  });

  it('summarises `flm validate`', () => {
    const lines = [
      '[Linux]  NPU: /dev/accel/accel0 with 8 columns',
      '[Linux]  NPU FW Version: 1.1.2.64',
      '[Linux]  NPU platform: aie2p',
    ];
    assert.equal(
      summariseValidate(lines),
      'NPU platform: aie2p · NPU: /dev/accel/accel0 with 8 columns · NPU FW Version: 1.1.2.64',
    );
  });

  it('detects Hugging Face cache snapshots', () => {
    const { data } = tempPaths();
    assert.equal(hfCached(data, 'Org/model'), false);
    mkdirSync(join(data, 'models--Org--model', 'snapshots', 'abc'), { recursive: true });
    assert.equal(hfCached(data, 'Org/model'), false);
    writeFileSync(join(data, 'models--Org--model', 'snapshots', 'abc', 'config.json'), '{}');
    assert.equal(hfCached(data, 'Org/model'), true);
  });

  it('knows model memory by device', () => {
    const e4b = 'StrandsAgents/strands-decider-E4B-gemma4-v1-2610';
    assert.equal(modelFits(e4b, 32e9, 'cpu'), false);
    assert.equal(modelFits(e4b, 32e9, 'mlx'), true);
    assert.equal(modelFits('unknown/model', 1, 'cpu'), true);
  });
});

describe('downloads', () => {
  it('builds fixed argv from the catalogue', () => {
    const paths = tempPaths();
    const flm = executable(join(paths.data, 'flm'));
    const strands = executable(join(paths.venvs, 'sd', 'bin', 'strands-decider'));
    const hf = executable(join(paths.venvs, 'sd', 'bin', 'hf'));
    const tools = { flm, strandsDecider: strands, uv: undefined, env: {} };
    const d3 = catalogModel('d3:mini');
    const sd = catalogModel('StrandsAgents/strands-decider-2B-qwen3.5-v1-2610');
    assert.ok(d3 !== undefined && sd !== undefined);
    assert.deepEqual(downloadSteps(d3, tools), [[flm, ['pull', 'd3:mini']]]);
    assert.deepEqual(downloadSteps(sd, tools), [
      [hf, ['download', 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610']],
      [hf, ['download', 'Qwen/Qwen3.5-2B-Base']],
    ]);
    assert.throws(() => downloadSteps(d3, { ...tools, flm: undefined }), /not installed/);
  });

  it('reads the last percentage of tool output', () => {
    assert.equal(lastPercent('Downloading 12% ... 47.5%'), 0.475);
    assert.equal(lastPercent('no progress here'), null);
    assert.equal(lastPercent('999%'), null);
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
