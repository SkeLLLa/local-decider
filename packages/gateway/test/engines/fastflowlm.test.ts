import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CatalogStatus } from '../../src/catalog-status.ts';
import { DownloadError, downloadSteps } from '../../src/downloads.ts';
import type { EngineContext } from '../../src/engines/descriptor.ts';
import { fastflowlmEngine } from '../../src/engines/fastflowlm/index.ts';
import {
  cachedFlmVersion,
  parseFlmList,
  summariseValidate,
} from '../../src/engines/fastflowlm/status.ts';
import { tempPaths } from '../helpers.ts';

function fakeFlm(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    `#!${process.execPath}
const command = process.argv[2];
if (command === 'list') console.log('Models:\\n  - d3:nano ✅\\n  - d3:edge ⏬');
if (command === 'version') console.log('FLM v1.0.12');
if (command === 'validate') console.log('[Linux] NPU platform: aie2p\\n[Linux] NPU: /dev/accel/accel0\\n[Linux] NPU FW Version: 1.1.2.64');
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function context(data: string, flm?: string): EngineContext {
  return {
    paths: {
      data,
      config: join(data, 'config'),
      logs: join(data, 'logs'),
      venvs: join(data, 'venvs'),
      engines: join(data, 'engines'),
      run: join(data, 'run'),
    },
    tools: { flm, strandsDecider: undefined, uv: undefined, env: {} },
    host: { platform: 'linux', arch: 'x64', totalMemoryBytes: 64e9 },
    env: {},
  };
}

describe('FastFlowLM descriptor', () => {
  it('parses downloaded tags and validation summaries', () => {
    const tags = parseFlmList('Models:\n  - d3:edge ⏬\n  - d3:lite ✅\n  - d3:nano ✅\n');
    assert.deepEqual([...tags], ['d3:lite', 'd3:nano']);
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

  it('keeps Linux FLM presence and validation behavior through an injected host', async () => {
    const paths = tempPaths();
    const flm = fakeFlm(join(paths.data, 'bin', 'flm'));
    const linux = context(paths.data, flm);
    assert.equal(linux.host.platform, 'linux');
    const status = new CatalogStatus(linux);
    const installed = await status.installed(fastflowlmEngine.models);
    assert.equal(installed.get('d3:nano'), true);
    assert.equal(installed.get('d3:edge'), false);
    assert.equal(cachedFlmVersion(flm), 'FLM v1.0.12');
    const model = fastflowlmEngine.models.find((entry) => entry.id === 'd3:nano');
    assert.ok(model);
    assert.deepEqual(downloadSteps(model, linux), [{ command: flm, args: ['pull', 'd3:nano'] }]);
    assert.equal(fastflowlmEngine.validation?.onStart, true);
    const result = await status.validate('fastflowlm');
    assert.equal(result.ok, true);
    assert.match(result.summary, /NPU platform: aie2p/);
  });

  it('returns absent models and failed validation when FLM is not installed', async () => {
    const paths = tempPaths();
    const status = new CatalogStatus(context(paths.data));
    const installed = await status.installed(fastflowlmEngine.models);
    assert.ok([...installed.values()].every((value) => !value));
    assert.equal((await status.validate('fastflowlm')).ok, false);
    const model = fastflowlmEngine.models.find((entry) => entry.id === 'd3:nano');
    assert.ok(model);
    assert.throws(
      () => downloadSteps(model, context(paths.data)),
      (error: unknown) => error instanceof DownloadError && error.status === 409,
    );
  });
});
