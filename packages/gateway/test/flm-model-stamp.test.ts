import assert from 'node:assert/strict';
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  futimesSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { EngineContext } from '../src/engines/descriptor.ts';
import { flmModelStamp } from '../src/engines/fastflowlm/model-stamp.ts';
import { catalogModel } from '../src/models.ts';
import { tempPaths } from './helpers.ts';

describe('FastFlowLM model stamp', () => {
  it('uses the resolved model directory and detects size and mtime changes', () => {
    const paths = tempPaths();
    const root = join(paths.data, 'flm-models');
    const modelDir = join(root, 'D3-Lite-NPU2');
    mkdirSync(modelDir, { recursive: true });
    // One descriptor for every write and stat, so each check sees the file it then changes.
    const fd = openSync(join(modelDir, 'model.q4nx'), 'w+');
    writeSync(fd, 'weights');
    const model = catalogModel('d3:lite', 'fastflowlm');
    assert.ok(model);
    const ctx = {
      paths,
      env: {},
      host: { platform: 'linux', arch: 'x64', totalMemoryBytes: 1 },
      tools: {
        flm: undefined,
        llamaServer: undefined,
        strandsDecider: undefined,
        uv: undefined,
        env: { FLM_MODEL_PATH: root },
      },
    } as EngineContext;
    try {
      const original = flmModelStamp(model, ctx);
      assert.equal(original, `7:${String(fstatSync(fd).mtimeMs)}`);
      ftruncateSync(fd, 0);
      writeSync(fd, 'changed weights', 0);
      const changedSize = flmModelStamp(model, ctx);
      assert.notEqual(changedSize, original);
      writeSync(fd, 'changed weigher', 0);
      futimesSync(fd, new Date(), new Date(fstatSync(fd).mtimeMs + 2000));
      assert.notEqual(flmModelStamp(model, ctx), changedSize);
    } finally {
      closeSync(fd);
    }
  });

  it('returns null when model files are absent', () => {
    const paths = tempPaths();
    const model = catalogModel('d3:lite', 'fastflowlm');
    assert.ok(model);
    const root = join(paths.data, 'empty-models');
    assert.equal(
      flmModelStamp(model, {
        paths,
        env: {},
        host: { platform: 'linux', arch: 'x64', totalMemoryBytes: 1 },
        tools: {
          flm: undefined,
          llamaServer: undefined,
          strandsDecider: undefined,
          uv: undefined,
          env: { FLM_MODEL_PATH: root },
        },
      }),
      null,
    );
  });
});
