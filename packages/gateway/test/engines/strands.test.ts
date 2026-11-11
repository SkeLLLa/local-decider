import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { downloadSteps } from '../../src/downloads.ts';
import type { EngineContext, HostInfo } from '../../src/engines/descriptor.ts';
import { strandsEngine, hfCached } from '../../src/engines/strands/index.ts';
import { serveArgs } from '../../src/engines/strands/server.ts';
import { tempPaths } from '../helpers.ts';

function executable(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
  return path;
}

function context(data: string, binary?: string, hfCache?: string): EngineContext {
  return {
    paths: {
      data,
      config: join(data, 'config'),
      logs: join(data, 'logs'),
      venvs: join(data, 'venvs'),
      engines: join(data, 'engines'),
      run: join(data, 'run'),
    },
    tools: {
      flm: undefined,
      strandsDecider: binary,
      uv: undefined,
      env: hfCache === undefined ? {} : { HF_HUB_CACHE: hfCache },
    },
    host: { platform: 'linux', arch: 'x64', totalMemoryBytes: 64e9 },
    env: {},
  };
}

describe('strands descriptor', () => {
  it('detects Hugging Face cache snapshots and model presence', async () => {
    const paths = tempPaths();
    const model = strandsEngine.models[0];
    assert.ok(model);
    assert.ok(strandsEngine.modelsPresent !== undefined);
    const cache = join(paths.data, 'hf-cache');
    assert.equal(hfCached(cache, model.artifacts?.[0] ?? ''), false);
    assert.equal(
      (await strandsEngine.modelsPresent([model], context(paths.data, undefined, cache))).get(
        model.id,
      ),
      false,
    );
    for (const artifact of model.artifacts ?? []) {
      const snapshot = join(cache, `models--${artifact.replace('/', '--')}`, 'snapshots', 'abc');
      mkdirSync(snapshot, { recursive: true });
      writeFileSync(join(snapshot, 'config.json'), '{}');
    }
    assert.equal(hfCached(cache, model.artifacts?.[0] ?? ''), true);
    assert.equal(
      (await strandsEngine.modelsPresent([model], context(paths.data, undefined, cache))).get(
        model.id,
      ),
      true,
    );
  });

  it('builds fixed HF argv from the engine catalogue', () => {
    const paths = tempPaths();
    const binary = executable(join(paths.venvs, 'strands-decider', 'bin', 'strands-decider'));
    const hf = executable(join(paths.venvs, 'strands-decider', 'bin', 'hf'));
    const model = strandsEngine.models.find((entry) => entry.id.includes('2B-qwen3.5'));
    assert.ok(model);
    assert.deepEqual(downloadSteps(model, context(paths.data, binary)), [
      { command: hf, args: ['download', model.artifacts?.[0]] },
      { command: hf, args: ['download', model.artifacts?.[1]] },
    ]);
  });

  it('uses MLX for auto only on Darwin arm64 when the venv has mlx_lm', () => {
    const paths = tempPaths();
    const config = strandsEngine.configSchema.parse({ type: 'strands-decider' });
    const darwin: HostInfo = {
      platform: 'darwin',
      arch: 'arm64',
      totalMemoryBytes: 64e9,
    };
    const linux: HostInfo = {
      platform: 'linux',
      arch: 'x64',
      totalMemoryBytes: 64e9,
    };
    const mlxVenv = join(paths.venvs, 'with-mlx');
    const darwinBeforeInstall = serveArgs(config, 9000, darwin, mlxVenv);
    assert.ok(!darwinBeforeInstall.includes('--device'));

    mkdirSync(join(mlxVenv, 'lib', 'python3.13', 'site-packages', 'mlx_lm'), {
      recursive: true,
    });
    const mlxArgs = serveArgs(config, 9000, darwin, mlxVenv);
    assert.deepEqual(mlxArgs.slice(mlxArgs.indexOf('--device'), mlxArgs.indexOf('--device') + 2), [
      '--device',
      'mlx',
    ]);

    const linuxArgs = serveArgs(config, 9000, linux, mlxVenv);
    assert.ok(!linuxArgs.includes('--device'));
  });
});
