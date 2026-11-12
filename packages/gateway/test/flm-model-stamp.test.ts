import assert from 'node:assert/strict';
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
    const modelFile = join(modelDir, 'model.q4nx');
    writeFileSync(modelFile, 'weights');
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
    const original = flmModelStamp(model, ctx);
    assert.equal(original, `7:${String(statSync(modelFile).mtimeMs)}`);
    writeFileSync(modelFile, 'changed weights');
    const changedSize = flmModelStamp(model, ctx);
    assert.notEqual(changedSize, original);
    writeFileSync(modelFile, 'changed weigher');
    const stat = statSync(modelFile);
    utimesSync(modelFile, new Date(), new Date(stat.mtimeMs + 2000));
    assert.notEqual(flmModelStamp(model, ctx), changedSize);
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
